// Helpers of the H3 tests: a fake DSH host around the REAL plugin (createReviewQueuePlugin), a world with one hub directory and a
// fake spawn that starts the hub in this process, and a tiny HTTP front for the route the plugin registers.
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createHub } from '../hub/hub.js'
import { createReviewQueuePlugin } from '../index.js'
import { freePort, tmpDir, waitFor } from './hub-helpers.mjs'

export const never = () => new Promise(() => {})
export { waitFor }

/** One hub directory, one hub port; fake spawn starts (and kills) the hub inside this process. */
export async function makeWorld(t, { spawnDelayMs = 40 } = {}) {
  const dir = tmpDir(t)
  const hubPort = await freePort()
  const world = { dir, hubPort, spawned: [], hub: undefined, spawnFails: false }
  world.hubOptions = {}
  // holdSpawn(): spawned hubs do not come up until releaseSpawn(), so a test can look at the time without a hub
  world.gate = Promise.resolve()
  world.holdSpawn = () => { world.gate = new Promise((resolve) => { world.releaseSpawn = resolve }) }
  world.startHub = async () => {
    const hub = createHub({ stateDir: dir, port: hubPort, tickMs: 0, ...world.hubOptions })
    world.starting = hub.start().then(() => { world.hub = hub; return hub })
    return world.starting
  }
  world.killHub = async () => { await world.starting?.catch(() => {}); const hub = world.hub; world.hub = undefined; world.starting = undefined; await hub?.stop() }
  world.spawn = (exe, args, opts) => {
    world.spawned.push({ exe, args, opts })
    if (world.spawnFails) throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    const child = new EventEmitter()
    child.pid = 4242
    child.unref = () => {}
    setTimeout(async () => { await world.gate; if (!world.hub && !world.starting && !world.closing) world.startHub().catch(() => {}) }, spawnDelayMs)
    return child
  }
  // The apps end first (with their bye), then the hub: an app that outlives its hub would ask for a new one while the test is torn down.
  world.stops = []
  t.after(async () => { world.releaseSpawn?.(); await Promise.all(world.stops.map((stop) => stop())); world.closing = true; await world.killHub() })
  return world
}

const session = (id, reply = '') => ({ id, devTitle: 'Title of ' + id, session: { header: { cwd: 'D:/w' }, deriveMessages: () => [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'text', text: reply }] }] } })

/** The real plugin on a fake host whose web server has the given port; its registered route is served on a real HTTP port. */
export async function startPlugin(t, world, { label, webPort, config = {}, hub = {}, services = {}, injectDelayMs = 0 } = {}) {
  const handlers = {}
  const routes = []
  const cleanups = []
  const provided = {}
  const effect = (fn) => { const off = fn(); if (typeof off === 'function') cleanups.push(off) }
  const ctx = {
    on: (n, f) => { (handlers[n] ??= []).push(f) },
    get: (name) => services[name],
    effect,
    provide: (name, value) => { provided[name] = value },
    logger: { warn() {}, info() {} },
    // injectDelayMs: the host runs the callback only after the plugin was applied (the web server was not up yet), as in the live DSH.
    inject: (_names, fn) => {
      const webCtx = { effect, connection: { admit: () => ({}) }, webServer: { port: webPort, register: (r) => { routes.push(r); return () => {} } } }
      if (injectDelayMs > 0) setTimeout(() => fn(webCtx), injectDelayMs).unref?.()
      else fn(webCtx)
    },
  }
  const hubDeps = { launcher: { spawn: world.spawn, ...hub.launcher }, retryMs: { min: 40, max: 160 }, agent: { backoff: { minMs: 10, maxMs: 40 }, waitMs: 400 }, portWaitMs: 150, ...hub }
  const plugin = createReviewQueuePlugin(ctx, { stateDir: world.dir, hubPort: world.hubPort, instanceLabel: label, hubDeps, ui: { seq: 0 }, ...config })
  const server = createServer((req, res) => routes[0].handler(req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + server.address().port + '/review-queue'
  let stopped
  const stop = async () => {
    stopped ??= (async () => { server.closeAllConnections?.(); server.close(); for (const off of cleanups.splice(0).reverse()) { try { await off() } catch { /* best effort */ } } })()
    return stopped
  }
  world.stops.push(stop)
  let calls = 0
  const p = {
    ...plugin, handlers, routes, provided, base, stop, label, webPort,
    get: async (path) => { const r = await fetch(base + path); return { status: r.status, json: await r.json() } },
    post: async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() } },
    snapshot: async () => (await p.get('/v1/snapshot')).json,
    // the mode of the instance route (starting, hub, standalone, degraded), which is what the overlay sees
    state: () => plugin.proxy?.getMode(),
    inState: (mode, ms = 10_000) => waitFor(() => plugin.proxy?.getMode() === mode, ms, label + ' in ' + mode),
    mirrored: (id) => [...(plugin.agent?.mirror.snapshot()?.open ?? []), ...(plugin.agent?.mirror.snapshot()?.resolved ?? [])].some((i) => i.id === id),
    async completed(sessionId, text) { await handlers['agent/turn-stopping'][0]({ agent: session(sessionId, text) }); return plugin.store.findOpen({ type: 'completed', sessionId }).id },
    async permission(sessionId, command = 'ls') {
      const callId = 'call-' + label + '-' + ++calls
      const agent = session(sessionId)
      await handlers['tools/pre-execute'][0]({ name: 'shell', callId, arguments: { command }, agent }, async () => ({}))
      const outcome = handlers['approval/request'][0]({ agent, toolName: 'shell', callId, signal: new AbortController().signal }, never)
      return { outcome, id: plugin.store.findOpen({ type: 'permission', sessionId }).id }
    },
    question(sessionId) {
      const callId = 'call-' + label + '-' + ++calls
      const outcome = handlers['user-questions/request'][0]({ agent: session(sessionId), questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }], signal: new AbortController().signal, wait: { callId } }, never)
      return { outcome, id: plugin.store.findOpen({ type: 'question', sessionId }).id }
    },
  }
  return p
}

/** [id, position] of the open items of a snapshot. */
export const listOf = (snap) => snap.open.map((i) => [i.id, i.position])
