/**
 * The `reviewQueue` service: the one API the sidebar, the overlay and (later) voice all use. It owns no state of its
 * own except the focused item; items live in the store and pending requests in capture.
 */
import { randomUUID } from 'node:crypto'
import { spokenFor, titleFor, fullTextFor, chunkForSpeech } from './speech.js'
import { riskOf } from './risk.js'
import { createTodos } from './todo.js'

const MAX_REPLY = 4000
const TYPES = ['question', 'permission', 'completed', 'pr-merged', 'todo']
/** A todo being started is not waiting on the user. */
const needsUser = (item) => !(item.type === 'todo' && item.state === 'starting')

// Show/hide commands for the browsers. Module-level so that re-creating the queue inside one server run (a plugin
// reload) does not reset the sequence: a tab that already saw seq N would otherwise ignore every later command.
let uiSeq = 0
let uiCmd

export function createReviewQueue({ store, capture, controllerOf, registryOf = () => undefined, speaker, llm, titlesOf, sparcText, suggestTimeoutMs, log, now = Date.now, uuid = () => randomUUID().slice(0, 8) }) {
  const todos = createTodos({ store, controllerOf, registryOf, llm, titlesOf, sparcText, suggestTimeoutMs, uuid, log })
  let focusId
  let reading // id of the item being read aloud
  let readOpen = false // the item being read was in the queue when reading started
  let readSeq = 0 // a read that was replaced or stopped must not clear the state of its successor
  let lastReadId // the item the last successful read started on (for "read again")
  const listeners = new Set()
  const emit = () => { for (const l of [...listeners]) { try { l() } catch { /* ignore */ } } }

  // The store tells us about every change; a focused item that left the queue drops its focus.
  const risksOf = (item) => (item.type === 'permission' ? riskOf({ toolName: item.payload?.toolName, detail: item.payload?.detail ?? item.payload?.summary, path: item.payload?.path, workspace: item.workspace }) : undefined)
  const stopReading = () => {
    readSeq++
    try { speaker?.stop() } catch { /* nothing to stop */ }
    reading = undefined
  }
  store.onChange(() => {
    if (focusId !== undefined && store.get(focusId)?.status !== 'open') focusId = undefined
    // A message nobody is waiting for any more is not read on.
    if (reading !== undefined && readOpen && store.get(reading)?.status !== 'open') stopReading()
    emit()
  })

  const openItem = (id) => {
    const item = store.get(id)
    return item?.status === 'open' ? item : undefined
  }

  /** A merged-PR item whose session was archived somewhere else (the sidebar menu) has nothing left to offer. */
  const settleArchived = () => {
    let archived
    try { archived = new Set((registryOf()?.archivedSessionIds ?? []).map(String)) } catch { return }
    if (!archived.size) return
    for (const item of store.snapshot().open) if (item.type === 'pr-merged' && archived.has(String(item.sessionId))) store.resolve(item.id, { kind: 'archived', by: 'elsewhere' })
  }

  return {
    snapshot() {
      settleArchived()
      const snap = store.snapshot()
      return {
        ...snap,
        serverNow: now(),
        focusId,
        reading,
        ui: { seq: uiSeq, cmd: uiCmd },
        open: snap.open.map((item) => ({ ...item, title: titleFor(item), spoken: spokenFor(item, item.position), ...(item.type === 'permission' ? { risks: risksOf(item) } : {}) })),
        resolved: snap.resolved.map((item) => ({ ...item, title: titleFor(item) })),
      }
    },
    /** Reads the whole message of an item aloud (not its summary). */
    read(id) {
      const item = store.get(id)
      if (!item) return { ok: false, error: 'not-found' }
      if (!speaker) return { ok: false, error: 'no-speaker' }
      const position = store.snapshot().open.find((i) => i.id === id)?.position
      const token = readSeq + 1
      const result = speaker.speak(chunkForSpeech(fullTextFor(item, position)), {
        onEnd: () => { if (readSeq === token && reading === id) { reading = undefined; emit() } },
      })
      if (!result?.ok) return { ok: false, error: result?.error ?? 'no-speaker' }
      readSeq = token
      reading = id
      lastReadId = id
      readOpen = item.status === 'open'
      emit()
      return { ok: true }
    },
    /**
     * A pull request was merged: one item per session that worked on it ("PR n" sessions), offering to archive that
     * session. `followUps` are the "after PR n" sessions that were told to start (shown on the card). Once per session and PR.
     * info: { prId, prSessions: [{ id, title }], followUps: [{ id, title }] }.
     */
    notifyPrMerged(info) {
      const prId = String(info?.prId ?? '')
      if (!/^\d+$/.test(prId)) return { ok: false, error: 'bad-input', added: 0 }
      const listOf = (value) => (Array.isArray(value) ? value : []).filter((s) => typeof s?.id === 'string' && s.id).map((s) => ({ id: s.id, title: typeof s.title === 'string' ? s.title : '' }))
      const followUps = listOf(info.followUps)
      let added = 0
      for (const session of listOf(info.prSessions)) {
        const duplicate = store.list().some((i) => i.type === 'pr-merged' && i.sessionId === session.id && i.payload?.prId === prId)
        if (duplicate) continue
        store.add({ type: 'pr-merged', sessionId: session.id, sessionTitle: session.title, payload: { prId, followUps } })
        added++
      }
      return { ok: true, added }
    },
    /** Archives the session of a merged-PR item (the card's button), then closes the item. Running work of that session is stopped. */
    async archive(id) {
      const item = openItem(id)
      if (!item) return { ok: false, error: 'not-open' }
      if (item.type !== 'pr-merged') return { ok: false, error: 'not-pr-merged' }
      const registry = registryOf()
      if (typeof registry?.archiveSession !== 'function') return { ok: false, error: 'no-registry' }
      try {
        await registry.archiveSession(item.sessionId, { stopActivity: true })
      } catch (error) {
        if (error?.name === 'WorkspaceUnknownSessionError') { store.resolve(id, { kind: 'session-ended' }); return { ok: false, error: 'no-session' } }
        return { ok: false, error: String(error?.message ?? error) }
      }
      store.resolve(id, { kind: 'archived', by: 'card' })
      return { ok: true }
    },
    /** Todo (the TODO function): addTodo(text, { workspaceId?, sparc? }) -> { ok, id, state }; confirmTodo(id, { workspaceId? }) also retries a failed one; cancelTodo(id). Background work: todoIdle(). */
    addTodo: (text, opts) => todos.add(text, opts),
    confirmTodo: (id, opts) => todos.confirm(String(id), opts),
    cancelTodo: (id) => todos.cancel(String(id)),
    todoIdle: () => todos.idle(),
    workspaces: () => todos.workspaces(),
    /** Open items only: how many wait in total and per type. */
    count() {
      const byType = Object.fromEntries(TYPES.map((t) => [t, 0]))
      const open = store.snapshot().open.filter(needsUser)
      for (const item of open) if (item.type in byType) byType[item.type]++
      return { total: open.length, byType }
    },
    /** The oldest open item (position 1), or undefined. */
    first: () => store.snapshot().open[0],
    /** Reads the open item at a 1-based queue position (what the card's play button reads) and focuses it. */
    readPosition(n) {
      const open = store.snapshot().open
      if (!open.length) return { ok: false, error: 'empty' }
      if (!Number.isInteger(n) || n < 1 || n > open.length) return { ok: false, error: 'no-item' }
      const { id } = open[n - 1]
      this.setFocus(id)
      const result = this.read(id)
      return result.ok ? { ok: true, id } : result
    },
    /** Reads the last item read once more, while it is still waiting. */
    again() {
      if (lastReadId === undefined || !openItem(lastReadId)) return { ok: false, error: 'nothing-read' }
      const id = lastReadId
      const result = this.read(id)
      return result.ok ? { ok: true, id } : result
    },
    /**
     * Reads the open item after the one read last, in the current order (the first item when nothing was read or that
     * item has left the list). Past the end: { ok:false, error:'no-item', n } where n is the missing position.
     */
    next() {
      const open = store.snapshot().open
      if (!open.length) return { ok: false, error: 'empty' }
      const n = (lastReadId === undefined ? -1 : open.findIndex((i) => i.id === lastReadId)) + 2
      const result = this.readPosition(n)
      return !result.ok && result.error === 'no-item' ? { ...result, n } : result
    },
    /** The session of the first open item and that item's card title, for "open the first item's session". */
    openTarget() {
      const item = store.snapshot().open[0]
      return item ? { sessionId: item.sessionId, title: titleFor(item) } : undefined
    },
    /** Asks every open browser to show or hide the overlay; each applies a given seq once. */
    uiCommand(cmd) {
      if (cmd !== 'show' && cmd !== 'hide') return { ok: false, error: 'bad-command' }
      uiCmd = cmd
      uiSeq++
      emit()
      return { ok: true, seq: uiSeq }
    },
    stop() {
      const was = reading
      stopReading()
      if (was !== undefined) emit()
      return { ok: true }
    },
    /** A misclicked Reviewed, a result replaced by a newer one, or one hidden as needing no action goes back into the queue. */
    reopen(id) {
      const item = store.get(id)
      if (!item) return { ok: false, error: 'not-found' }
      const kind = item.resolution?.kind
      if (item.type !== 'completed' || item.status !== 'resolved' || (kind !== 'reviewed' && kind !== 'superseded' && kind !== 'no-action')) return { ok: false, error: 'not-reopenable' }
      return store.reopen(id) ? { ok: true } : { ok: false, error: 'not-reopenable' }
    },
    /** Approve this request and every identical open one of the same session; never a risky one. */
    approveSimilar(id, opts = {}) {
      if (opts.via === 'phone' && opts.confirmed !== true) return { ok: false, error: 'needs-confirm' }
      const item = store.get(id)
      if (!item || item.status !== 'open') return { ok: false, error: 'not-open' }
      if (item.type !== 'permission') return { ok: false, error: 'not-permission' }
      if (risksOf(item).length) return { ok: false, error: 'risky' }
      const key = (i) => [i.sessionId, i.payload?.toolName, i.payload?.detail ?? i.payload?.summary].join('\u0000')
      const same = store.snapshot().open.filter((i) => i.type === 'permission' && key(i) === key(item))
      let count = 0
      for (const i of same) if (capture.decidePermission(i.id, 'approve').ok) count++
      return count ? { ok: true, count } : { ok: false, error: 'not-pending' }
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    answer: (id, answers) => capture.answerQuestion(id, answers),
    lateAnswer: (id, answers) => capture.lateAnswerQuestion(id, answers),
    /**
     * Approve a pending request. From the phone (opts.via === 'phone') the page must say that its confirm sheet was accepted
     * (confirmed) and, for a risky request, that the press-and-hold was completed (held). Same login as the desktop, so this is a
     * guard against a wrong tap or a stale client, not a second security boundary.
     */
    approve(id, opts = {}) {
      if (opts.via === 'phone') {
        const item = openItem(id)
        if (item?.type === 'permission') {
          if (opts.confirmed !== true) return { ok: false, error: 'needs-confirm' }
          if (risksOf(item).length && opts.held !== true) return { ok: false, error: 'needs-hold' }
        }
      }
      return capture.decidePermission(id, 'approve')
    },
    deny: (id) => capture.decidePermission(id, 'deny'),
    markReviewed(id) {
      const item = openItem(id)
      if (!item) return { ok: false, error: 'not-open' }
      if (item.type !== 'completed' && item.type !== 'pr-merged') return { ok: false, error: 'not-completed' }
      return store.resolve(id, { kind: 'reviewed', by: 'card' }) ? { ok: true } : { ok: false, error: 'not-open' }
    },
    async reply(id, text) {
      const item = openItem(id)
      if (!item) return { ok: false, error: 'not-open' }
      if (item.type !== 'completed') return { ok: false, error: 'not-completed' }
      const body = typeof text === 'string' ? text.trim() : ''
      if (!body) return { ok: false, error: 'empty' }
      if (body.length > MAX_REPLY) return { ok: false, error: 'too-long' }
      const controller = controllerOf()
      if (!controller?.prompt) return { ok: false, error: 'no-controller' }
      try {
        await controller.prompt({ requestId: 'review-' + uuid(), sessionId: item.sessionId, mode: 'queue', content: [{ type: 'text', text: body }] }, AbortSignal.timeout(30_000)) // the Remote method requires a caller signal
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
      store.resolve(id, { kind: 'replied', by: 'card' })
      return { ok: true }
    },
    getFocus: () => focusId,
    setFocus(id) {
      if (id !== undefined && !openItem(id)) return false
      if (focusId === id) return true
      focusId = id
      emit()
      return true
    },
  }
}
