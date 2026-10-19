/**
 * Connects one DSH app to the hub (docs/hub.md 5.1, 6.5, 10). The app starts in 'starting' and serves its own items; the launcher looks
 * for or starts a hub in the background and never blocks: a hub means an agent client (registered, synced, polling commands) and the
 * proxy flips to 'hub'; no hub means 'standalone' with the reason as the notice and a retry later; a hub that is lost means 'degraded',
 * which kicks the retry so a dead hub is started again. Focus and reading state is not carried over a mode switch: each mode has its own.
 * Nothing here throws, and the hub process is never stopped from here. The key and label may only be known later (the web port): identify()
 * answers them, and the agent client is created after it did.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAgentClient } from './client.js'
import { createClientHandle } from './client-handle.js'
import { createExecutor } from './executor.js'
import { createHubQueue } from './hub-queue.js'
import { createLauncher, createReconnector } from './launcher.js'
import { createProxy, driveModeFromClient } from './proxy.js'
import { cancelStalePending } from '../capture.js'

const pluginVersion = () => {
  try { return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version) } catch { return undefined }
}

/** The executor's open-session command: the session controller of this app, when it can show a session (the overlay's own button runs in the browser). */
export function openSessionOf(controllerOf) {
  return async (sessionId) => {
    let controller
    try { controller = controllerOf() } catch { controller = undefined }
    if (typeof controller?.openSession !== 'function') return { ok: false, error: 'no-controller' }
    try { await controller.openSession(sessionId); return { ok: true } } catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 200) } }
  }
}

/**
 * @param {{ stateDir: string, port: number, hubNode?: string, instanceKey: string, instanceId: string, label: string, adapter: any, local: any,
 *   makeServe: (queue: any) => Function, speaker?: any, controllerOf?: () => any, workspaces?: () => any[], sessionIds?: () => string[], identify?: () => Promise<{ key: string, label: string }>,
 *   log?: (line: string) => void, deps?: { launcher?: object, agent?: object, retryMs?: { min: number, max: number } } }} opts
 *   adapter: the store adapter of the app; local: the review queue service over it; makeServe: builds the local router for the queue the proxy serves from.
 */
export function wireHub({ stateDir, port, hubNode, instanceKey, instanceId, label, adapter, local, makeServe, speaker, controllerOf = () => undefined, workspaces = () => [], sessionIds = () => [], identify, log = () => {}, deps = {} }) {
  const handle = createClientHandle({ instanceId })
  const hubQueue = createHubQueue({ local, client: handle, speaker, controllerOf, log })
  const secret = () => { try { return readFileSync(join(stateDir, 'hub.secret'), 'utf8').trim() || undefined } catch { return undefined } }
  const staleIds = new Set(adapter.list({ status: 'open' }).map((i) => i.id)) // captured before this process
  let found
  let attachedTo
  let settled = false
  let identity
  const whoAmI = () => (identity ??= Promise.resolve().then(() => (identify ? identify() : { key: instanceKey, label })).catch(() => ({ key: instanceKey, label })))

  const launcher = createLauncher({ stateDir, port, hubNode, log, ...deps.launcher })
  const reconnector = createReconnector({ ensureHub: () => launcher.ensureHub(), onResult, retryMs: deps.retryMs })
  const proxy = createProxy({
    queue: hubQueue, serve: makeServe(hubQueue), hubUrl: () => found?.baseUrl, secret, instanceId: () => instanceId,
    mirror: () => handle.mirror.snapshot(), onHubUnreachable: () => reconnector.kick(), log, refreshWorkspaces: () => handle.syncWorkspaces(),
  })
  const executor = createExecutor({ queue: local, adapter, openSession: openSessionOf(controllerOf) })
  const stopDriving = driveModeFromClient(proxy, handle)
  const offState = handle.onState((state) => { if (state === 'degraded') reconnector.kick() })

  /** Without a hub nobody settles the questions of a dead process, so this app does it, for what it had before it started. */
  function settleStale() {
    if (settled) return
    settled = true
    const n = cancelStalePending(adapter, { only: staleIds, log })
    if (n) log('standalone: ' + n + ' stale request(s) of an earlier run ended')
  }

  async function connect(result) {
    const key = secret()
    if (!key) return proxy.setMode('standalone', 'no hub secret file')
    found = result
    const who = await whoAmI()
    if (!handle.attached || attachedTo !== result.baseUrl) {
      attachedTo = result.baseUrl
      handle.attach(createAgentClient({ baseUrl: result.baseUrl, secret: key, instanceKey: who.key, instanceId, label: who.label, pluginVersion: pluginVersion(), adapter, executor, workspaces, sessionIds, log, ...deps.agent }))
      handle.start()
    } else if (handle.state === 'stopped') handle.start()
  }

  function onResult(result) {
    if (result.mode === 'hub') { void connect(result).catch((error) => log('hub connect failed (' + String(error?.code ?? error?.name ?? 'error') + ')')); return }
    proxy.setMode('standalone', result.notice ?? result.reason)
    settleStale()
  }

  return {
    hubQueue, proxy, client: handle, reconnector,
    /** Starts looking for the hub; never throws and does not wait. */
    start() { void reconnector.run().catch((error) => log('hub start failed (' + String(error?.code ?? error?.name ?? 'error') + ')')) },
    /** The app ends: retries stop, the agent says bye (questions end at once). The hub keeps running. */
    async dispose() {
      reconnector.stop()
      stopDriving()
      offState()
      await handle.stop({ bye: true })
    },
  }
}
