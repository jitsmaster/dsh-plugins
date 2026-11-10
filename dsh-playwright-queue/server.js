#!/usr/bin/env node
// MCP stdio server that fronts a child MCP server (default Playwright MCP) and serialises access to it
// with the shared lease queue. Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to stderr.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueue, DEFAULT_IDLE_MS } from './lib/queue.js';
import { createLineReader, encode, errorResponse, parseLine, ERR } from './lib/jsonrpc.js';
import { createChildClient, createProxy, defaultChildCommand } from './lib/proxy.js';
import { createServerGate, defaultValidateWorktree } from './lib/server-gate.js';

const log = (...a) => console.error('[dsh-playwright-queue]', ...a);
const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const positiveEnv = (name, fallback) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;
};

function childConfig(argv, env) {
  const sep = argv.indexOf('--');
  if (sep >= 0 && argv[sep + 1]) return { command: argv[sep + 1], args: argv.slice(sep + 2) };
  if (env.DSH_PWQ_CHILD_COMMAND) {
    let args = [];
    if (env.DSH_PWQ_CHILD_ARGS) {
      args = JSON.parse(env.DSH_PWQ_CHILD_ARGS);
      if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new Error('DSH_PWQ_CHILD_ARGS must be a JSON array of strings');
    }
    return { command: env.DSH_PWQ_CHILD_COMMAND, args };
  }
  return defaultChildCommand();
}

function main() {
  let cfg;
  let queue;
  const idleMs = process.env.DSH_PWQ_IDLE_MS === undefined ? undefined : Number(process.env.DSH_PWQ_IDLE_MS);
  try {
    cfg = childConfig(process.argv.slice(2), process.env);
    // the queue validates its own options; a bad DSH_PWQ_IDLE_MS fails startup loudly
    queue = createQueue({ dir: process.env.DSH_PWQ_DIR || path.join(os.homedir(), '.dsh', 'playwright-queue'), idleMs });
  } catch (e) {
    log('startup failed:', e.message);
    process.exit(1);
  }

  const childTimeoutMs = positiveEnv('DSH_PWQ_CHILD_TIMEOUT_MS', 120000);
  // a child call longer than the idle timeout could outlive the lease and touch the next holder's browser
  if ((idleMs ?? DEFAULT_IDLE_MS) < childTimeoutMs) {
    log(`startup failed: DSH_PWQ_IDLE_MS (${idleMs ?? DEFAULT_IDLE_MS}) must not be smaller than DSH_PWQ_CHILD_TIMEOUT_MS (${childTimeoutMs}); raise the idle timeout or lower the child timeout`);
    process.exit(1);
  }
  // opt-in: with DSH_PWQ_SERVER_PORT set, a lease holder must name its worktree and the server on that port must run from it
  let serverGate = null;
  let gateCacheMs;
  const portEnv = process.env.DSH_PWQ_SERVER_PORT;
  if (portEnv !== undefined && portEnv !== '') {
    try {
      if (!/^\d+$/.test(portEnv.trim())) throw new RangeError('must be a plain decimal integer from 1 to 65535');
      serverGate = createServerGate({ port: Number(portEnv.trim()) });
    } catch (e) {
      log('startup failed: DSH_PWQ_SERVER_PORT:', e.message);
      process.exit(1);
    }
  }
  const cacheEnv = process.env.DSH_PWQ_GATE_CACHE_MS;
  if (cacheEnv !== undefined && cacheEnv !== '') {
    if (!/^\d+$/.test(cacheEnv.trim())) {
      log('startup failed: DSH_PWQ_GATE_CACHE_MS must be a non-negative integer (0 checks every call)');
      process.exit(1);
    }
    gateCacheMs = Number(cacheEnv.trim());
  }
  const child = createChildClient({ ...cfg, timeoutMs: childTimeoutMs, log });
  const proxy = createProxy({
    queue,
    child,
    serverGate,
    gateCacheMs,
    validateWorktree: serverGate ? defaultValidateWorktree : null,
    pollIntervalMs: positiveEnv('DSH_PWQ_POLL_MS', 1000),
    waitBudgetMs: positiveEnv('DSH_PWQ_WAIT_BUDGET_MS', 45000),
    idleTimeoutMs: idleMs ?? DEFAULT_IDLE_MS,
    serverInfo: { name: 'dsh-playwright-queue', version: pkg.version },
    log,
  });

  const inflight = new Set();
  const send = (obj) => {
    try { process.stdout.write(encode(obj)); } catch (e) { log('stdout write failed:', e.message); }
  };

  let closing = false;
  const shutdown = (code = 0) => {
    if (closing) return;
    closing = true;
    try { proxy.shutdown(); } catch { /* best effort */ }
    child.close();
    process.exit(code);
  };

  const onLine = (line) => {
    const { msg, error } = parseLine(line);
    if (error) return send(error);
    const p = proxy.handle(msg).then(
      (res) => { if (res) send(res); },
      (e) => {
        log('handler failed:', e?.message);
        if (msg.id !== undefined) send(errorResponse(msg.id, ERR.INTERNAL, 'Internal error'));
      },
    ).finally(() => inflight.delete(p));
    inflight.add(p);
  };

  const reader = createLineReader(onLine, { onOverflow: () => send(errorResponse(null, ERR.INVALID_REQUEST, 'Request line too long')) });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => reader.push(d));
  process.stdin.on('end', async () => {
    reader.end();
    // let requests that were already read finish (briefly) so their responses are not lost
    await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, 1500))]);
    shutdown(0);
  });
  process.stdin.on('error', () => shutdown(0));
  process.stdout.on('error', () => shutdown(0)); // EPIPE: the client is gone
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => shutdown(0));
  process.on('uncaughtException', (e) => { log('uncaught:', e?.message); shutdown(1); });
  process.on('unhandledRejection', (e) => { log('unhandled rejection:', e?.message ?? e); shutdown(1); });
}

main();
