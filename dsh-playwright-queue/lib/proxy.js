// MCP proxy logic: a lazily spawned child MCP client (default Playwright MCP) and the request handler that
// serialises access to it with the lease queue. No dependencies; the only I/O here is the child's stdio.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
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

const SKIP = Symbol('skipServerCheck'); // ticketWorktrees value for a ticket enqueued without a worktree

// With the server gate on, queue_acquire also takes the caller's worktree.
export function gatedQueueTools(port) {
  return QUEUE_TOOLS.map((t) => {
    if (t.name !== 'queue_acquire') return t;
    return {
      ...t,
      description:
        `${t.description} A \`worktree\` (absolute path of the worktree you are testing) is REQUIRED: browser calls are refused ` +
        `until the API server on port ${port} runs from that worktree (stop the old server and start one on the same port from it). ` +
        'Only for checks with no API server under test (for example the DSH web UI), pass `skipServerCheck: true` instead of a worktree.',
      inputSchema: {
        ...t.inputSchema,
        properties: {
          ...t.inputSchema.properties,
          worktree: { type: 'string', description: 'Absolute path of the worktree whose API server you will test.' },
          skipServerCheck: { type: 'boolean', description: 'Skip the API server check (no worktree needed). Only when no API server is under test.' },
        },
      },
    };
  });
}

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
  serverGate = null, // { port?, check(worktree) -> {ok, message?} }; when set, queue_acquire needs a worktree and browser calls are gated
  gateCacheMs = 30000, // a passing check is reused for this long per token; 0 checks every call
  gateFailCacheMs = 2000, // a refusal is reused for this long per token, so a retry loop does not respawn the lookup
  validateWorktree = null, // (resolvedWorktree) -> error message or null; extra check on the worktree an agent names
  serverInfo = { name: 'dsh-playwright-queue', version: '0.0.0' },
  pid = process.pid,
  log = defaultLog,
}) {
  const held = new Set(); // tokens granted through this wrapper (released on graceful shutdown)
  const pendingTickets = new Map(); // ticket -> last time a queue_acquire call touched it
  const acquiring = new Map(); // JSON-RPC request id -> { cancelled } for in-flight queue_acquire calls
  const ticketWorktrees = new Map(); // ticket -> worktree named at enqueue (gate on only)
  const tokenGate = new Map(); // token -> { worktree, okAt } (gate on only)
  const forgetToken = (t) => { held.delete(t); tokenGate.delete(t); };

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
        ticketWorktrees.delete(t);
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
    for (const t of held) { try { if (!queue.validate(t)) forgetToken(t); } catch { /* best effort */ } }
    if (args.label !== undefined && typeof args.label !== 'string') return toolError('label must be a string');
    if (args.ticket !== undefined && typeof args.ticket !== 'string') return toolError('ticket must be a string');
    let ticket = args.ticket;
    let worktree = null;
    let skip = false;
    if (serverGate) {
      if (args.skipServerCheck !== undefined && typeof args.skipServerCheck !== 'boolean') return toolError('skipServerCheck must be a boolean');
      const known = ticket ? ticketWorktrees.get(ticket) : undefined;
      if (args.skipServerCheck === true) {
        if (args.worktree !== undefined) return toolError('Pass either worktree or skipServerCheck, not both.');
        if (known && known !== SKIP) return toolError(`This ticket was enqueued for ${known}. Poll it without skipServerCheck.`);
        skip = true;
      } else if (args.worktree !== undefined || !ticket) {
        const p = parseWorktree(args.worktree);
        if (p.error) return toolError(p.error);
        if (known === SKIP) return toolError('This ticket was enqueued with skipServerCheck. Poll it without a worktree.');
        if (known && !sameWorktree(known, p.worktree)) {
          return toolError(`This ticket was enqueued for ${known}. Poll it without a worktree, or cancel by letting it expire and acquire again with the new worktree.`);
        }
        worktree = p.worktree;
      } else if (known === SKIP) {
        skip = true;
      } else if (known) {
        worktree = known;
      } // an unknown ticket without a worktree falls through: the poll answers "unknown or expired"
    }
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
    if (worktree) ticketWorktrees.set(ticket, worktree);
    else if (skip) ticketWorktrees.set(ticket, SKIP);
    const deadline = Date.now() + waitBudgetMs;
    for (;;) {
      if (ctl.cancelled) {
        pendingTickets.delete(ticket);
        ticketWorktrees.delete(ticket);
        try { queue.cancel(ticket); } catch { /* best effort */ }
        return toolError('queue_acquire was cancelled');
      }
      let r;
      try {
        r = queue.poll(ticket);
      } catch (e) {
        ticketWorktrees.delete(ticket);
        return toolError(`Queue error: ${e.message}`);
      }
      if (r.status === 'granted') {
        pendingTickets.delete(ticket);
        ticketWorktrees.delete(ticket);
        held.add(r.token);
        if (worktree) tokenGate.set(r.token, { worktree, okAt: 0, failAt: 0, failMsg: '', pending: null });
        else if (skip) tokenGate.set(r.token, { skip: true });
        await cleanupBrowser(r.token);
        if (ctl.cancelled) { // cancelled while cleaning up: do not orphan the fresh lease
          try { queue.release(r.token); } catch { /* best effort */ }
          forgetToken(r.token);
          return toolError('queue_acquire was cancelled');
        }
        return toolResult({ status: 'granted', token: r.token, idleTimeoutMs });
      }
      if (r.status === 'unknown') {
        pendingTickets.delete(ticket);
        ticketWorktrees.delete(ticket);
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
    forgetToken(token);
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

  // Validates and resolves a worktree named by the agent.
  function parseWorktree(named) {
    if (typeof named !== 'string' || !named || !path.isAbsolute(named)) {
      return { error: 'worktree is required: pass the absolute path of the worktree whose API server you will test.' };
    }
    if (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(named)) {
      return { error: 'worktree must start with a drive letter (C:\\...) or be a UNC path.' };
    }
    const wt = path.resolve(named);
    if (path.parse(wt).root === wt) return { error: 'worktree must not be a filesystem root: pass the root of your git worktree.' };
    const bad = validateWorktree ? validateWorktree(wt) : null;
    return bad ? { error: bad } : { worktree: wt };
  }
  const sameWorktree = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

  // One shared check per token; records the outcome on the entry.
  async function runGate(entry) {
    let g;
    try {
      g = await serverGate.check(entry.worktree);
    } catch (e) {
      g = { ok: false, message: `Server check failed: ${e.message}` };
    }
    if (g?.ok) {
      entry.okAt = Date.now();
      entry.failAt = 0;
      return { ok: true };
    }
    entry.okAt = 0;
    entry.failAt = Date.now();
    entry.failMsg = g?.message || 'The API server check refused this call.';
    return { ok: false, message: entry.failMsg };
  }

  async function forward(name, args) {
    if (!isObj(args)) return toolError('arguments must be an object (and include queueToken)');
    const { queueToken, ...rest } = args;
    if (typeof queueToken !== 'string' || !queueToken) {
      return toolError('queueToken is required: call queue_acquire first and pass its token as queueToken.');
    }
    try {
      if (!queue.touch(queueToken)) {
        forgetToken(queueToken);
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
        forgetToken(queueToken);
        return toolError('queueToken is not valid: the lease expired or was released. Call queue_acquire again to get a new token.');
      }
      if (serverGate) {
        const entry = tokenGate.get(queueToken);
        if (!entry) return toolError('This lease has no worktree on record: call queue_release, then queue_acquire again with your worktree.');
        const now = Date.now();
        if (entry.skip) {
          // the holder opted out: no API server is under test
        } else if (entry.okAt > 0 && now - entry.okAt < gateCacheMs) {
          // a recent pass is reused
        } else if (entry.failAt > 0 && now - entry.failAt < gateFailCacheMs) {
          return toolError(entry.failMsg);
        } else {
          if (!entry.pending) entry.pending = runGate(entry).finally(() => { entry.pending = null; });
          const g = await entry.pending;
          if (!g.ok) return toolError(g.message);
        }
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
        return { tools: [...(serverGate ? gatedQueueTools(serverGate.port ?? '?') : QUEUE_TOOLS), ...childTools] };
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
      ticketWorktrees.clear();
      tokenGate.clear();
    },
  };
}
