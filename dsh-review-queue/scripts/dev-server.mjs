/**
 * Dev server for the phone page (lib/mobile): a bare node:http server, no DSH, no login, that mounts the plugin's real pieces
 * (index.js apply(): store, queue, capture, the router with the dev route, the push routes and the /m/ static files) behind a
 * fake context, seeded with one demo item per card type. Push delivery is recorded, never sent. For trying the page in a browser:
 *
 *   node scripts/dev-server.mjs            -> http://127.0.0.1:8788/review-queue/m/   (PORT=... overrides the port)
 *
 * Extra routes: GET /__dev/pushes (what would have been pushed), GET /__dev/prompts (replies sent to sessions),
 * POST /__dev/reset (a fresh seeded list), POST /__dev/pr-merged (a merged-PR item), POST /__dev/push (sends a custom push payload to the registered devices). State lives in a
 * throwaway folder, never in the real DSH state.
 *
 * Opt-in modes (CLI flags or env):
 *   --real-queue / DEV_REAL_QUEUE=1   serve a COPY of ~/.dsh/review-queue/queue.json (read only on the source) in
 *                                     ~/.dsh/scratch/rq-dev-real-state: no wipe, no seed; the fake session controller and registry still
 *                                     only record. /__dev/reset re-copies the source. DEV_REAL_QUEUE_SOURCE=<file> overrides the source.
 *   --real-push  / REAL_PUSH=1        the plugin's real Web Push sender instead of the recorder (the push services are really called).
 */
import { createServer } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'
import { createPushStore, jsonFileIo, loadOrCreateVapid } from '../push.js'
import { seed } from './dev-seed.mjs'

const PREFIX = '/review-queue'
const STATE_FILES = ['queue.json', 'vapid.json', 'push.json']
export const DEFAULT_STATE_DIR = join(homedir(), '.dsh', 'scratch', 'rq-dev-state')
export const REAL_QUEUE_SOURCE = join(homedir(), '.dsh', 'review-queue', 'queue.json')
export const REAL_STATE_DIR = join(homedir(), '.dsh', 'scratch', 'rq-dev-real-state')

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
 * @param {{ port?: number, host?: string, stateDir?: string, quiet?: boolean, realQueue?: boolean | string, realPush?: boolean,
 *   sendPushOverride?: Function }} [opts] port 0 picks a free port; realQueue true or a queue.json path serves a copy of it instead
 *   of the demo seed; realPush uses the real Web Push sender (sendPushOverride stands in for it in tests)
 */
export async function startDevServer({ port = 8788, host = '127.0.0.1', stateDir, quiet = false, realQueue = false, realPush = false, sendPushOverride } = {}) {
  const source = realQueue ? resolve(typeof realQueue === 'string' ? realQueue : REAL_QUEUE_SOURCE) : undefined
  stateDir = stateDir ?? (source ? REAL_STATE_DIR : DEFAULT_STATE_DIR)
  if (source) {
    if (!existsSync(source)) throw new Error('source queue not found: ' + source)
    // Safety: the scratch copy must never be the real file, or the plugin would write into the real queue.
    if (resolve(stateDir) === dirname(source)) throw new Error('the state dir is the same folder as the source queue: ' + stateDir)
  }
  const log = quiet ? () => {} : (line) => console.log(line)
  const pushes = []
  const prompts = []
  mkdirSync(stateDir, { recursive: true })
  let app

  // Real queue: a fresh copy of the source (the only access to it is this read); the push key and devices stay across restarts.
  const copySource = () => { copyFileSync(source, join(stateDir, 'queue.json')); try { unlinkSync(join(stateDir, 'queue.json.tmp')) } catch { /* not there */ } }
  const sendPush = (host_) => (realPush ? sendPushOverride : host_.sendPush)
  const mount = () => {
    if (source) copySource(); else wipe(stateDir)
    pushes.length = 0
    prompts.length = 0
    const host_ = createFakeHost({ pushes, prompts, log })
    const queue = apply(host_.ctx, { dev: true, stateDir, sendPush: sendPush(host_) })
    app = { queue, route: host_.ctx.route, dispose: host_.dispose }
  }
  const unmount = () => { app?.dispose(); app?.queue?.stop?.() }

  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  const readBody = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} } }
  let url
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://local').pathname
    if (path === '/') { res.writeHead(302, { location: PREFIX + '/m/' }); return res.end() }
    if (path === '/__dev/pushes') return json(res, 200, pushes)
    if (path === '/__dev/prompts') return json(res, 200, prompts)
    if (path === '/__dev/reset' && req.method === 'POST') { await reset(); return json(res, 200, { ok: true }) }
    if (path === '/__dev/pr-merged' && req.method === 'POST') return json(res, 200, devPrMerged(await readBody(req)))
    if (path === '/__dev/push' && req.method === 'POST') return json(res, 200, await devPush(await readBody(req)))
    // Reading aloud on the desktop would speak through the real TTS client; the phone uses its own speech.
    if (path === PREFIX + '/v1/read') return json(res, 409, { ok: false, error: 'no-speaker' })
    if (path === PREFIX || path.startsWith(PREFIX + '/')) return app.route.handler(req, res)
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  async function reset() {
    unmount()
    mount()
    if (!source) await seed({ base: url, queue: app.queue })
  }

  /** Adds a merged-PR item (the queue method the PR watcher would call): { prId, title?, followUps? }. */
  function devPrMerged(body) {
    const prId = String(body.prId ?? '1')
    app.queue.notifyPrMerged({ prId, prSessions: [{ id: 'pr-' + prId, title: String(body.title ?? 'PR ' + prId) }], followUps: Array.isArray(body.followUps) ? body.followUps : [] })
    return { ok: true }
  }

  /** Sends one payload ({ title, body, tag, url, device?, ttl?, urgency? }) to every registered device (or the one with that id), as the notifier would. */
  async function devPush(body) {
    const io = jsonFileIo(join(stateDir, 'push.json'), { mode: 0o600 })
    const vapid = loadOrCreateVapid({ io: jsonFileIo(join(stateDir, 'vapid.json'), { mode: 0o600 }) })
    // A separate store over the same file: it reads the devices at call time, so a device added or removed through the routes is seen.
    const store = createPushStore({ io, vapid, ...(realPush ? (sendPushOverride ? { sendPush: sendPushOverride } : {}) : { sendPush: recorder }) })
    const payload = { title: String(body.title ?? 'Task list'), body: String(body.body ?? ''), tag: String(body.tag ?? 'task-list'), url: String(body.url ?? '#/') }
    const opts = { ttl: Number(body.ttl) || 300, urgency: body.urgency ?? 'normal', topic: String(body.topic ?? payload.tag) }
    const targets = store.devices().filter((d) => body.device === undefined || d.id === body.device)
    const results = []
    for (const d of targets) { const r = await store.send(d.id, payload, opts); results.push({ id: d.id, ok: r.ok, status: r.status, gone: r.gone, ...(r.error ? { error: r.error } : {}) }) }
    return { sent: results.length, results }
  }
  const recorder = async (subscription, payload, opts) => { pushes.push({ endpoint: subscription.endpoint, payload, opts: { ttl: opts.ttl, urgency: opts.urgency, topic: opts.topic } }); return { ok: true, status: 201, gone: false } }

  mount()
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, host, resolveListen) })
  url = 'http://' + host + ':' + server.address().port
  if (!source) await seed({ base: url, queue: app.queue })
  log('review-queue dev server: ' + url + PREFIX + '/m/  (state ' + stateDir + (source ? '; COPY of ' + source : '') + (realPush ? '; REAL push' : '') + ')')

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
  const flag = (name, env) => process.argv.includes('--' + name) || process.env[env] === '1'
  const dev = await startDevServer({
    port: Number(process.env.PORT) || 8788,
    realQueue: flag('real-queue', 'DEV_REAL_QUEUE') ? (process.env.DEV_REAL_QUEUE_SOURCE || true) : false,
    realPush: flag('real-push', 'REAL_PUSH'),
  })
  const stop = () => { void dev.stop().then(() => process.exit(0)) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
