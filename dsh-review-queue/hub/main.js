/**
 * The hub process: node hub/main.js [--state-dir <dir>] [--port <n>] [--idle-exit-ms <ms>].
 * Port: --port, else env DSH_RQ_HUB_PORT, else hub.config.json hubPort, else 47615. A busy port is the singleton guard: when it is
 * a hub (health answers with the hubId that hub.json names) this process exits 0, when it is anything else it exits 2.
 * SIGINT / SIGTERM / a {type:'shutdown'} IPC message stop it gracefully; an idle hub (no request for --idle-exit-ms, default 12 h,
 * 0 = never) stops itself.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadHubConfig } from './config.js'
import { readText } from './atomic-file.js'
import { createHub } from './hub.js'
import { probeHealth } from './probe.js'

export const DEFAULT_PORT = 47615
const fail = (code, message) => { process.stderr.write('hub: ' + message + '\n'); process.exit(code) }

function parsePort(text) {
  if (!/^\d+$/.test(text)) return undefined
  const n = Number(text)
  return n >= 1 && n <= 65535 ? n : undefined
}

/** True when the program on the port is the hub that hub.json names (hub.json may lag a moment behind a hub that just bound). */
async function isRunningHub(stateDir, port) {
  for (let i = 0; i < 10; i++) {
    const health = await probeHealth(port)
    if (!health) return false
    try { if (JSON.parse(readText(join(stateDir, 'hub.json')) ?? '{}').hubId === health.hubId) return true } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

let args
try {
  args = parseArgs({ options: { 'state-dir': { type: 'string' }, port: { type: 'string' }, 'idle-exit-ms': { type: 'string' } }, allowPositionals: false }).values
} catch (error) { fail(1, String(error.message)) }

const stateDir = resolve(args['state-dir'] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'review-queue'))
const wanted = args.port ?? (process.env.DSH_RQ_HUB_PORT || undefined)
const port = wanted === undefined ? loadHubConfig(stateDir).hubPort ?? DEFAULT_PORT : parsePort(wanted)
if (port === undefined) fail(1, 'invalid port (use 1-65535)')
const idleText = args['idle-exit-ms'] ?? (process.env.DSH_RQ_HUB_IDLE_MS || undefined)
if (idleText !== undefined && !/^\d+$/.test(idleText)) fail(1, 'invalid --idle-exit-ms')

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  setTimeout(() => process.exit(1), 5000).unref()
  try { await hub.stop() } catch { /* exiting anyway */ }
  process.exit(0)
}

const hub = createHub({ stateDir, port, ...(idleText === undefined ? {} : { idleExitMs: Number(idleText) }), onIdle: () => { void shutdown() }, onShutdown: () => { void shutdown() } })
try {
  await hub.start()
} catch (error) {
  if (error?.code !== 'EADDRINUSE') fail(1, 'could not start (' + String(error?.code ?? error?.name ?? 'error') + ')')
  if (await isRunningHub(stateDir, port)) { process.stderr.write('hub: already running\n'); process.exit(0) }
  fail(2, 'the port is taken by another program')
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => { void shutdown() })
process.on('message', (m) => { if (m?.type === 'shutdown') void shutdown() })
process.on('uncaughtException', () => { process.exitCode = 1; void shutdown() })
