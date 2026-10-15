// One DSH app wired in hub mode by hand from the real pieces (store adapter, capture, service, executor, agent client, hub queue, router, proxy),
// with its overlay-facing route on a real HTTP port and no launcher. The plugin's own wiring is index.js + agent/wire.js (test/plugin-helpers.mjs
// runs that); this one is the fixed-hub fixture of the proxy tests. Needs a world (plugin-helpers makeWorld) whose hub is already running.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { createAgentClient } from '../agent/client.js'
import { createExecutor } from '../agent/executor.js'
import { createHubQueue } from '../agent/hub-queue.js'
import { createProxy, driveModeFromClient } from '../agent/proxy.js'
import { createStoreAdapter } from '../agent/store-adapter.js'
import { installCapture } from '../capture.js'
import { createRouter } from '../server.js'
import { createReviewQueue } from '../service.js'
import { never, waitFor } from './plugin-helpers.mjs'

export async function startHubApp(t, world, { label, webPort, services = {}, config = {}, workspaces }) {
  const instanceKey = 'k-' + webPort
  const instanceId = randomBytes(8).toString('hex')
  const file = join(world.dir, 'local', instanceKey + '.json')
  const io = {
    read: () => { try { return readFileSync(file, 'utf8') } catch { return undefined } },
    write: (text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) },
  }
  const adapter = createStoreAdapter({ instanceId, io })
  const summarizer = { summarize: async (reply) => ({ text: 'summary of ' + reply.slice(0, 12), source: 'test', title: 'Title', actionable: true }) }
  const capture = installCapture({ on() {}, get: () => undefined }, { store: adapter, summarizer, log: () => {} })
  const controllerOf = () => services.sessionController
  const queue = createReviewQueue({ store: adapter, capture, controllerOf, speaker: config.speaker })
  const client = createAgentClient({
    baseUrl: 'http://127.0.0.1:' + world.hubPort, secret: readFileSync(join(world.dir, 'hub.secret'), 'utf8').trim(), instanceKey, instanceId, label,
    adapter, executor: createExecutor({ queue, adapter }), backoff: { minMs: 10, maxMs: 40 }, waitMs: 400, workspaces,
  })
  const hubQueue = createHubQueue({ local: queue, client, speaker: config.speaker, controllerOf })
  const serve = createRouter({ queue: hubQueue })
  const proxy = createProxy({ queue: hubQueue, serve, hubUrl: () => 'http://127.0.0.1:' + world.hubPort, secret: () => readFileSync(join(world.dir, 'hub.secret'), 'utf8').trim(), instanceId: () => instanceId, mirror: () => client.mirror.snapshot() })
  driveModeFromClient(proxy, client)
  const server = createServer((req, res) => proxy.handle(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port
  const stop = async () => { server.closeAllConnections?.(); server.close(); await client.stop({ bye: false }) }
  t.after(stop)
  client.start()
  const session = (id) => ({ id, devTitle: 'Title of ' + id, session: { header: { cwd: 'D:/w' }, deriveMessages: () => [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'done' }] } })
  let calls = 0
  const app = {
    base, label, webPort, store: adapter, queue, agent: client, proxy, stop,
    inState: (mode, ms = 10_000) => waitFor(() => proxy.getMode() === mode, ms, label + ' in ' + mode),
    mirrored: (id) => [...(client.mirror.snapshot()?.open ?? []), ...(client.mirror.snapshot()?.resolved ?? [])].some((i) => i.id === id),
    async permission(sessionId, command = 'ls') {
      const callId = 'call-' + label + '-' + ++calls
      const agent = session(sessionId)
      await capture.handlers['tools/pre-execute']({ name: 'shell', callId, arguments: { command }, agent }, async () => ({}))
      const outcome = capture.handlers['approval/request']({ agent, toolName: 'shell', callId, signal: new AbortController().signal }, never)
      return { outcome, id: adapter.findOpen({ type: 'permission', sessionId }).id }
    },
    question(sessionId) {
      const callId = 'call-' + label + '-' + ++calls
      const outcome = capture.handlers['user-questions/request']({ agent: session(sessionId), questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }], signal: new AbortController().signal, wait: { callId } }, never)
      return { outcome, id: adapter.findOpen({ type: 'question', sessionId }).id }
    },
  }
  return app
}
