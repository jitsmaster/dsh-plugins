// Tiny newline-delimited JSON-RPC MCP server used as a stand-in for Playwright MCP in tests.
// Env: FAKE_MCP_LOG (append one JSON line per received message: {method, tool?, arguments?, pid}),
//      FAKE_MCP_CRASH_ON=<tool> (exit mid-call), FAKE_MCP_SLOW_MS (duration of the `slow` tool, default 200),
//      FAKE_MCP_TABS (initial tab count, default 3), FAKE_MCP_NO_TABS_TOOL=1 (omit browser_tabs),
//      FAKE_MCP_HUGE_BYTES (size of the `huge` tool's result text, default 5000),
//      FAKE_MCP_IGNORE_STDIN_END=1 (stay alive when stdin closes, so only an explicit kill ends it).
import fs from 'node:fs';
import readline from 'node:readline';

const log = process.env.FAKE_MCP_LOG;
const crashOn = process.env.FAKE_MCP_CRASH_ON;
const slowMs = Number(process.env.FAKE_MCP_SLOW_MS ?? 200);
let tabs = Array.from({ length: Number(process.env.FAKE_MCP_TABS ?? 3) }, (_, i) => `Tab ${i}`);
let current = tabs.length - 1;

const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  },
  {
    name: 'browser_tabs',
    description: 'List, create, close, or select a browser tab',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list', 'new', 'close', 'select'] }, index: { type: 'number' } },
      required: ['action'],
    },
  },
  { name: 'browser_snapshot', description: 'Capture accessibility snapshot', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Waits FAKE_MCP_SLOW_MS then answers', inputSchema: { type: 'object', properties: {} } },
  { name: 'huge', description: 'Answers with a FAKE_MCP_HUGE_BYTES-long line', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'Always returns isError', inputSchema: { type: 'object', properties: {} } },
].filter((t) => !(process.env.FAKE_MCP_NO_TABS_TOOL && t.name === 'browser_tabs'));

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });

function tabsList() {
  const lines = tabs.map((t, i) => `- ${i}:${i === current ? ' (current)' : ''} [${t}] (https://example.test/${i})`);
  return `### Open tabs\n${lines.join('\n')}`;
}

function callTool(name, args) {
  if (name === 'fail') return text('boom', { isError: true });
  if (name === 'browser_tabs') {
    if (args?.action === 'close' && Number.isInteger(args.index) && tabs[args.index] !== undefined) {
      tabs.splice(args.index, 1);
      current = Math.min(current, tabs.length - 1);
    }
    return text(tabsList());
  }
  return text(JSON.stringify({ tool: name, arguments: args }), { structuredContent: { tool: name, arguments: args } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (log) {
    const entry = { method: msg.method, pid: process.pid };
    if (msg.method === 'tools/call') Object.assign(entry, { tool: msg.params?.name, arguments: msg.params?.arguments });
    fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
  }
  if (msg.id === undefined) return; // notification
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.0.1' } },
    });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    if (name === crashOn) process.exit(1);
    if (name === 'huge') {
      const pad = 'x'.repeat(Number(process.env.FAKE_MCP_HUGE_BYTES ?? 5000));
      send({ jsonrpc: '2.0', id: msg.id, result: text(pad) });
    } else if (name === 'slow') {
      setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: callTool(name, msg.params?.arguments) }), slowMs);
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: callTool(name, msg.params?.arguments) });
    }
  } else if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});
if (process.env.FAKE_MCP_IGNORE_STDIN_END) {
  rl.on('close', () => setInterval(() => {}, 1000));
} else {
  rl.on('close', () => process.exit(0));
}
