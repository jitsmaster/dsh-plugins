// End-to-end tests: real server.js processes in front of fixtures/fake-mcp.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client, FAKE, tmpDir, readLog, toolCalls, isAlive, waitFor } from '../fixtures/mcp-client.mjs';

// Runs fn(ctx) with a temp dir + log; kills every client and removes the dir afterwards.
async function withEnv(fn, { env = {} } = {}) {
  const dir = tmpDir();
  const log = `${dir}-fake.log`;
  const clients = [];
  const make = (extra = {}) => {
    const c = new Client({ dir, env: { FAKE_MCP_LOG: log, ...env, ...extra.env }, args: extra.args });
    clients.push(c);
    return c;
  };
  try {
    await fn({ dir, log, make });
  } finally {
    for (const c of clients) c.kill();
    await Promise.all(clients.map((c) => c.exited));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(log, { force: true });
  }
}

test('initialize echoes protocol version, ping, unknown method, tools/list handshake', () =>
  withEnv(async ({ make }) => {
    const c = make();
    const init = await c.init();
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, 'dsh-playwright-queue');
    assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);
    assert.deepEqual((await c.request('ping')).result, {});
    assert.equal((await c.request('nope/nothing')).error.code, -32601);
    const list = await c.request('tools/list');
    const names = list.result.tools.map((t) => t.name);
    for (const n of ['queue_acquire', 'queue_release', 'queue_status', 'browser_navigate', 'browser_tabs', 'browser_snapshot']) {
      assert.ok(names.includes(n), n);
    }
    const nav = list.result.tools.find((t) => t.name === 'browser_navigate');
    assert.equal(nav.inputSchema.properties.queueToken.type, 'string');
    assert.deepEqual(nav.inputSchema.required, ['url']); // queueToken is not required
    assert.equal(nav.inputSchema.additionalProperties, false);
    assert.match(nav.description, /queueToken/);
    assert.match(nav.description, /^Navigate to a URL/);
  }));

test('malformed JSON gets -32700 and does not crash; later requests still work', () =>
  withEnv(async ({ make }) => {
    const c = make();
    const bad = new Promise((r) => c.pending.set(null, r));
    c.writeRaw('{not json');
    assert.equal((await bad).error.code, -32700);
    c.writeRaw('42');
    c.writeRaw('');
    assert.deepEqual((await c.request('ping')).result, {});
    assert.equal(c.proc.exitCode, null);
  }));

test('call without a token is refused and the child is never called', () =>
  withEnv(async ({ make, log }) => {
    const c = make();
    await c.init();
    const r = await c.call('browser_navigate', { url: 'http://x' });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /queue_acquire/);
    const r2 = await c.call('browser_navigate', { url: 'http://x', queueToken: 'bogus' });
    assert.equal(r2.isError, true);
    assert.match(r2.content[0].text, /expired or was released/);
    assert.deepEqual(toolCalls(log), []);
  }));

test('acquire, forwarded call strips queueToken and returns the child result unchanged, release is idempotent', () =>
  withEnv(async ({ make, log }) => {
    const c = make();
    await c.init();
    await c.request('tools/list');
    const { body } = await c.acquire('my agent');
    assert.equal(body.status, 'granted');
    assert.equal(typeof body.token, 'string');
    assert.equal(typeof body.idleTimeoutMs, 'number');
    const r = await c.call('browser_navigate', { url: 'http://x', queueToken: body.token });
    assert.deepEqual(r, {
      content: [{ type: 'text', text: JSON.stringify({ tool: 'browser_navigate', arguments: { url: 'http://x' } }) }],
      structuredContent: { tool: 'browser_navigate', arguments: { url: 'http://x' } },
    });
    const fail = await c.call('fail', { queueToken: body.token });
    assert.equal(fail.isError, true);
    assert.equal(fail.content[0].text, 'boom');
    const calls = toolCalls(log).filter((e) => e.tool === 'browser_navigate' && e.arguments.url === 'http://x');
    assert.equal(calls.length, 1);
    assert.ok(!('queueToken' in calls[0].arguments));
    const rel = await c.call('queue_release', { queueToken: body.token });
    assert.equal(rel.isError, undefined);
    assert.equal(Client.json(rel).status, 'released');
    const again = await c.call('queue_release', { queueToken: body.token });
    assert.notEqual(again.isError, true);
    assert.equal(Client.json(again).ok, false);
    const after = await c.call('browser_navigate', { url: 'http://y', queueToken: body.token });
    assert.equal(after.isError, true);
    assert.match(after.content[0].text, /expired or was released/);
  }));

test('unknown tool with a valid token is an isError result', () =>
  withEnv(async ({ make }) => {
    const c = make();
    await c.init();
    const { body } = await c.acquire();
    const r = await c.call('does_not_exist', { queueToken: body.token });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Unknown tool/);
  }));

test('two processes share one dir: second waits (position 1), then is granted after release', () =>
  withEnv(async ({ make }) => {
    const a = make();
    const b = make();
    await a.init();
    await b.init();
    const ga = (await a.acquire('first')).body;
    assert.equal(ga.status, 'granted');
    const wb = (await b.acquire('second')).body;
    assert.equal(wb.status, 'waiting');
    assert.equal(wb.position, 1);
    assert.equal(wb.holder, 'first');
    assert.equal(typeof wb.ticket, 'string');
    assert.match(wb.retry, /queue_acquire/);
    const status = Client.json(await b.call('queue_status', {}));
    assert.equal(status.holder, 'first');
    assert.equal(status.waiters.length, 1);
    assert.ok(!JSON.stringify(status).includes(ga.token));
    assert.ok(!JSON.stringify(status).includes(wb.ticket));
    await a.call('queue_release', { queueToken: ga.token });
    const gb = (await b.acquire('second', wb.ticket)).body;
    assert.equal(gb.status, 'granted');
    assert.notEqual(gb.token, ga.token);
    const old = await a.call('browser_snapshot', { queueToken: ga.token });
    assert.equal(old.isError, true);
  }));

test('re-acquire with an unknown ticket is an isError telling the agent to call without ticket', () =>
  withEnv(async ({ make }) => {
    const c = make();
    await c.init();
    const { r } = await c.acquire('x', 'no-such-ticket');
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /without (a )?ticket/);
  }));

test('idle expiry makes the old token refused', () =>
  withEnv(
    async ({ make }) => {
      const c = make();
      await c.init();
      const { body } = await c.acquire();
      await new Promise((r) => setTimeout(r, 400));
      const r = await c.call('browser_snapshot', { queueToken: body.token });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /expired or was released/);
    },
    { env: { DSH_PWQ_IDLE_MS: '200', DSH_PWQ_CHILD_TIMEOUT_MS: '100' } },
  ));

test('killing the holder process lets the waiter be granted', () =>
  withEnv(async ({ make }) => {
    const a = make();
    const b = make();
    await a.init();
    await b.init();
    assert.equal((await a.acquire('first')).body.status, 'granted');
    const wb = (await b.acquire('second')).body;
    assert.equal(wb.status, 'waiting');
    a.kill();
    await a.exited;
    let got;
    const ok = await waitFor(async () => {
      got = (await b.acquire('second', wb.ticket)).body;
      return got.status === 'granted';
    }, 8000);
    assert.ok(ok, 'waiter granted after holder died');
  }));

test('child crash fails the in-flight call with isError, next call restarts the child', () =>
  withEnv(
    async ({ make, log }) => {
      const c = make();
      await c.init();
      const { body } = await c.acquire();
      const crashed = await c.call('browser_snapshot', { queueToken: body.token });
      assert.equal(crashed.isError, true);
      const pidsBefore = new Set(readLog(log).map((e) => e.pid));
      const ok = await c.call('browser_navigate', { url: 'http://again', queueToken: body.token });
      assert.notEqual(ok.isError, true);
      assert.match(ok.content[0].text, /again/);
      const pidsAfter = new Set(readLog(log).map((e) => e.pid));
      assert.ok(pidsAfter.size > pidsBefore.size, 'a new child process was started');
    },
    { env: { FAKE_MCP_CRASH_ON: 'browser_snapshot' } },
  ));

test('a slow child call does not block other requests', () =>
  withEnv(
    async ({ make }) => {
      const c = make();
      await c.init();
      const { body } = await c.acquire();
      const slow = c.call('slow', { queueToken: body.token });
      await new Promise((r) => setTimeout(r, 50));
      const t0 = Date.now();
      assert.deepEqual((await c.request('ping')).result, {});
      assert.ok(Date.now() - t0 < 500);
      const status = await c.call('queue_status', {});
      assert.notEqual(status.isError, true);
      assert.notEqual((await slow).isError, true);
    },
    { env: { FAKE_MCP_SLOW_MS: '700' } },
  ));

test('cleanup on grant and on release closes extra tabs and navigates to about:blank', () =>
  withEnv(async ({ make, log }) => {
    const c = make();
    await c.init();
    await c.request('tools/list'); // starts the child
    const mine = (e) => e.tool === 'browser_tabs' || e.tool === 'browser_navigate';
    const { body } = await c.acquire(); // grant: tabs 0,1,2 -> only one left
    let calls = toolCalls(log).filter(mine);
    assert.deepEqual(calls[0], { method: 'tools/call', pid: calls[0].pid, tool: 'browser_tabs', arguments: { action: 'list' } });
    const closes = calls.filter((e) => e.arguments.action === 'close').map((e) => e.arguments.index);
    assert.deepEqual(closes.sort(), [0, 1]); // keeps the current tab (index 2)
    const nav = calls.filter((e) => e.tool === 'browser_navigate');
    assert.equal(nav.length, 1);
    assert.deepEqual(nav[0].arguments, { url: 'about:blank' });
    assert.ok(calls.indexOf(nav[0]) > calls.findIndex((e) => e.arguments.action === 'close'));
    // release: one tab left -> list + navigate only
    const before = toolCalls(log).length;
    await c.call('queue_release', { queueToken: body.token });
    const rel = toolCalls(log).slice(before);
    assert.deepEqual(rel.map((e) => e.tool), ['browser_tabs', 'browser_navigate']);
  }));

test('cleanup is skipped silently when the child lacks the tools', () =>
  withEnv(
    async ({ make }) => {
      const c = make();
      await c.init();
      await c.request('tools/list');
      const { body } = await c.acquire();
      assert.equal(body.status, 'granted');
      const rel = await c.call('queue_release', { queueToken: body.token });
      assert.equal(Client.json(rel).status, 'released');
    },
    { env: { FAKE_MCP_NO_TABS_TOOL: '1' } },
  ));

test('stdin end exits the wrapper and kills the child (no orphan)', () =>
  withEnv(
    async ({ make, log }) => {
      const c = make();
      await c.init();
      await c.request('tools/list');
      const childPid = readLog(log).find((e) => e.pid).pid;
      assert.ok(isAlive(childPid));
      c.proc.stdin.end();
      const exit = await Promise.race([c.exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
      assert.notEqual(exit, 'timeout');
      assert.ok(await waitFor(() => !isAlive(childPid), 5000), 'child pid is gone');
    },
    { env: { FAKE_MCP_IGNORE_STDIN_END: '1' } },
  ));

test('environment configuration: child from DSH_PWQ_CHILD_COMMAND + DSH_PWQ_CHILD_ARGS', () =>
  withEnv(async ({ make }) => {
    const c = make({
      args: [],
      env: { DSH_PWQ_CHILD_COMMAND: process.execPath, DSH_PWQ_CHILD_ARGS: JSON.stringify([FAKE]) },
    });
    await c.init();
    const list = await c.request('tools/list');
    assert.ok(list.result.tools.some((t) => t.name === 'browser_navigate'));
  }));

test('stdout carries protocol messages only', () =>
  withEnv(async ({ make }) => {
    const c = make();
    await c.init();
    await c.request('tools/list');
    await c.acquire();
    for (const line of c.raw) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  }));

test('startup is refused when DSH_PWQ_IDLE_MS is smaller than the child timeout', async () => {
  const { spawnSync } = await import('node:child_process');
  const { SERVER } = await import('../fixtures/mcp-client.mjs');
  const dir = tmpDir();
  try {
    const run = (env) => spawnSync(process.execPath, [SERVER, '--', process.execPath, FAKE], {
      env: { ...process.env, DSH_PWQ_DIR: dir, ...env }, input: '', encoding: 'utf8', timeout: 15000,
    });
    const bad = run({ DSH_PWQ_IDLE_MS: '5000', DSH_PWQ_CHILD_TIMEOUT_MS: '10000' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /DSH_PWQ_IDLE_MS.*DSH_PWQ_CHILD_TIMEOUT_MS/);
    const ok = run({ DSH_PWQ_IDLE_MS: '10000', DSH_PWQ_CHILD_TIMEOUT_MS: '10000' });
    assert.equal(ok.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
