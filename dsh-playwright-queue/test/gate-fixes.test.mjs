// Review fixes for the worktree gate: no leaks in refusals, root rejection, cwd trust, dedup, caches, env parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createQueue } from '../lib/queue.js';
import { createProxy } from '../lib/proxy.js';
import { listenerMatchesWorktree, createServerGate } from '../lib/server-gate.js';
import { tmpDir, FAKE, SERVER } from '../fixtures/mcp-client.mjs';

const WT_A = path.resolve('/pwq-gate/wt-a');
const WT_B = path.resolve('/pwq-gate/wt-b');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('match: a known cwd is trusted over the command line (a mentioned path alone does not pass)', () => {
  const e = { pid: 1, cwd: WT_B, commandLine: `node server.js --config ${WT_A}${path.sep}x.json` };
  assert.equal(listenerMatchesWorktree([e], WT_A), false);
  assert.equal(listenerMatchesWorktree([{ ...e, cwd: WT_A }], WT_A), true);
});

test('match: a command line path with .. segments never matches', () => {
  const cmd = (p) => ({ pid: 1, commandLine: `node ${p}` });
  assert.equal(listenerMatchesWorktree([cmd(`${WT_A}${path.sep}..${path.sep}other${path.sep}srv.js`)], WT_A), false);
  assert.equal(listenerMatchesWorktree([cmd(`${WT_A}${path.sep}api${path.sep}srv.js`)], WT_A), true);
});

test('match: win32 comparison ignores case, slashes and a trailing backslash', () => {
  assert.equal(listenerMatchesWorktree([{ pid: 1, cwd: 'D:\\Dev\\WT\\' }], 'd:/dev/wt', 'win32'), true);
  assert.equal(listenerMatchesWorktree([{ pid: 1, cwd: 'D:\\Dev\\WT\\api' }], 'd:/dev/wt', 'win32'), true);
  assert.equal(listenerMatchesWorktree([{ pid: 1, cwd: 'D:\\Dev\\WTX' }], 'd:/dev/wt', 'win32'), false);
});

test('gate: a refusal names pid and executable only, never the cwd or command line', async () => {
  const gate = createServerGate({
    port: 3030,
    listenerInfo: async () => ({
      listening: true,
      entries: [{ pid: 4242, commandLine: 'C:\\tools\\node.exe --token=SECRET123 C:\\secretdir\\srv.js', cwd: 'C:\\secretdir' }],
    }),
  });
  const r = await gate.check(WT_A);
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('4242'));
  assert.ok(r.message.includes('node.exe'));
  assert.ok(!r.message.includes('SECRET123'));
  assert.ok(!r.message.includes('secretdir'));
});

test('gate: a command line match is found without reading the cwd; the cwd is read only when needed', async () => {
  const calls = [];
  const info = (cmd, cwd) => async (port, opts) => {
    calls.push(Boolean(opts?.withCwd));
    return { listening: true, entries: [{ pid: 1, commandLine: cmd, cwd: opts?.withCwd ? cwd : undefined }] };
  };
  let gate = createServerGate({ port: 3030, listenerInfo: info(`node ${WT_A}${path.sep}api${path.sep}index.ts`, null) });
  assert.deepEqual(await gate.check(WT_A), { ok: true });
  assert.deepEqual(calls, [false]);
  calls.length = 0;
  gate = createServerGate({ port: 3030, listenerInfo: info('node api/index.ts', WT_A) });
  assert.deepEqual(await gate.check(WT_A), { ok: true });
  assert.deepEqual(calls, [false, true]);
});

test('gate: concurrent checks share one lookup', async () => {
  let n = 0;
  const gate = createServerGate({
    port: 3030,
    listenerInfo: async () => { n++; await sleep(30); return { listening: true, entries: [{ pid: 1, commandLine: `node ${WT_A}${path.sep}x.js` }] }; },
  });
  const rs = await Promise.all([gate.check(WT_A), gate.check(WT_A), gate.check(WT_A)]);
  assert.ok(rs.every((r) => r.ok));
  assert.equal(n, 1);
});

// ---- proxy ----
function stubChild() {
  const calls = [];
  return {
    calls,
    isRunning: () => true,
    getTools: async () => [{ name: 'browser_navigate', inputSchema: { type: 'object', properties: {} } }],
    callTool: async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: 'ok' }] }; },
    close() {},
  };
}
async function withGated(fn, opts = {}) {
  const dir = tmpDir();
  const queue = createQueue({ dir });
  const child = stubChild();
  const proxy = createProxy({ queue, child, pollIntervalMs: 20, waitBudgetMs: 100, log: () => {}, ...opts });
  try { await fn({ proxy, child, queue }); } finally { proxy.shutdown?.(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const call = (proxy, name, args, id = 1) => proxy.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const body = (r) => JSON.parse(r.result.content[0].text);
const okGate = () => { const seen = []; return { seen, check: async (wt) => { seen.push(wt); return { ok: true }; } }; };

test('proxy gate: a drive root or a custom validator rejection is refused before enqueueing', () =>
  withGated(async ({ proxy, queue }) => {
    const root = path.parse(process.cwd()).root;
    let r = await call(proxy, 'queue_acquire', { worktree: root });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /root/i);
    r = await call(proxy, 'queue_acquire', { worktree: WT_A });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /no \.git/);
    assert.equal(queue.snapshot().lease, null);
  }, { serverGate: okGate(), validateWorktree: (wt) => (wt === WT_A ? 'no .git here' : null) }));

test('proxy gate: a drive-relative path is refused on win32', { skip: process.platform !== 'win32' }, () =>
  withGated(async ({ proxy }) => {
    const r = await call(proxy, 'queue_acquire', { worktree: '\\just\\rooted' });
    assert.equal(r.result.isError, true);
  }, { serverGate: okGate() }));

test('proxy gate: re-polling a ticket with another worktree is an error and keeps the ticket', () =>
  withGated(async ({ proxy }) => {
    await call(proxy, 'queue_acquire', { label: 'a', worktree: WT_A });
    const w = body(await call(proxy, 'queue_acquire', { label: 'b', worktree: WT_B }));
    assert.equal(w.status, 'waiting');
    const r = await call(proxy, 'queue_acquire', { ticket: w.ticket, worktree: WT_A });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /enqueued for/);
    const again = body(await call(proxy, 'queue_acquire', { ticket: w.ticket }));
    assert.equal(again.status, 'waiting');
  }, { serverGate: okGate() }));

test('proxy gate: an unknown ticket without a worktree gets the unknown-ticket advice', () =>
  withGated(async ({ proxy }) => {
    const r = await call(proxy, 'queue_acquire', { ticket: 'nope' });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /Unknown or expired ticket/);
  }, { serverGate: okGate() }));

test('proxy gate: a lease granted without a worktree on record is refused for browser calls', () =>
  withGated(async ({ proxy, queue, child }) => {
    const { ticket } = queue.enqueue({ holder: 'foreign#abc', pid: process.pid });
    const g = body(await call(proxy, 'queue_acquire', { ticket }));
    assert.equal(g.status, 'granted');
    child.calls.length = 0;
    const r = await call(proxy, 'browser_navigate', { queueToken: g.token });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /no worktree on record/);
    assert.equal(child.calls.length, 0);
  }, { serverGate: okGate() }));

test('proxy gate: concurrent browser calls share one check', () => {
  let n = 0;
  const gate = { check: async () => { n++; await sleep(40); return { ok: true }; } };
  return withGated(async ({ proxy, child }) => {
    const { token } = body(await call(proxy, 'queue_acquire', { worktree: WT_A }));
    child.calls.length = 0;
    await Promise.all([1, 2, 3].map((i) => call(proxy, 'browser_navigate', { queueToken: token, url: String(i) }, i + 10)));
    assert.equal(n, 1);
    assert.equal(child.calls.length, 3);
  }, { serverGate: gate, gateCacheMs: 0 });
});

test('proxy gate: a failed check is cached briefly, and a retry after the cache succeeds', () => {
  let ok = false; let n = 0;
  const gate = { check: async () => { n++; return ok ? { ok: true } : { ok: false, message: 'wrong server' }; } };
  return withGated(async ({ proxy }) => {
    const { token } = body(await call(proxy, 'queue_acquire', { worktree: WT_A }));
    let r = await call(proxy, 'browser_navigate', { queueToken: token });
    assert.match(r.result.content[0].text, /wrong server/);
    r = await call(proxy, 'browser_navigate', { queueToken: token });
    assert.match(r.result.content[0].text, /wrong server/);
    assert.equal(n, 1, 'second refusal came from the failure cache');
    ok = true;
    await sleep(80);
    r = await call(proxy, 'browser_navigate', { queueToken: token });
    assert.equal(r.result.isError, undefined);
    assert.equal(n, 2);
  }, { serverGate: gate, gateCacheMs: 0, gateFailCacheMs: 50 });
});

test('proxy gate: a pass is rechecked after the cache expires', () => {
  const gate = okGate();
  return withGated(async ({ proxy }) => {
    const { token } = body(await call(proxy, 'queue_acquire', { worktree: WT_A }));
    await call(proxy, 'browser_navigate', { queueToken: token });
    await sleep(60);
    await call(proxy, 'browser_navigate', { queueToken: token });
    assert.equal(gate.seen.length, 2);
  }, { serverGate: gate, gateCacheMs: 30 });
});

test('proxy gate: a throwing gate is a refusal, not a crash', () =>
  withGated(async ({ proxy, child }) => {
    const { token } = body(await call(proxy, 'queue_acquire', { worktree: WT_A }));
    child.calls.length = 0;
    const r = await call(proxy, 'browser_navigate', { queueToken: token });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /kaput/);
    assert.equal(child.calls.length, 0);
  }, { serverGate: { check: async () => { throw new Error('kaput'); } } }));

// ---- server.js env parsing ----
test('server: invalid DSH_PWQ_SERVER_PORT or DSH_PWQ_GATE_CACHE_MS fails startup; valid values start', () => {
  const dir = tmpDir();
  try {
    const run = (env) => spawnSync(process.execPath, [SERVER, '--', process.execPath, FAKE], {
      env: { ...process.env, DSH_PWQ_DIR: dir, ...env }, input: '', encoding: 'utf8', timeout: 15000,
    });
    for (const port of ['abc', '0', '70000', '1.5', '0x1F90', '3e3']) {
      const r = run({ DSH_PWQ_SERVER_PORT: port });
      assert.equal(r.status, 1, `port ${port}`);
      assert.match(r.stderr, /DSH_PWQ_SERVER_PORT/);
    }
    for (const ms of ['abc', '-5']) {
      const r = run({ DSH_PWQ_SERVER_PORT: '38999', DSH_PWQ_GATE_CACHE_MS: ms });
      assert.equal(r.status, 1, `cache ${ms}`);
      assert.match(r.stderr, /DSH_PWQ_GATE_CACHE_MS/);
    }
    assert.equal(run({ DSH_PWQ_SERVER_PORT: '38999', DSH_PWQ_GATE_CACHE_MS: '0' }).status, 0);
    assert.equal(run({ DSH_PWQ_SERVER_PORT: '38999' }).status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseNetstatListeners: picks LISTENING pids of the exact port, ignores other states and ports', async () => {
  const { parseNetstatListeners } = await import('../lib/server-gate.js');
  const text = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3030           0.0.0.0:0              LISTENING       4100',
    '  TCP    [::]:3030              [::]:0                 LISTENING       4100',
    '  TCP    127.0.0.1:30300        0.0.0.0:0              LISTENING       999',
    '  TCP    127.0.0.1:3030         127.0.0.1:50000        ESTABLISHED     4100',
    '  TCP    0.0.0.0:13030          0.0.0.0:0              LISTENING       777',
    '  TCP    0.0.0.0:3030           0.0.0.0:0              LISTENING       5200',
  ].join('\r\n');
  assert.deepEqual(parseNetstatListeners(text, 3030), [4100, 5200]);
  assert.deepEqual(parseNetstatListeners(text, 1), []);
  assert.deepEqual(parseNetstatListeners('', 3030), []);
});
