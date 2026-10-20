/**
 * The `reviewQueue` service in hub mode (docs/hub.md 6.1): reads are synchronous, from a mirror of the hub's snapshot, so every
 * app lists every item with the same global positions; actions run through the hub (answer, approve ... are promises here, where
 * the local service answers at once); what only this app can do stays local (focus, reading aloud, show/hide, merged PRs, the
 * todo background work). While the hub is not connected (degraded, standalone, upgrade needed) the local service answers all of it.
 * Reading and focus use a second service over the mirror, so the play button reads the item of any app.
 * The tip of the day belongs to the local service (this app's model and speaker): tip() and readTip() always go there, and a tip being read here shows up as
 * `reading` of the hub view (the mirror service cannot know it).
 */
import { createReviewQueue, TIP_READING } from '../service.js'
import { createMirrorStore } from './mirror-store.js'

const only = (condition, fields) => (condition ? fields : {})

/**
 * @param {{ local: any, client: { state: string, mirror: any, onState?: Function, call: (kind: string, body: object) => Promise<any> },
 *   speaker?: any, controllerOf?: () => any, now?: () => number, log?: (line: string) => void }} deps
 */
export function createHubQueue({ local, client, speaker, controllerOf = () => undefined, now = Date.now, log }) {
  const mirror = createMirrorStore({ now })
  // The view shares the show/hide state of the local service: uiCommand goes to the local one, the snapshot of either mode carries it.
  const view = createReviewQueue({ store: mirror, capture: {}, controllerOf, speaker, now, log, ui: local.uiState?.() })

  const hubMode = () => {
    if (client.state !== 'connected' || client.mirror.ready !== true) return false
    const snap = client.mirror.snapshot()
    if (snap) mirror.update(snap)
    return snap !== undefined
  }
  const active = () => (hubMode() ? view : local)
  const through = async (kind, body) => {
    try { return await client.call(kind, body) } catch { return { ok: false, error: 'hub-unreachable' } }
  }
  /** An action: through the hub when connected, else the local service. */
  const action = (kind, body, locally) => (hubMode() ? through(kind, body) : locally())

  const listeners = new Set()
  const emit = () => { for (const l of [...listeners]) { try { l() } catch { /* one bad listener must not stop the others */ } } }
  view.onChange(() => {
    // The tip is only on screen while the merged list is empty: an item of any app ends its reading, even though this app's own store holds none.
    if (mirror.snapshot().open.length) local.stopTip?.()
    emit()
  })
  local.onChange(emit)
  client.mirror.onChange?.(() => { hubMode() })
  client.onState?.(emit)

  /** The snapshot of the active service; in hub mode a tip read by the local service ('tip:<id>') is its reading. */
  const snapshot = (opts) => {
    const hub = hubMode()
    const snap = (hub ? view : local).snapshot(opts)
    const own = hub && snap.reading === undefined ? local.readingId?.() : undefined
    return typeof own === 'string' && own.startsWith(TIP_READING) ? { ...snap, reading: own } : snap
  }

  return {
    snapshot,
    tip: () => local.tip?.(),
    readTip: (id) => local.readTip(id),
    stopTip: () => local.stopTip?.(),
    watchSessions: () => local.watchSessions?.(),
    count: () => active().count(),
    first: () => active().first(),
    openTarget: () => active().openTarget(),
    readPosition: (n) => active().readPosition(n),
    again: () => active().again(),
    next: () => active().next(),
    read: (id) => active().read(id),
    getFocus: () => active().getFocus(),
    setFocus: (id) => active().setFocus(id),
    workspaces: () => (hubMode() ? client.mirror.workspaces() : local.workspaces()),
    stop() { view.stop(); return local.stop() },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },

    answer: (id, answers) => action('answer', { id, answers }, () => local.answer(id, answers)),
    lateAnswer: (id, answers) => action('late-answer', { id, answers }, () => local.lateAnswer(id, answers)),
    approve: (id, opts = {}) => action('approve', { id, ...only(opts.confirmed === true, { confirmed: true }), ...only(opts.held === true, { held: true }) }, () => local.approve(id, opts)),
    approveSimilar: (id, opts = {}) => action('approve-similar', { id, ...only(opts.confirmed === true, { confirmed: true }) }, () => local.approveSimilar(id, opts)),
    deny: (id) => action('deny', { id }, () => local.deny(id)),
    markReviewed: (id) => action('reviewed', { id }, () => local.markReviewed(id)),
    reopen: (id) => action('reopen', { id }, () => local.reopen(id)),
    reply: (id, text) => action('reply', { id, text }, () => local.reply(id, text)),
    archive: (id) => action('archive', { id }, () => local.archive(id)),
    thread: (id, opts = {}) => action('thread', { id, ...only(opts.before !== undefined, { before: opts.before }), ...only(opts.limit !== undefined, { limit: opts.limit }), ...only(opts.after !== undefined, { after: opts.after }) }, () => local.thread(id, opts)),
    post: (id, text, opts = {}) => action('post', { id, text, ...only(opts.key !== undefined, { key: opts.key }) }, () => local.post(id, text, opts)),
    resumePaused: (id) => action('paused-resume', { id }, () => local.resumePaused(id)),
    dismissPaused: (id) => action('paused-dismiss', { id }, () => local.dismissPaused(id)),
    addTodo: (text, opts = {}) => action('todo', { text, ...only(opts.workspaceId !== undefined, { workspaceId: opts.workspaceId }), ...only(opts.sparc === true, { sparc: true }) }, () => local.addTodo(text, opts)),
    confirmTodo: (id, opts = {}) => action('todo-confirm', { id, ...only(opts.workspaceId !== undefined, { workspaceId: opts.workspaceId }) }, () => local.confirmTodo(id, opts)),
    cancelTodo: (id) => action('todo-cancel', { id }, () => local.cancelTodo(id)),

    notifyPrMerged: (info) => local.notifyPrMerged(info),
    todoIdle: () => local.todoIdle(),
    uiCommand: (cmd) => local.uiCommand(cmd),
    scanPaused: () => local.scanPaused(), // the session logs are on this PC: always this app that scans
    tuneTodo: (text) => local.tuneTodo(text), // this app's own model: never asked of the hub
    pauseAll: () => local.pauseAll(), // the sessions and the desktop window are this app's: never asked of the hub
    quitApp: () => local.quitApp(),
    runningSessions: () => local.runningSessions(), // the sessions are this app's: never asked of the hub
  }
}
