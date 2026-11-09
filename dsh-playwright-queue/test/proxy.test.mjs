// Unit tests for lib/jsonrpc.js and lib/proxy.js (helpers, child client, proxy logic).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLineReader, encode, parseLine, ERR } from '../lib/jsonrpc.js';
import { resolveSpawn, createChildClient, parseTabIndices, republishTools, createProxy } from '../lib/proxy.js';
import { createQueue } from '../lib/queue.js';
import { FAKE, tmpDir, readLog, isAlive, waitFor } from '../fixtures/mcp-client.mjs';

test('line reader frames chunks, handles CRLF, skips blanks, caps line length', () => {
  const lines = [];
  const r = createLineReader((l) => lines.push(l), { maxLineBytes: 50 });
  r.push('{"a":1}\n{"b"');
  r.push(':2}\r\n\n\n{"c":3}');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  r.end();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
  const overflow = [];
  const r2 = createLineReader((l) => overflow.push(l), { maxLineBytes: 10 });
  r2.push('x'.repeat(30)); // no newline, over the cap: dropped, not buffered forever
  r2.push('\nok\n');
  assert.deepEqual(overflow, ['ok']);
});

test('line reader: while dropping, newline-less chunks are discarded, overflow fires once, resumes after newline', () => {
  const lines = [];
  let overflows = 0;
  const r = createLineReader((l) => lines.push(l), { maxLineBytes: 10, onOverflow: () => { overflows++; } });
  r.push('x'.repeat(30));
  for (let i = 0; i < 5; i++) r.push('y'.repeat(30));
  assert.equal(overflows, 1);
  r.end(); // still dropping: nothing emitted
  assert.deepEqual(lines, []);
  const r2 = createLineReader((l) => lines.push(l), { maxLineBytes: 10, onOverflow: () => { overflows++; } });
  r2.push('x'.repeat(30));
  r2.push('zzz');
  r2.push('tail\nok1\nok2');
  assert.deepEqual(lines, ['ok1']);
  r2.end();
  assert.deepEqual(lines, ['ok1', 'ok2']);
  assert.equal(overflows, 2);
});

test('child client: oversized child line rejects the in-flight request immediately, child stays usable', () =>
  withChild({ env: { FAKE_MCP_HUGE_BYTES: '5000' }, timeoutMs: 20000, maxLineBytes: 1000 }, async (child) => {
    await child.getTools();
    const t0 = Date.now();
    await assert.rejects(child.callTool('huge', {}), /child result too large \(over 1000 bytes\)/);
    assert.ok(Date.now() - t0 < 5000, 'failed fast, not after the child timeout');
    const r = await child.callTool('browser_navigate', { url: 'after' });
    assert.match(r.content[0].text, /after/);
  }));

test('encode is one line; parseLine reports parse errors and invalid requests', () => {
  assert.equal(encode({ a: 'x\ny' }), '{"a":"x\\ny"}\n');
  assert.deepEqual(parseLine('{"jsonrpc":"2.0","id":1,"method":"ping"}'), { msg: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.equal(parseLine('{oops').error.error.code, ERR.PARSE);
  assert.equal(parseLine('42').error.error.code, ERR.INVALID_REQUEST);
  assert.equal(parseLine('[1]').error.error.code, ERR.INVALID_REQUEST);
  assert.equal(ERR.METHOD_NOT_FOUND, -32601);
  assert.equal(ERR.INVALID_PARAMS, -32602);
});

test('resolveSpawn: direct on posix, cmd.exe wrapper for .cmd on win32, metacharacters rejected', () => {
  assert.deepEqual(resolveSpawn('npx', ['-y', 'pkg'], 'linux'), { command: 'npx', args: ['-y', 'pkg'] });
  assert.deepEqual(resolveSpawn('node.exe', ['a.js'], 'win32'), { command: 'node.exe', args: ['a.js'] });
  const w = resolveSpawn('npx.cmd', ['-y', '@playwright/mcp@latest'], 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
  assert.equal(w.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(w.args, ['/d', '/s', '/c', 'npx.cmd', '-y', '@playwright/mcp@latest']);
  for (const bad of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', '%PATH%', 'a"b', 'a b', 'a\nb', 'a!b']) {
    assert.throws(() => resolveSpawn('npx.cmd', [bad], 'win32'), /unsafe/i, bad);
  }
  assert.doesNotThrow(() => resolveSpawn('npx', ['a&b'], 'linux')); // no shell, so no restriction
});

test('parseTabIndices tolerates formats and returns [] on garbage', () => {
  const t = '### Open tabs\n- 0: [A] (u)\n- 1: (current) [B] (u)\n  - 2: [C]';
  assert.deepEqual(parseTabIndices(t), [{ index: 0, current: false }, { index: 1, current: true }, { index: 2, current: false }]);
  assert.deepEqual(parseTabIndices('nothing here'), []);
  assert.deepEqual(parseTabIndices(undefined), []);
});

test('republishTools adds optional queueToken without mutating or requiring it', () => {
  const tools = [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, annotations: { x: 1 } }, { name: 'u' }];
  const snapshot = structuredClone(tools);
  const out = republishTools(tools);
  assert.deepEqual(tools, snapshot);
  assert.equal(out[0].inputSchema.properties.queueToken.type, 'string');
  assert.deepEqual(out[0].inputSchema.required, ['a']);
  assert.deepEqual(out[0].annotations, { x: 1 });
  assert.match(out[0].description, /^d/);
  assert.match(out[0].description, /queueToken/);
  assert.equal(out[1].inputSchema.type, 'object');
  assert.equal(out[1].inputSchema.required, undefined);
  assert.notEqual(out[0].inputSchema.properties, tools[0].inputSchema.properties);
});

function withChild(opts, fn) {
  return (async () => {
    const dir = tmpDir();
    const log = `${dir}-c.log`;
    const prev = { ...process.env };
    process.env.FAKE_MCP_LOG = log;
    Object.assign(process.env, opts.env ?? {});
    const child = createChildClient({ command: process.execPath, args: [FAKE], timeoutMs: opts.timeoutMs ?? 5000, maxLineBytes: opts.maxLineBytes, log: () => {} });
    try {
      await fn(child, log);
    } finally {
      child.close();
      for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
      Object.assign(process.env, prev);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(log, { force: true });
    }
  })();
}

test('child client: lazy spawn, handshake, cached tools, call, restart after crash', () =>
  withChild({ env: { FAKE_MCP_CRASH_ON: 'browser_snapshot' } }, async (child, log) => {
    assert.equal(child.isRunning(), false);
    assert.equal(readLog(log).length, 0); // nothing spawned yet
    const tools = await child.getTools();
    assert.ok(tools.some((t) => t.name === 'browser_navigate'));
    assert.equal(child.isRunning(), true);
    assert.deepEqual(readLog(log).map((e) => e.method), ['initialize', 'notifications/initialized', 'tools/list']);
    assert.equal(await child.getTools(), tools); // cached, same object
    const r = await child.callTool('browser_navigate', { url: 'u' });
    assert.match(r.content[0].text, /"url":"u"/);
    await assert.rejects(child.callTool('browser_snapshot', {}), /exit/i);
    assert.equal(child.isRunning(), false);
    const r2 = await child.callTool('browser_navigate', { url: 'again' });
    assert.match(r2.content[0].text, /again/);
    assert.equal(new Set(readLog(log).map((e) => e.pid)).size, 2);
  }));

test('child client: per-request timeout rejects and keeps the client usable', () =>
  withChild({ env: { FAKE_MCP_SLOW_MS: '600' } }, async (child) => {
    await child.getTools();
    await assert.rejects(child.callTool('slow', {}, 100), /timed out/i);
    const r = await child.callTool('browser_navigate', { url: 'x' });
    assert.ok(r.content);
  }));

test('child client: spawn failure rejects and a later call can retry', async () => {
  const child = createChildClient({ command: 'definitely-not-a-real-command-xyz', args: [], timeoutMs: 2000, log: () => {} });
  try {
    await assert.rejects(child.getTools());
    await assert.rejects(child.getTools());
  } finally {
    child.close();
  }
});

test('child client: close kills the child process', () =>
  withChild({}, async (child, log) => {
    await child.getTools();
    const pid = readLog(log)[0].pid;
    child.close();
    assert.ok(await waitFor(() => !isAlive(pid), 5000));
  }));

// ---- proxy with a stub child and a real queue ----
function stubChild(tools = [{ name: 'browser_navigate', inputSchema: { type: 'object', properties: {} } }]) {
  const calls = [];
  return {
    calls,
    isRunning: () => true,
    getTools: async () => tools,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    close() {},
  };
}

async function withProxy(fn, opts = {}) {
  const dir = tmpDir();
  const queue = createQueue({ dir, idleMs: opts.idleMs });
  const child = opts.child ?? stubChild();
  const proxy = createProxy({ queue, child, pollIntervalMs: 20, waitBudgetMs: 100, log: () => {}, ...opts.proxy });
  try {
    await fn({ proxy, child, queue });
  } finally {
    proxy.shutdown?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const call = (proxy, name, args, id = 1) => proxy.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

test('proxy: notifications get no response; bad params are -32602; holder labels never leak', () =>
  withProxy(async ({ proxy, queue }) => {
    assert.equal(await proxy.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
    const bad = await proxy.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} });
    assert.equal(bad.error.code, -32602);
    assert.equal(bad.id, 5);
    const r = await call(proxy, 'queue_acquire', { label: 'x'.repeat(200) });
    assert.equal(JSON.parse(r.result.content[0].text).status, 'granted');
    const snap = queue.snapshot();
    assert.ok(snap.lease.holder.length <= 80 + 1 + 32); // label capped at 80 + '#' + random id
    assert.match(snap.lease.holder, /#[0-9a-f]{16,}$/);
  }));

test('proxy: label sanitised and random per attempt, queue_acquire rejects non-string args', () =>
  withProxy(async ({ proxy, queue }) => {
    const r1 = await call(proxy, 'queue_acquire', { label: 'a\nb' });
    const b1 = JSON.parse(r1.result.content[0].text);
    assert.ok(!queue.snapshot().lease.holder.includes('\n'));
    const r2 = await call(proxy, 'queue_acquire', { label: 'same' });
    const w = JSON.parse(r2.result.content[0].text);
    assert.equal(w.status, 'waiting');
    const r3 = await call(proxy, 'queue_acquire', { label: 'same' });
    const w2 = JSON.parse(r3.result.content[0].text);
    assert.notEqual(w.ticket, w2.ticket); // distinct holder per attempt
    assert.equal(w2.position, 2);
    const bad = await call(proxy, 'queue_acquire', { label: 5 });
    assert.equal(bad.result.isError, true);
    const bad2 = await call(proxy, 'queue_acquire', { ticket: {} });
    assert.equal(bad2.result.isError, true);
    assert.ok(b1.token);
  }));

test('proxy: tools/list survives a failing child (queue tools only)', () =>
  withProxy(
    async ({ proxy }) => {
      const r = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.deepEqual(r.result.tools.map((t) => t.name), ['queue_acquire', 'queue_release', 'queue_status']);
    },
    { child: { isRunning: () => false, getTools: async () => { throw new Error('spawn failed'); }, callTool: async () => { throw new Error('x'); }, close() {} } },
  ));

test('proxy: a child JSON-RPC error is passed through, transport errors become isError', () =>
  withProxy(
    async ({ proxy }) => {
      const { token } = JSON.parse((await call(proxy, 'queue_acquire', {})).result.content[0].text);
      const r = await call(proxy, 'browser_navigate', { queueToken: token });
      assert.deepEqual(r.error, { code: -32602, message: 'bad', data: { d: 1 } });
      const r2 = await call(proxy, 'browser_snapshot', { queueToken: token });
      assert.equal(r2.result.isError, true);
      assert.ok(!JSON.stringify(r2).includes(token));
    },
    {
      child: {
        isRunning: () => false,
        getTools: async () => [{ name: 'browser_navigate' }, { name: 'browser_snapshot' }],
        callTool: async (name) => {
          if (name === 'browser_navigate') throw Object.assign(new Error('rpc'), { rpc: { code: -32602, message: 'bad', data: { d: 1 } } });
          throw new Error('Playwright child exited');
        },
        close() {},
      },
    },
  ));

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const parseRes = (r) => JSON.parse(r.result.content[0].text);

test('proxy: release waits for an in-flight cleanup call (bounded) before freeing the lease', () => {
  let active = 0;
  const child = {
    isRunning: () => true,
    getTools: async () => [{ name: 'browser_navigate' }],
    callTool: async () => {
      active++;
      await sleepMs(300);
      active--;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    close() {},
  };
  return withProxy(
    async ({ proxy, queue }) => {
      const { token } = parseRes(await call(proxy, 'queue_acquire', {}));
      assert.equal(active, 0, 'grant-time cleanup also waits for the in-flight call');
      // a new navigate is in flight when release starts; the lease must not be freed under it
      const rel = await call(proxy, 'queue_release', { queueToken: token });
      assert.equal(parseRes(rel).status, 'released');
      assert.equal(active, 0, 'no cleanup call still running after release');
      assert.equal(queue.snapshot().lease, null);
    },
    { child, proxy: { cleanupTimeoutMs: 150, cleanupGraceMs: 400 } },
  );
});

test('proxy: stale pending tickets are pruned on the next queue_acquire', () =>
  withProxy(
    async ({ proxy, queue }) => {
      await call(proxy, 'queue_acquire', { label: 'holder' });
      const w = parseRes(await call(proxy, 'queue_acquire', { label: 'stale' }));
      assert.equal(w.status, 'waiting');
      assert.equal(queue.snapshot().waiters.length, 1);
      await sleepMs(120);
      const w2 = parseRes(await call(proxy, 'queue_acquire', { label: 'fresh' }));
      assert.equal(w2.status, 'waiting');
      const waiters = queue.snapshot().waiters;
      assert.equal(waiters.length, 1, 'the stale ticket was cancelled');
      assert.equal(w2.position, 1);
    },
    { proxy: { pendingTtlMs: 60 } },
  ));

test('proxy: notifications/cancelled stops an in-flight queue_acquire and cancels its ticket', () =>
  withProxy(
    async ({ proxy, queue }) => {
      await call(proxy, 'queue_acquire', { label: 'holder' }, 1);
      const waiting = call(proxy, 'queue_acquire', { label: 'victim' }, 2);
      await sleepMs(40);
      assert.equal(queue.snapshot().waiters.length, 1);
      assert.equal(await proxy.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }), undefined);
      const res = await waiting;
      assert.equal(res.result.isError, true);
      assert.equal(queue.snapshot().waiters.length, 0);
    },
    { proxy: { waitBudgetMs: 5000 } },
  ));

test('proxy: non-object arguments for a forwarded call are refused without calling the child', () =>
  withProxy(async ({ proxy, child }) => {
    const r = await call(proxy, 'browser_navigate', 'nope');
    assert.equal(r.result.isError, true);
    assert.deepEqual(child.calls, []);
  }));

test('line reader: large line in many small chunks, split lines, several lines per chunk', () => {
  const lines = [];
  const r = createLineReader((l) => lines.push(l));
  const big = 'x'.repeat(2 * 1024 * 1024);
  const t0 = Date.now();
  for (let i = 0; i < big.length; i += 16) r.push(big.slice(i, i + 16));
  r.push('\n');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, big.length);
  assert.ok(Date.now() - t0 < 3000, 'no quadratic rescanning');
  lines.length = 0;
  r.push('{"a"'); r.push(':1}'); r.push('\n{"b":2}\n');
  r.push('{"c":3}\n{"d":4}\n{"e"');
  r.push(':5}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}', '{"e":5}']);
});

test('proxy: initialize echoes supported client versions, else answers with the latest', () =>
  withProxy(async ({ proxy }) => {
    const init = (v) => proxy.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: v === undefined ? {} : { protocolVersion: v } });
    assert.equal((await init('2024-11-05')).result.protocolVersion, '2024-11-05');
    assert.equal((await init('2025-03-26')).result.protocolVersion, '2025-03-26');
    assert.equal((await init('2025-06-18')).result.protocolVersion, '2025-06-18');
    assert.equal((await init('2099-01-01')).result.protocolVersion, '2025-06-18');
    assert.equal((await init(undefined)).result.protocolVersion, '2025-06-18');
  }));

test('proxy: a cancel during the grant cleanup releases the just-granted lease', () => {
  const child = {
    isRunning: () => true,
    getTools: async () => [{ name: 'browser_navigate' }],
    callTool: async () => { await sleepMs(200); return { content: [{ type: 'text', text: 'ok' }] }; },
    close() {},
  };
  return withProxy(
    async ({ proxy, queue }) => {
      const pending = call(proxy, 'queue_acquire', {}, 7);
      await sleepMs(60); // granted, cleanup in progress
      assert.ok(queue.snapshot().lease, 'lease granted');
      await proxy.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
      const res = await pending;
      assert.equal(res.result.isError, true);
      assert.equal(queue.snapshot().lease, null, 'lease not orphaned');
    },
    { child, proxy: { cleanupTimeoutMs: 1000, cleanupGraceMs: 100 } },
  );
});

test('proxy: held is pruned for idle-expired leases (acquire and refused forward)', async () => {
  const dir = tmpDir();
  try {
    const real = createQueue({ dir, idleMs: 50 });
    const released = [];
    const queue = new Proxy(real, { get: (t, k) => (k === 'release' ? (tok) => { released.push(tok); return t.release(tok); } : t[k].bind(t)) });
    const proxy = createProxy({ queue, child: stubChild(), pollIntervalMs: 20, waitBudgetMs: 100, log: () => {} });
    const a = parseRes(await call(proxy, 'queue_acquire', {}));
    await sleepMs(120); // idle-expired
    const r = await call(proxy, 'browser_navigate', { queueToken: a.token });
    assert.match(r.result.content[0].text, /not valid/);
    released.length = 0;
    proxy.shutdown();
    assert.ok(!released.includes(a.token), 'expired token pruned from held');
    // acquire path
    const b = parseRes(await call(proxy, 'queue_acquire', {}));
    await sleepMs(120);
    const c = parseRes(await call(proxy, 'queue_acquire', {}));
    assert.equal(c.status, 'granted');
    released.length = 0;
    proxy.shutdown();
    assert.ok(!released.includes(b.token), 'expired token pruned on acquire');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- security-review follow-ups ----
const TABS_TEXT = { content: [{ type: 'text', text: '- 0: (current) a\n- 1: b' }] };

test('proxy: graceful shutdown cancels still-waiting tickets', () =>
  withProxy(async ({ proxy, queue }) => {
    await call(proxy, 'queue_acquire', { label: 'holder' });
    const w = parseRes(await call(proxy, 'queue_acquire', { label: 'waiter' }));
    assert.equal(w.status, 'waiting');
    assert.equal(queue.snapshot().waiters.length, 1);
    proxy.shutdown();
    assert.equal(queue.snapshot().waiters.length, 0, 'waiting ticket was cancelled');
  }));

test('proxy: release cleanup stops when the lease is lost mid-cleanup', () => {
  const calls = [];
  let queueRef; let tokenRef; let armed = false;
  const child = {
    isRunning: () => true,
    getTools: async () => [{ name: 'browser_tabs' }, { name: 'browser_navigate' }],
    callTool: async (name, a) => {
      calls.push({ name, a });
      if (armed) { armed = false; queueRef.release(tokenRef); } // lease lost during the first cleanup call
      return name === 'browser_tabs' ? TABS_TEXT : { content: [{ type: 'text', text: 'ok' }] };
    },
    close() {},
  };
  return withProxy(
    async ({ proxy, queue }) => {
      queueRef = queue;
      const { token } = parseRes(await call(proxy, 'queue_acquire', {}));
      tokenRef = token;
      calls.length = 0;
      armed = true;
      await call(proxy, 'queue_release', { queueToken: token });
      assert.deepEqual(calls.map((c) => c.name), ['browser_tabs'], 'no further cleanup calls after the lease was lost');
    },
    { child },
  );
});

test('proxy: grant-time cleanup stops when the lease is lost mid-cleanup', () => {
  const calls = [];
  let queueRef; let tok;
  const child = {
    isRunning: () => true,
    getTools: async () => [{ name: 'browser_tabs' }, { name: 'browser_navigate' }],
    callTool: async (name) => {
      calls.push(name);
      if (calls.length === 1) queueRef.release(tok); // lease lost during the first cleanup call
      return name === 'browser_tabs' ? TABS_TEXT : { content: [{ type: 'text', text: 'ok' }] };
    },
    close() {},
  };
  return withProxy(
    async ({ proxy, queue }) => {
      queueRef = queue;
      const origPoll = queue.poll;
      queue.poll = (t) => { const r = origPoll(t); if (r.token) tok = r.token; return r; };
      await call(proxy, 'queue_acquire', {});
      assert.deepEqual(calls, ['browser_tabs']);
    },
    { child },
  );
});

test('proxy: forward re-checks the lease after the child (re)starts and refuses without calling it', () => {
  let queueRef; let tokenRef; let armed = false; let called = 0;
  const child = {
    isRunning: () => true,
    getTools: async () => {
      if (armed) { armed = false; queueRef.release(tokenRef); } // lease released while the child was starting
      return [{ name: 'browser_navigate' }];
    },
    callTool: async () => { called++; return { content: [{ type: 'text', text: 'ok' }] }; },
    close() {},
  };
  return withProxy(
    async ({ proxy, queue }) => {
      queueRef = queue;
      const { token } = parseRes(await call(proxy, 'queue_acquire', {}));
      tokenRef = token;
      called = 0; // ignore the grant-time cleanup call
      armed = true;
      const r = await call(proxy, 'browser_navigate', { queueToken: token });
      assert.equal(r.result.isError, true);
      assert.match(r.result.content[0].text, /expired or was released/);
      assert.equal(called, 0);
    },
    { child },
  );
});

test('jsonrpc: default max line is 16 MiB', async () => {
  const { DEFAULT_MAX_LINE_BYTES } = await import('../lib/jsonrpc.js');
  assert.equal(DEFAULT_MAX_LINE_BYTES, 16 * 1024 * 1024);
});

test('defaultChildCommand pins an exact @playwright/mcp version (no @latest)', async () => {
  const { defaultChildCommand } = await import('../lib/proxy.js');
  for (const p of ['win32', 'linux']) {
    const spec = defaultChildCommand(p);
    assert.equal(spec.args[0], '-y');
    assert.match(spec.args[1], /^@playwright\/mcp@\d+\.\d+\.\d+$/);
  }
});
