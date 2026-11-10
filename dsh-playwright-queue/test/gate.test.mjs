// Worktree gate: a lease holder may only drive the browser while the API server on the configured port runs from its worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createQueue } from '../lib/queue.js';
import { createProxy } from '../lib/proxy.js';
import { listenerMatchesWorktree, createServerGate } from '../lib/server-gate.js';
import { tmpDir } from '../fixtures/mcp-client.mjs';

const WT_A = path.resolve('/pwq-gate/wt-a');
const WT_B = path.resolve('/pwq-gate/wt-b');

test('listenerMatchesWorktree: matches paths in command lines and cwd, with path boundaries', () => {
  const entry = (commandLine, cwd) => ({ pid: 1, commandLine, cwd });
  assert.equal(listenerMatchesWorktree([entry(`node ${WT_A}${path.sep}api${path.sep}index.ts`)], WT_A), true);
  assert.equal(listenerMatchesWorktree([entry(`node ${WT_A.replaceAll('\\', '/')}/api/index.ts`)], WT_A), true);
  assert.equal(listenerMatchesWorktree([entry('node api/index.ts', WT_A)], WT_A), true);
  assert.equal(listenerMatchesWorktree([entry(`node "${WT_A}\\api\\index.ts"`)], WT_A), true);
  assert.equal(listenerMatchesWorktree([entry(`node ${WT_A}x${path.sep}api${path.sep}index.ts`)], WT_A), false, 'prefix of a longer name');
  assert.equal(listenerMatchesWorktree([entry(`node ${WT_B}${path.sep}api`)], WT_A), false);
  assert.equal(listenerMatchesWorktree([], WT_A), false);
  // the main checkout must not match a server started from a worktree nested inside it
  const nested = `${WT_A}${path.sep}.claude${path.sep}worktrees${path.sep}t1${path.sep}api${path.sep}index.ts`;
  assert.equal(listenerMatchesWorktree([entry(`node ${nested}`)], WT_A), false);
  assert.equal(listenerMatchesWorktree([entry(`node ${nested}`)], path.join(WT_A, '.claude', 'worktrees', 't1')), true);
});

test('createServerGate: no listener, unknown listener, other worktree, match', async () => {
  let info;
  const gate = createServerGate({ port: 3030, listenerInfo: async () => info });
  info = { listening: false, entries: [] };
  let r = await gate.check(WT_A);
  assert.equal(r.ok, false);
  assert.match(r.message, /no server is listening on port 3030/i);
  info = null;
  r = await gate.check(WT_A);
  assert.equal(r.ok, false);
  assert.match(r.message, /could not determine/i);
  info = { listening: true, entries: [{ pid: 7, commandLine: `node ${WT_B}${path.sep}api${path.sep}index.ts` }] };
  r = await gate.check(WT_A);
  assert.equal(r.ok, false);
  assert.match(r.message, /not running from/i);
  assert.ok(r.message.includes(WT_A));
  info = { listening: true, entries: [{ pid: 7, commandLine: `node ${WT_A}${path.sep}api${path.sep}index.ts` }] };
  assert.deepEqual(await gate.check(WT_A), { ok: true });
});

test('createServerGate validates the port and a throwing listenerInfo is a refusal', async () => {
  assert.throws(() => createServerGate({ port: 0 }), RangeError);
  assert.throws(() => createServerGate({ port: 'x' }), TypeError);
  const gate = createServerGate({ port: 3030, listenerInfo: async () => { throw new Error('boom'); } });
  const r = await gate.check(WT_A);
  assert.equal(r.ok, false);
  assert.match(r.message, /boom/);
});

// ---- proxy integration ----
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
async function withGatedProxy(fn, { serverGate, gateCacheMs } = {}) {
  const dir = tmpDir();
  const queue = createQueue({ dir });
  const child = stubChild();
  const proxy = createProxy({ queue, child, pollIntervalMs: 20, waitBudgetMs: 100, log: () => {}, serverGate, gateCacheMs });
  try { await fn({ proxy, child, queue }); } finally { proxy.shutdown?.(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const call = (proxy, name, args, id = 1) => proxy.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const body = (r) => JSON.parse(r.result.content[0].text);
const okGate = () => { const seen = []; return { seen, check: async (wt) => { seen.push(wt); return { ok: true }; } }; };

test('gate on: queue_acquire needs an absolute worktree', () =>
  withGatedProxy(async ({ proxy, queue }) => {
    let r = await call(proxy, 'queue_acquire', { label: 'a' });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /worktree is required/);
    r = await call(proxy, 'queue_acquire', { label: 'a', worktree: 'relative/dir' });
    assert.equal(r.result.isError, true);
    r = await call(proxy, 'queue_acquire', { label: 'a', worktree: 5 });
    assert.equal(r.result.isError, true);
    assert.equal(queue.snapshot().lease, null, 'a refused call must not enqueue');
    r = await call(proxy, 'queue_acquire', { label: 'a', worktree: WT_A });
    assert.equal(body(r).status, 'granted');
  }, { serverGate: okGate() }));

test('gate on: tools/list advertises the worktree argument', () =>
  withGatedProxy(async ({ proxy }) => {
    const r = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const acquire = r.result.tools.find((t) => t.name === 'queue_acquire');
    assert.ok(acquire.inputSchema.properties.worktree);
    assert.match(acquire.description, /worktree/i);
  }, { serverGate: okGate() }));

test('gate off: no worktree needed and tools/list has no worktree argument', () =>
  withGatedProxy(async ({ proxy }) => {
    const r = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(r.result.tools.find((t) => t.name === 'queue_acquire').inputSchema.properties.worktree, undefined);
    assert.equal(body(await call(proxy, 'queue_acquire', {})).status, 'granted');
  }));

test('gate on: a refused check blocks the browser call and the child is not called', () =>
  withGatedProxy(async ({ proxy, child }) => {
    const { token } = body(await call(proxy, 'queue_acquire', { worktree: WT_A }));
    child.calls.length = 0; // ignore the grant-time cleanup
    const r = await call(proxy, 'browser_navigate', { queueToken: token, url: 'about:blank' });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /api server is not running from/i);
    assert.equal(child.calls.length, 0);
  }, { serverGate: { check: async (wt) => ({ ok: false, message: `API server is not running from ${wt}.` }) } }));

test('gate on: a passing check forwards and is cached per token', () => {
  const gate = okGate();
  return withGatedProxy(async ({ proxy, child }) => {
    const { token } = body(await call(proxy, 'queue_acquire', { worktree: WT_A }));
    child.calls.length = 0;
    await call(proxy, 'browser_navigate', { queueToken: token, url: 'a' });
    await call(proxy, 'browser_navigate', { queueToken: token, url: 'b' });
    assert.deepEqual(child.calls.map((c) => c.args.url), ['a', 'b']);
    assert.deepEqual(gate.seen, [WT_A], 'checked once, cached');
  }, { serverGate: gate, gateCacheMs: 60000 });
});

test('gate on: with a zero cache every call is checked again (a server swapped mid-lease is caught)', () => {
  let ok = true;
  const gate = { check: async () => (ok ? { ok: true } : { ok: false, message: 'server changed' }) };
  return withGatedProxy(async ({ proxy }) => {
    const { token } = body(await call(proxy, 'queue_acquire', { worktree: WT_A }));
    assert.equal((await call(proxy, 'browser_navigate', { queueToken: token })).result.isError, undefined);
    ok = false;
    const r = await call(proxy, 'browser_navigate', { queueToken: token });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /server changed/);
  }, { serverGate: gate, gateCacheMs: 0 });
});

test('gate on: a waiting ticket remembers its worktree when polled without one', () => {
  const gate = okGate();
  return withGatedProxy(async ({ proxy, queue }) => {
    const a = body(await call(proxy, 'queue_acquire', { label: 'a', worktree: WT_A }));
    const w = body(await call(proxy, 'queue_acquire', { label: 'b', worktree: WT_B }));
    assert.equal(w.status, 'waiting');
    await call(proxy, 'queue_release', { queueToken: a.token });
    const b = body(await call(proxy, 'queue_acquire', { label: 'b', ticket: w.ticket }));
    assert.equal(b.status, 'granted');
    await call(proxy, 'browser_navigate', { queueToken: b.token });
    assert.deepEqual(gate.seen, [WT_B]);
    assert.ok(queue.validate(b.token));
  }, { serverGate: gate });
});

test('gate on: a released token is refused before the gate is consulted', () => {
  const gate = okGate();
  return withGatedProxy(async ({ proxy }) => {
    const { token } = body(await call(proxy, 'queue_acquire', { worktree: WT_A }));
    await call(proxy, 'queue_release', { queueToken: token });
    const r = await call(proxy, 'browser_navigate', { queueToken: token });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /expired or was released/);
    assert.deepEqual(gate.seen, []);
  }, { serverGate: gate });
});
