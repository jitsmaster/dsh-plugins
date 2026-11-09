// Test helper: drives a server.js process over newline-delimited JSON-RPC.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
export const FAKE = fileURLToPath(new URL('./fake-mcp.mjs', import.meta.url));

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pwq-'));
}

export function readLog(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export const toolCalls = (file) => readLog(file).filter((e) => e.method === 'tools/call');

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export async function waitFor(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

export class Client {
  constructor({ dir, env = {}, args } = {}) {
    this.dir = dir;
    this.proc = spawn(process.execPath, [SERVER, ...(args ?? ['--', process.execPath, FAKE])], {
      env: { ...process.env, DSH_PWQ_DIR: dir, DSH_PWQ_POLL_MS: '50', DSH_PWQ_WAIT_BUDGET_MS: '300', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.pending = new Map();
    this.raw = [];
    this.stderr = '';
    this.nextId = 1;
    this.exited = new Promise((r) => this.proc.once('exit', (code, sig) => r({ code, sig })));
    this.proc.stderr.on('data', (d) => (this.stderr += d));
    this.proc.stdin.on('error', () => {});
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      this.raw.push(line);
      const m = JSON.parse(line); // stdout must be protocol only: throws (fails the test) otherwise
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        p(m);
      }
    });
  }

  writeRaw(line) {
    this.proc.stdin.write(`${line}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method, params) {
    this.writeRaw(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  async init() {
    const r = await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    this.notify('notifications/initialized');
    return r;
  }

  async call(name, args) {
    const r = await this.request('tools/call', { name, arguments: args });
    return r.result ?? r;
  }

  // parsed JSON text of a tool result
  static json(result) {
    return JSON.parse(result.content[0].text);
  }

  async acquire(label = 'agent', ticket) {
    const r = await this.call('queue_acquire', ticket ? { label, ticket } : { label });
    return { r, body: r.isError ? null : Client.json(r) };
  }

  kill() {
    try {
      this.proc.kill();
    } catch { /* already gone */ }
  }

  async close() {
    try {
      this.proc.stdin.end();
    } catch { /* ignore */ }
    const t = setTimeout(() => this.kill(), 3000);
    await this.exited;
    clearTimeout(t);
  }
}
