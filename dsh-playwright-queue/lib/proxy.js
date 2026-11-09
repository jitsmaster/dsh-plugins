// MCP proxy logic: a lazily spawned child MCP client (default Playwright MCP) and the request handler that
// serialises access to it with the lease queue. No dependencies; the only I/O here is the child's stdio.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createLineReader, DEFAULT_MAX_LINE_BYTES, encode, errorResponse, parseLine, ERR } from './jsonrpc.js';

export const CLIENT_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_TIMEOUT_MS = 120000;
const HOLDER_ID_BYTES = 12;
const HOLDER_SUFFIX = /#[0-9a-f]{24}$/;
const UNSAFE_LABEL_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const CMD_UNSAFE = /[\s&|<>^%!"()]/;

const defaultLog = (...a) => console.error('[dsh-playwright-queue]', ...a);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.rpc = { code, message, ...(data === undefined ? {} : { data }) };
  }
}

// ---- spawning -------------------------------------------------------------------------------------------------
// The command and args come only from env/CLI config, never from tool arguments. Node >= 18.20 refuses to spawn
// .cmd/.bat directly (EINVAL) and `shell:true` would build a shell string, so on Windows a .cmd is run through
// `cmd.exe /d /s /c <cmd> <args>` with a fixed prefix and every metacharacter rejected up front.
export function resolveSpawn(command, args = [], platform = process.platform, env = process.env) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    for (const part of [command, ...args]) {
      if (typeof part !== 'string' || CMD_UNSAFE.test(part)) {
        throw new Error('Unsafe character in child command or argument (cmd.exe metacharacter, space or quote)');
      }
    }
    return { command: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
  }
  return { command, args };
}

export function defaultChildCommand(platform = process.platform) {
  return { command: platform === 'win32' ? 'npx.cmd' : 'npx', args: ['-y', '@playwright/mcp@0.0.85'] };
}

function killProcess(proc) {
  try { proc.stdin.end(); } catch { /* already closed */ }
  try {
    if (process.platform === 'win32' && proc.pid) {
      // kill the whole tree: npx.cmd -> cmd.exe -> node -> browser
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else if (process.platform !== 'win32' && proc.pid) {
      // spawned detached (own process group): signal the whole group so the browser dies with npx
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
    } else {
      proc.kill('SIGTERM');
    }
  } catch { /* already gone */ }
}

// ---- child MCP client -----------------------------------------------------------------------------------------
export function createChildClient({ command, args = [], timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env, log = defaultLog, maxLineBytes = DEFAULT_MAX_LINE_BYTES }) {
  let current = null; // { proc, pending, nextId, dead, ready }
  let cachedTools = null;

  function failAll(gen, err) {
    if (gen.dead) return;
    gen.dead = true;
    if (current === gen) current = null;
    for (const p of gen.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    gen.pending.clear();
  }

  function write(gen, msg) {
    if (gen.dead) return;
    try { gen.proc.stdin.write(encode(msg)); } catch { /* the exit handler reports it */ }
  }

  function onMessage(gen, msg) {
    if (typeof msg.method === 'string') {
      if (msg.id === undefined) return; // child notification: ignored
      if (msg.method === 'ping') write(gen, { jsonrpc: '2.0', id: msg.id, result: {} });
      else write(gen, errorResponse(msg.id, ERR.METHOD_NOT_FOUND, `Method not found: ${msg.method}`));
      return;
    }
    const p = gen.pending.get(msg.id);
    if (!p) return;
    gen.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(Object.assign(new Error(String(msg.error.message ?? 'Child error')), { rpc: msg.error }));
    else p.resolve(msg.result);
  }

  function request(gen, method, params, ms = timeoutMs) {
    return new Promise((resolve, reject) => {
      if (gen.dead) return reject(new Error('Child MCP server is not running'));
      const id = gen.nextId++;
      const timer = setTimeout(() => {
        gen.pending.delete(id);
        write(gen, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } });
        reject(new Error(`Child request ${method} timed out after ${ms} ms`));
      }, ms);
      gen.pending.set(id, { resolve, reject, timer });
      write(gen, { jsonrpc: '2.0', id, method, params });
    });
  }

  function start() {
    const spec = resolveSpawn(command, args);
    const proc = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, shell: false, env, detached: process.platform !== 'win32' });
    const gen = { proc, pending: new Map(), nextId: 1, dead: false, ready: null };
    current = gen;
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => failAll(gen, new Error(`Child MCP server failed: ${err.message}`)));
    proc.on('exit', (code, sig) => failAll(gen, new Error(`Child MCP server exited (${sig ?? `code ${code}`})`)));
    const reader = createLineReader(
      (line) => {
        const { msg } = parseLine(line);
        if (msg) onMessage(gen, msg);
      },
      {
        maxLineBytes,
        onOverflow: () => {
          log('child stdout line too long; dropped');
          // The result is lost, so fail in-flight requests now instead of holding the lease until the timeout.
          const err = new Error(`child result too large (over ${maxLineBytes} bytes)`);
          for (const p of gen.pending.values()) {
            clearTimeout(p.timer);
            p.reject(err);
          }
          gen.pending.clear();
        },
      },
    );
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => reader.push(d));
    gen.ready = (async () => {
      await request(gen, 'initialize', { protocolVersion: CLIENT_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-playwright-queue', version: '0' } });
      write(gen, { jsonrpc: '2.0', method: 'notifications/initialized' });
      const tools = [];
      let cursor;
      for (let page = 0; page < 50; page++) {
        const r = await request(gen, 'tools/list', cursor ? { cursor } : {});
        if (Array.isArray(r?.tools)) tools.push(...r.tools);
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      cachedTools = tools;
      return gen;
    })().catch((err) => {
      failAll(gen, err);
      killProcess(proc);
      throw err;
    });
    return gen;
  }

  const ensure = () => (current && !current.dead ? current : start()).ready;

  return {
    isRunning: () => Boolean(current && !current.dead),
    async getTools() {
      if (cachedTools) return cachedTools;
      await ensure();
      return cachedTools;
    },
    async callTool(name, toolArgs, ms) {
      const gen = await ensure();
      return request(gen, 'tools/call', { name, arguments: toolArgs }, ms ?? timeoutMs);
    },
    close() {
      const gen = current;
      if (!gen) return;
      failAll(gen, new Error('Child MCP server closed'));
      killProcess(gen.proc);
    },
  };
}

// ---- tools ------------------------------------------------------------------------------------------------------
const TOKEN_SUFFIX = ' [Requires the `queueToken` argument returned by queue_acquire; call queue_acquire first.]';

// Returns new objects only; the cached child tool list is never mutated.
export function republishTools(tools) {
  return tools.map((t) => {
    const schema = isObj(t.inputSchema) ? t.inputSchema : { type: 'object' };
    return {
      ...t,
      description: `${typeof t.description === 'string' ? t.description : ''}${TOKEN_SUFFIX}`.trimStart(),
      inputSchema: {
        ...schema,
        type: schema.type ?? 'object',
        properties: {
          ...(isObj(schema.properties) ? schema.properties : {}),
          queueToken: { type: 'string', description: 'Lease token from queue_acquire (required).' },
        },
      },
    };
  });
}

const QUEUE_TOOLS = [
  {
    name: 'queue_acquire',
    description:
      'Acquire the exclusive browser/CMS lease. Only one session at a time may use the browser. Returns {status:"granted", token} ' +
      'or {status:"waiting", ticket, position}; when waiting, call queue_acquire again with the ticket until granted. ' +
      'Pass the token as `queueToken` to every browser tool and call queue_release when done.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', maxLength: 80, description: 'Human-readable label for this session (shown to waiters).' },
        ticket: { type: 'string', description: 'Ticket from an earlier "waiting" answer; omit on the first call.' },
      },
    },
  },
  {
    name: 'queue_release',
    description: 'Release the lease so the next session can use the browser. Always call this when finished.',
    inputSchema: { type: 'object', properties: { queueToken: { type: 'string' } }, required: ['queueToken'] },
  },
  {
    name: 'queue_status',
    description: 'Diagnostics: who holds the browser lease and who is waiting (no tokens).',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ---- browser cleanup --------------------------------------------------------------------------------------------
export function parseTabIndices(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const re = /^\s*-\s*(\d+):\s*(\(current\)\s*)?/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ index: Number(m[1]), current: Boolean(m[2]) });
  return out;
}

const resultText = (r) => (Array.isArray(r?.content) ? r.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : '');
const toolResult = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
const toolError = (message) => ({ isError: true, content: [{ type: 'text', text: message }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const displayHolder = (h) => (typeof h === 'string' ? h.replace(HOLDER_SUFFIX, '') : h);

export function createProxy({
  queue,
  child,
  pollIntervalMs = 1000,
  waitBudgetMs = 45000,
  idleTimeoutMs = 600000,
  cleanupTimeoutMs = 8000, // soft cap; with cleanupGraceMs the whole cleanup is bounded at ~10 s
  cleanupGraceMs = 2000,
  pendingTtlMs = 120000, // matches the queue's default waiter TTL
  serverInfo = { name: 'dsh-playwright-queue', version: '0.0.0' },
  pid = process.pid,
  log = defaultLog,
}) {
  const held = new Set(); // tokens granted through this wrapper (released on graceful shutdown)
  const pendingTickets = new Map(); // ticket -> last time a queue_acquire call touched it
  const acquiring = new Map(); // JSON-RPC request id -> { cancelled } for in-flight queue_acquire calls

  // Best effort, never throws; skipped when the child is not running (a fresh child has no stale tabs) or lacks the tools.
  async function cleanupBrowser(token) {
    if (!child.isRunning()) return;
    const ours = () => { try { return queue.validate(token); } catch { return false; } };
    // Soft deadline: stop starting new calls. Hard deadline (soft + grace): a call already sent to the child is
    // still awaited so it cannot touch the next holder's tab after the lease is released.
    const hardDeadline = Date.now() + cleanupTimeoutMs + cleanupGraceMs;
    const left = () => Math.max(1, hardDeadline - Date.now());
    let abandoned = false;
    let inflight = null; // settles when the last call sent to the child settles
    const send = (name, args) => {
      const p = child.callTool(name, args, left());
      inflight = p.then(() => {}, () => {});
      return p;
    };
    const work = (async () => {
      const names = new Set((await child.getTools()).map((t) => t.name));
      if (!ours()) return;
      if (names.has('browser_tabs')) {
        const listed = await send('browser_tabs', { action: 'list' });
        const tabs = parseTabIndices(resultText(listed));
        const keep = (tabs.find((t) => t.current) ?? tabs[0])?.index;
        const extra = tabs.filter((t) => t.index !== keep).map((t) => t.index).sort((a, b) => b - a); // highest first: indices stay valid
        for (const index of extra) {
          if (abandoned || !ours()) return;
          await send('browser_tabs', { action: 'close', index });
        }
      }
      if (names.has('browser_navigate') && !abandoned && ours()) await send('browser_navigate', { url: 'about:blank' });
    })().catch((e) => log('browser cleanup failed:', e.message));
    let timer;
    const timedOut = await Promise.race([work.then(() => false), new Promise((r) => { timer = setTimeout(() => r(true), cleanupTimeoutMs); })]);
    clearTimeout(timer);
    if (timedOut) {
      abandoned = true;
      if (inflight) {
        let graceTimer;
        await Promise.race([inflight, new Promise((r) => { graceTimer = setTimeout(r, cleanupGraceMs); })]);
        clearTimeout(graceTimer);
      }
    }
  }

  function sweepPending() {
    const cutoff = Date.now() - pendingTtlMs;
    for (const [t, at] of pendingTickets) {
      if (at < cutoff) {
        try { queue.cancel(t); } catch { /* best effort */ }
        pendingTickets.delete(t);
      }
    }
  }

  async function acquire(args, reqId) {
    const ctl = { cancelled: false };
    if (reqId !== undefined) acquiring.set(reqId, ctl);
    try {
      return await acquireInner(args, ctl);
    } finally {
      if (reqId !== undefined && acquiring.get(reqId) === ctl) acquiring.delete(reqId);
    }
  }

  async function acquireInner(args, ctl) {
    sweepPending();
    for (const t of held) { try { if (!queue.validate(t)) held.delete(t); } catch { /* best effort */ } }
    if (args.label !== undefined && typeof args.label !== 'string') return toolError('label must be a string');
    if (args.ticket !== undefined && typeof args.ticket !== 'string') return toolError('ticket must be a string');
    let ticket = args.ticket;
    if (!ticket) {
      const label = (args.label ?? '').replace(UNSAFE_LABEL_CHARS, ' ').trim().slice(0, 80) || 'agent';
      const holder = `${label}#${crypto.randomBytes(HOLDER_ID_BYTES).toString('hex')}`; // per attempt: enqueue is idempotent per (holder, pid)
      try {
        ({ ticket } = queue.enqueue({ holder, pid }));
      } catch (e) {
        return toolError(e?.code === 'EQUEUEFULL' ? 'The browser queue is full; try again later.' : `Queue error: ${e.message}`);
      }
      pendingTickets.set(ticket, Date.now());
    }
    const deadline = Date.now() + waitBudgetMs;
    for (;;) {
      if (ctl.cancelled) {
        pendingTickets.delete(ticket);
        try { queue.cancel(ticket); } catch { /* best effort */ }
        return toolError('queue_acquire was cancelled');
      }
      let r;
      try {
        r = queue.poll(ticket);
      } catch (e) {
        return toolError(`Queue error: ${e.message}`);
      }
      if (r.status === 'granted') {
        pendingTickets.delete(ticket);
        held.add(r.token);
        await cleanupBrowser(r.token);
        if (ctl.cancelled) { // cancelled while cleaning up: do not orphan the fresh lease
          try { queue.release(r.token); } catch { /* best effort */ }
          held.delete(r.token);
          return toolError('queue_acquire was cancelled');
        }
        return toolResult({ status: 'granted', token: r.token, idleTimeoutMs });
      }
      if (r.status === 'unknown') {
        pendingTickets.delete(ticket);
        return toolError('Unknown or expired ticket. Call queue_acquire again without a ticket.');
      }
      pendingTickets.set(ticket, Date.now());
      if (Date.now() + pollIntervalMs > deadline) {
        return toolResult({
          status: 'waiting',
          ticket,
          position: r.position,
          holder: displayHolder(r.holderLabel) ?? null,
          retry: 'call queue_acquire again with this ticket',
        });
      }
      await sleep(pollIntervalMs);
    }
  }

  async function release(args) {
    const token = args.queueToken;
    if (typeof token !== 'string' || !token) return toolError('queueToken is required');
    let ok = false;
    try {
      if (queue.validate(token)) {
        await cleanupBrowser(token); // while still holding the lease, so the next holder is never raced
        ok = queue.release(token);
      }
    } catch (e) {
      return toolError(`Queue error: ${e.message}`);
    }
    held.delete(token);
    return ok ? toolResult({ status: 'released', ok: true }) : toolResult({ status: 'not_held', ok: false, message: 'not held' });
  }

  function status() {
    const s = queue.snapshot();
    return toolResult({
      holder: s.lease ? displayHolder(s.lease.holder) : null,
      idleForMs: s.lease ? s.lease.idleForMs : null,
      heldForMs: s.lease ? Math.max(0, Date.now() - s.lease.since) : null,
      waitersCount: s.waiters.length,
      waiters: s.waiters.map((w) => ({ position: w.position, label: displayHolder(w.holder) })),
    });
  }

  async function forward(name, args) {
    if (!isObj(args)) return toolError('arguments must be an object (and include queueToken)');
    const { queueToken, ...rest } = args;
    if (typeof queueToken !== 'string' || !queueToken) {
      return toolError('queueToken is required: call queue_acquire first and pass its token as queueToken.');
    }
    try {
      if (!queue.touch(queueToken)) {
        held.delete(queueToken);
        return toolError('queueToken is not valid: the lease expired or was released. Call queue_acquire again to get a new token.');
      }
    } catch (e) {
      return toolError(`Queue error: ${e.message}`);
    }
    let tools;
    try {
      tools = await child.getTools();
    } catch (e) {
      return toolError(`Browser server unavailable: ${e.message}`);
    }
    if (!tools.some((t) => t.name === name)) return toolError(`Unknown tool: ${name}`);
    try {
      if (!queue.validate(queueToken)) { // released/expired while the child was starting
        held.delete(queueToken);
        return toolError('queueToken is not valid: the lease expired or was released. Call queue_acquire again to get a new token.');
      }
      const res = await child.callTool(name, rest);
      try { queue.touch(queueToken); } catch { /* best effort */ }
      return res;
    } catch (e) {
      if (e.rpc) throw new RpcError(e.rpc.code, e.rpc.message, e.rpc.data);
      return toolError(`Browser server call failed: ${e.message}`);
    }
  }

  async function toolsCall(params, reqId) {
    if (!isObj(params) || typeof params.name !== 'string' || params.name === '') {
      throw new RpcError(ERR.INVALID_PARAMS, 'tools/call requires params.name');
    }
    const args = params.arguments === undefined ? {} : params.arguments;
    switch (params.name) {
      case 'queue_acquire':
        return isObj(args) ? acquire(args, reqId) : toolError('arguments must be an object');
      case 'queue_release':
        return isObj(args) ? release(args) : toolError('arguments must be an object');
      case 'queue_status':
        return status();
      default:
        return forward(params.name, args);
    }
  }

  async function dispatch(msg) {
    switch (msg.method) {
      case 'initialize':
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : CLIENT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo,
        };
      case 'ping':
        return {};
      case 'tools/list': {
        let childTools = [];
        try {
          childTools = republishTools(await child.getTools());
        } catch (e) {
          log('child tools unavailable:', e.message);
        }
        return { tools: [...QUEUE_TOOLS, ...childTools] };
      }
      case 'tools/call':
        return toolsCall(msg.params, msg.id);
      default:
        throw new RpcError(ERR.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
    }
  }

  return {
    // Resolves to a JSON-RPC response object, or undefined for notifications / stray responses.
    async handle(msg) {
      if (typeof msg.method !== 'string') {
        const isResponse = 'result' in msg || 'error' in msg;
        return msg.id !== undefined && !isResponse ? errorResponse(msg.id, ERR.INVALID_REQUEST, 'Invalid Request') : undefined;
      }
      if (msg.id === undefined) {
        if (msg.method === 'notifications/cancelled' && isObj(msg.params)) {
          const ctl = acquiring.get(msg.params.requestId);
          if (ctl) ctl.cancelled = true; // the wait loop notices on its next poll tick
        }
        return undefined;
      }
      try {
        return { jsonrpc: '2.0', id: msg.id, result: await dispatch(msg) };
      } catch (e) {
        if (e instanceof RpcError) return errorResponse(msg.id, e.rpc.code, e.rpc.message, e.rpc.data);
        log('internal error:', e?.message);
        return errorResponse(msg.id, ERR.INTERNAL, 'Internal error');
      }
    },
    // Graceful exit: give back what this wrapper holds so waiters do not need to wait for the pid check.
    shutdown() {
      for (const t of held) { try { queue.release(t); } catch { /* best effort */ } }
      for (const t of pendingTickets.keys()) { try { queue.cancel(t); } catch { /* best effort */ } }
      held.clear();
      pendingTickets.clear();
    },
  };
}
