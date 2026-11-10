// Per-session opt-out of the worktree gate: queue_acquire { skipServerCheck: true } for checks with no API server under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createQueue } from '../lib/queue.js';
import { createProxy } from '../lib/proxy.js';
import { tmpDir } from '../fixtures/mcp-client.mjs';

const WT_A = path.resolve('/pwq-gate/wt-a');

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
const refusingGate = () => { const seen = []; return { seen, check: async (wt) => { seen.push(wt); return { ok: false, message: 'wrong server' }; } }; };

test('skip: no worktree needed, browser calls are forwarded and the gate is never consulted', () => {
  const gate = refusingGate();
  return withGated(async ({ proxy, child }) => {
    const { token } = body(await call(proxy, 'queue_acquire', { label: 'overlay', skipServerCheck: true }));
    assert.ok(token);
    child.calls.length = 0;
    const r = await call(proxy, 'browser_navigate', { queueToken: token, url: 'http://x' });
    assert.equal(r.result.isError, undefined);
    assert.equal(child.calls.length, 1);
    assert.deepEqual(gate.seen, []);
  }, { serverGate: gate });
});

test('skip: without the flag the same gate still refuses', () =>
  withGated(async ({ proxy, child }) => {
    const { token } = body(await call(proxy, 'queue_acquire', { worktree: WT_A }));
    child.calls.length = 0;
    const r = await call(proxy, 'browser_navigate', { queueToken: token });
    assert.equal(r.result.isError, true);
    assert.equal(child.calls.length, 0);
  }, { serverGate: refusingGate() }));

test('skip: a non-boolean flag is refused before enqueueing', () =>
  withGated(async ({ proxy, queue }) => {
    for (const bad of ['true', 1, {}]) {
      const r = await call(proxy, 'queue_acquire', { skipServerCheck: bad });
      assert.equal(r.result.isError, true);
      assert.match(r.result.content[0].text, /skipServerCheck must be a boolean/);
    }
    assert.equal(queue.snapshot().lease, null);
  }, { serverGate: refusingGate() }));

test('skip: skipServerCheck false behaves as absent (worktree required)', () =>
  withGated(async ({ proxy }) => {
    const r = await call(proxy, 'queue_acquire', { skipServerCheck: false });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /worktree is required/);
  }, { serverGate: refusingGate() }));

test('skip: a waiting ticket remembers the opt-out when re-polled without the flag', () =>
  withGated(async ({ proxy, child }) => {
    const a = body(await call(proxy, 'queue_acquire', { label: 'a', skipServerCheck: true }));
    const w = body(await call(proxy, 'queue_acquire', { label: 'b', skipServerCheck: true }));
    assert.equal(w.status, 'waiting');
    await call(proxy, 'queue_release', { queueToken: a.token });
    const b = body(await call(proxy, 'queue_acquire', { ticket: w.ticket }));
    assert.equal(b.status, 'granted');
    child.calls.length = 0;
    const r = await call(proxy, 'browser_navigate', { queueToken: b.token });
    assert.equal(r.result.isError, undefined);
  }, { serverGate: refusingGate() }));

test('skip: re-polling a ticket with the other mode is an error and keeps the ticket', () =>
  withGated(async ({ proxy }) => {
    await call(proxy, 'queue_acquire', { label: 'a', skipServerCheck: true });
    const w = body(await call(proxy, 'queue_acquire', { label: 'b', worktree: WT_A }));
    assert.equal(w.status, 'waiting');
    let r = await call(proxy, 'queue_acquire', { ticket: w.ticket, skipServerCheck: true });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /enqueued/);
    const w2 = body(await call(proxy, 'queue_acquire', { label: 'c', skipServerCheck: true }));
    r = await call(proxy, 'queue_acquire', { ticket: w2.ticket, worktree: WT_A });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /enqueued/);
    assert.equal(body(await call(proxy, 'queue_acquire', { ticket: w.ticket })).status, 'waiting');
  }, { serverGate: refusingGate(), validateWorktree: () => null }));

test('skip: tools/list advertises skipServerCheck as a boolean and the description names it', () =>
  withGated(async ({ proxy }) => {
    const r = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const acquire = r.result.tools.find((t) => t.name === 'queue_acquire');
    assert.equal(acquire.inputSchema.properties.skipServerCheck.type, 'boolean');
    assert.match(acquire.description, /skipServerCheck/);
  }, { serverGate: refusingGate() }));

test('skip: gate off ignores the flag and advertises nothing', () =>
  withGated(async ({ proxy }) => {
    const r = await proxy.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(r.result.tools.find((t) => t.name === 'queue_acquire').inputSchema.properties.skipServerCheck, undefined);
    assert.equal(body(await call(proxy, 'queue_acquire', { skipServerCheck: true })).status, 'granted');
  }));
