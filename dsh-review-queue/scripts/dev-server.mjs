/**
 * Dev server for the phone page (lib/mobile): a bare node:http server, no DSH, no login, that mounts the plugin's real pieces
 * (index.js apply(): store, queue, capture, the router with the dev route, the push routes and the /m/ static files) behind a
 * fake context, seeded with one demo item per card type. Push delivery is recorded, never sent. For trying the page in a browser:
 *
 *   node scripts/dev-server.mjs            -> http://127.0.0.1:8788/review-queue/m/   (PORT=... overrides the port)
 *
 * Extra routes: GET /__dev/pushes (what would have been pushed), GET /__dev/prompts (replies sent to sessions),
 * POST /__dev/reset (a fresh seeded list). State lives in a throwaway folder, never in the real DSH state.
 */
import { createServer } from 'node:http'
import { mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'
import { seed } from './dev-seed.mjs'

const PREFIX = '/review-queue'
const STATE_FILES = ['queue.json', 'vapid.json', 'push.json']
export const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'scratch', 'rq-dev-state')

/** A stand-in for the summary model: the title is the reply's first line, the summary its last paragraph; "[no-action]" in a reply says nothing is for the user. */
function fakeLlm() {
  return {
    listProviders: () => [{ id: 'dev' }],
    listModels: () => [{ id: 'dev-mini', name: 'dev mini' }],
    prepareCall: async () => ({
      config: {},
      stream: async function* ({ messages }) {
        const reply = messages[0].content[0].text.split('Assistant reply to summarise:\n\n').pop()
        const paragraphs = reply.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
        const title = paragraphs[0].replace(/^#+\s*/, '').split(/\s+/).slice(0, 8).join(' ')
        yield { type: 'text-delta', text: 'TITLE: ' + title + '\nACTIONABLE: ' + (reply.includes('[no-action]') ? 'no' : 'yes') + '\nSUMMARY: ' + paragraphs.at(-1).replace('[no-action] ', '') }
      },
    }),
  }
}

/** The pieces of the host the plugin asks for, faked: the session controller (replies are recorded), the workspace registry and the llm. */
function createFakeHost({ pushes, prompts, log }) {
  const archivedSessionIds = []
  const registry = {
    archivedSessionIds,
    archiveSession: async (id) => { archivedSessionIds.push(id) },
    list: () => [
      { id: 'ws-plugins', title: 'dsh-plugins', path: 'D:/dev/ai/dsh-plugins', sessionIds: [] },
      { id: 'ws-app', title: 'CTnP-Final', path: 'D:/dev/CTnP-Final', sessionIds: [] },
    ],
  }
  const controller = { prompt: async (request) => { prompts.push({ sessionId: request.sessionId, text: request.content?.[0]?.text }) }, create: async () => ({ sessionId: 'dev-new' }), rename: async () => {} }
  const services = { sessionController: controller, workspaceRegistry: registry, llm: fakeLlm() }
  const disposers = []
  const ctx = {
    logger: { info: log, warn: log },
    get: (name) => services[name],
    on() {}, // the dev route drives the plugin's own handlers
    provide() {},
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    inject: (_names, callback) => callback({
      connection: { admit: () => ({}) }, // no sign-in here: the dev server only listens on loopback
      webServer: { register: (route) => { ctx.route = route } },
      effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    }),
  }
  const sendPush = async (subscription, payload, opts) => { pushes.push({ endpoint: subscription.endpoint, payload, opts: { ttl: opts.ttl, urgency: opts.urgency, topic: opts.topic } }); return { ok: true, status: 201, gone: false } }
  return { ctx, sendPush, dispose: () => { for (const d of disposers.splice(0).reverse()) { try { d() } catch { /* best effort */ } } } }
}

const wipe = (stateDir) => { for (const f of STATE_FILES) for (const name of [f, f + '.tmp']) { try { unlinkSync(join(stateDir, name)) } catch { /* not there */ } } }

/**
 * @param {{ port?: number, host?: string, stateDir?: string, quiet?: boolean }} [opts] port 0 picks a free port
 */
export async function startDevServer({ port = 8788, host = '127.0.0.1', stateDir = DEFAULT_STATE_DIR, quiet = false } = {}) {
  const log = quiet ? () => {} : (line) => console.log(line)
  const pushes = []
  const prompts = []
  mkdirSync(stateDir, { recursive: true })
  let app

  const mount = () => {
    wipe(stateDir)
    pushes.length = 0
    prompts.length = 0
    const host_ = createFakeHost({ pushes, prompts, log })
    const queue = apply(host_.ctx, { dev: true, stateDir, sendPush: host_.sendPush })
    app = { queue, route: host_.ctx.route, dispose: host_.dispose }
  }
  const unmount = () => { app?.dispose(); app?.queue?.stop?.() }

  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  let url
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname
    if (path === '/') { res.writeHead(302, { location: PREFIX + '/m/' }); return res.end() }
    if (path === '/__dev/pushes') return json(res, 200, pushes)
    if (path === '/__dev/prompts') return json(res, 200, prompts)
    if (path === '/__dev/reset' && req.method === 'POST') { await reset(); return json(res, 200, { ok: true }) }
    // Reading aloud on the desktop would speak through the real TTS client; the phone uses its own speech.
    if (path === PREFIX + '/v1/read') return json(res, 409, { ok: false, error: 'no-speaker' })
    if (path === PREFIX || path.startsWith(PREFIX + '/')) return app.route.handler(req, res)
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  async function reset() {
    unmount()
    mount()
    await seed({ base: url, queue: app.queue })
  }

  mount()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  url = 'http://' + host + ':' + server.address().port
  await seed({ base: url, queue: app.queue })
  log('review-queue dev server: ' + url + PREFIX + '/m/  (state ' + stateDir + ')')

  return {
    url,
    port: server.address().port,
    get queue() { return app.queue },
    pushes,
    prompts,
    reset,
    async stop() {
      unmount()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dev = await startDevServer({ port: Number(process.env.PORT) || 8788 })
  const stop = () => { void dev.stop().then(() => process.exit(0)) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
