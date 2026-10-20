/**
 * The `reviewQueue` service: the one API the sidebar, the overlay and (later) voice all use. It owns no state of its
 * own except the focused item; items live in the store and pending requests in capture.
 */
import { randomUUID } from 'node:crypto'
import { spokenFor, titleFor, fullTextFor, chunkForSpeech } from './speech.js'
import { riskOf } from './risk.js'
import { createTodos, MAX_TODO } from './todo.js'
import { RESUME_PROMPT } from './paused.js'
import { isSessionId } from './thread.js'
import { postKeyOf } from './post-key.js'

const MAX_REPLY = 4000
/** reading === 'tip:<id>' while the tip of the day is read aloud (lib/client.js keeps its own copy of the string: it is one self-contained script). */
export const TIP_READING = 'tip:'
const MAX_POST_KEYS = 200 // idempotency keys of accepted phone posts that are remembered
const POST_KEY_TTL_MS = 10 * 60_000
const TYPES = ['question', 'permission', 'completed', 'pr-merged', 'todo', 'paused']
/** A todo being started, or a session paused by a restart (it has its own count), is not waiting on the user. */
const needsUser = (item) => item.type !== 'paused' && !(item.type === 'todo' && item.state === 'starting')

// Show/hide commands for the browsers. The default state is module-level so that re-creating the queue inside one server run
// (a plugin reload) does not reset the sequence: a tab that already saw seq N would otherwise ignore every later command.
// A caller that hosts several apps in one process (tests) passes its own { seq, cmd } per service.
const sharedUi = { seq: 0, cmd: undefined }

export function createReviewQueue({ store, capture, controllerOf, registryOf = () => undefined, speaker, llm, tuner, tips, sessions, titlesOf, sparcText, suggestTimeoutMs, log, ticketTitleOf, paused, threadOf, power, ui = sharedUi, now = Date.now, uuid = () => randomUUID().slice(0, 8) }) {
  const todos = createTodos({ store, controllerOf, registryOf, llm, titlesOf, sparcText, suggestTimeoutMs, uuid, log, ticketTitleOf })
  const resuming = new Set() // paused items whose resume prompt is on its way
  const posting = new Set() // sessions whose phone follow-up is on its way (a second post would send the prompt twice)
  const postKeys = new Map() // idempotency key of an accepted post -> { at, result }: a repeat (the phone's retry after a lost answer) is answered, not prompted again
  let tuning = false // a Tune prompt call is on its way: one at a time per service (each is a paid model call)
  let focusId
  let reading // id of the item being read aloud
  let readOpen = false // the item being read was in the queue when reading started
  let readSeq = 0 // a read that was replaced or stopped must not clear the state of its successor
  let lastReadId // the item the last successful read started on (for "read again")
  const listeners = new Set()
  const emit = () => { for (const l of [...listeners]) { try { l() } catch { /* ignore */ } } }
  // A tip that a model call finished and new session numbers wake the long polls (neither touches the store, so the snapshotId stays).
  try { tips?.onChange?.(emit) } catch { /* the tip is a bonus */ }
  try { sessions?.onChange?.(emit) } catch { /* so are the numbers */ }
  const isTipReading = () => typeof reading === 'string' && reading.startsWith(TIP_READING)
  /** Starts speaking for the reading key (an item id or 'tip:<id>'); the end of that speech clears the state only if nothing replaced it. { ok } | { ok: false, error } */
  const speakAs = (key, chunks, open) => {
    const token = readSeq + 1
    const result = speaker.speak(chunks, {
      onEnd: () => { if (readSeq === token && reading === key) { reading = undefined; emit() } },
    })
    if (!result?.ok) return { ok: false, error: result?.error ?? 'no-speaker' }
    readSeq = token
    reading = key
    readOpen = open
    emit()
    return { ok: true }
  }

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
    // The tip is only on screen while the list is empty: an item arriving ends its reading.
    if (isTipReading() && store.snapshot().open.length) stopReading()
    emit()
  })

  const openItem = (id) => {
    const item = store.get(id)
    return item?.status === 'open' ? item : undefined
  }

  /** A todo has no session of its own yet, whatever its sessionId says. */
  const hasSession = (item) => item.type !== 'todo' && typeof item.sessionId === 'string' && item.sessionId !== ''

  /**
   * Queues the text as a prompt of the item's session; undefined when sent, else the refusal { ok: false, error }. A session this app's controller
   * does not know is no-session; any other controller failure is the fixed code post-failed (its text can carry a path or content and goes to a
   * phone): only its code or name is logged.
   */
  const promptSession = async (item, text) => {
    const body = typeof text === 'string' ? text.trim() : ''
    if (!body) return { ok: false, error: 'empty' }
    if (body.length > MAX_REPLY) return { ok: false, error: 'too-long' }
    const controller = controllerOf()
    if (!controller?.prompt) return { ok: false, error: 'no-controller' }
    try {
      await controller.prompt({ requestId: 'review-' + uuid(), sessionId: item.sessionId, mode: 'queue', content: [{ type: 'text', text: body }] }, AbortSignal.timeout(30_000)) // the Remote method requires a caller signal
    } catch (error) {
      // The controller of this app does not know the session: the card says so in words, and the item stays for an app that does.
      if (error?.code === 'session/not-found') return { ok: false, error: 'no-session' }
      log?.('post: ' + String(error?.code ?? error?.name ?? 'error').slice(0, 40))
      return { ok: false, error: 'post-failed' }
    }
    return undefined
  }

  /** The answer for a key whose first attempt was accepted (and is still remembered), else undefined. */
  const seenPostKey = (key) => {
    const known = key === undefined ? undefined : postKeys.get(key)
    if (!known) return undefined
    if (now() - known.at > POST_KEY_TTL_MS) { postKeys.delete(key); return undefined }
    return { ...known.result, duplicate: true }
  }
  const rememberPostKey = (key, result) => {
    if (key === undefined) return
    postKeys.delete(key)
    postKeys.set(key, { at: now(), result })
    while (postKeys.size > MAX_POST_KEYS) postKeys.delete(postKeys.keys().next().value) // the oldest first (Map keeps insertion order)
  }

  /** A merged-PR item whose session was archived somewhere else (the sidebar menu) has nothing left to offer. */
  const settleArchived = () => {
    let archived
    try { archived = new Set((registryOf()?.archivedSessionIds ?? []).map(String)) } catch { return }
    if (!archived.size) return
    for (const item of store.snapshot().open) if (item.type === 'pr-merged' && archived.has(String(item.sessionId)) && store.resolve(item.id, { kind: 'archived', by: 'elsewhere' })) log?.('service: merged-PR item ' + item.id + ' closed: its session was archived elsewhere')
  }

  /** The tip to show (asking for a new one when it is older than its slot); undefined without a generator or a tip. Never throws. */
  const tipNow = () => { try { return tips?.current() } catch { return undefined } }

  return {
    /**
     * opts.tip === true: the overlay is open, so the tip is wanted (and asked for when the list is empty); without it none is attached and none generated.
     * opts.watch (or tip): somebody looks at the session numbers (the phone, an open overlay), so they are kept fresh.
     */
    snapshot(opts) {
      settleArchived()
      const snap = store.snapshot()
      if (opts?.watch || opts?.tip === true) sessions?.touch()
      const tip = snap.open.length || opts?.tip !== true ? undefined : tipNow() // the tip exists only while nothing is open: nothing is generated for a busy list
      const counts = sessions?.current()
      return {
        ...snap,
        ...(counts ? { sessions: counts } : {}),
        ...(tip ? { tip } : {}),
        serverNow: now(),
        focusId,
        reading,
        ui: { seq: ui.seq, cmd: ui.cmd },
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
      const result = speakAs(id, chunkForSpeech(fullTextFor(item, position)), item.status === 'open')
      if (result.ok) lastReadId = id
      return result
    },
    /**
     * The tip of the day as it is now (see tip.js). The caller decides that the list is empty: the proxy asks it for the merged list in hub mode,
     * where this app's own store may hold less than the list the desktop shows.
     */
    tip: () => tipNow(),
    /** Reads the current tip aloud (title and body) through the same speaker as read(); reading is then 'tip:<id>'. */
    readTip(id) {
      const tip = (() => { try { return tips?.peek() } catch { return undefined } })()
      if (!tip || typeof id !== 'string' || tip.id !== id) return { ok: false, error: 'not-found' }
      if (!speaker) return { ok: false, error: 'no-speaker' }
      return speakAs(TIP_READING + tip.id, chunkForSpeech(tip.title + '. ' + tip.body), false)
    },
    /** Ends the reading of the tip (not of an item): the hub list stopped being empty, so the tip is gone from the screen. */
    stopTip() {
      if (!isTipReading()) return { ok: true, stopped: false }
      stopReading()
      emit()
      return { ok: true, stopped: true }
    },
    /** What is being read aloud now (an item id, or 'tip:<id>'), for the hub view that cannot see this app's own reading. */
    readingId: () => reading,
    /** This app's session numbers { working, open } for the hub agent; undefined while unknown. */
    sessionCounts: () => sessions?.current(),
    /** Somebody looks at the session numbers (the hub says so): keep them fresh for the next minute. */
    watchSessions: () => sessions?.touch(),
    /** Asks the counter for fresh numbers (a timer calls it; the counter caches for 2 s and tells the listeners of a change). */
    refreshSessions: () => sessions?.refresh() ?? Promise.resolve(),
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
        if (error?.name === 'WorkspaceUnknownSessionError') { store.resolve(id, { kind: 'session-ended' }); log?.('service: item ' + id + ' closed as session-ended: DSH does not know its session (archive)'); return { ok: false, error: 'no-session' } }
        return { ok: false, error: String(error?.message ?? error) }
      }
      store.resolve(id, { kind: 'archived', by: 'card' })
      return { ok: true }
    },
    /**
     * Resumes a paused session: prompts the session itself (the same call a reply uses) with the standard resume prompt, queued, then
     * closes the item. The session stays out of the list until its log is written again.
     */
    async resumePaused(id) {
      const item = openItem(id)
      if (!item || resuming.has(id)) return { ok: false, error: 'not-open' }
      if (item.type !== 'paused') return { ok: false, error: 'not-paused' }
      const controller = controllerOf()
      if (!controller?.prompt) return { ok: false, error: 'no-controller' }
      resuming.add(id)
      try {
        const request = { requestId: 'resume-' + uuid(), sessionId: item.sessionId, mode: 'queue', content: [{ type: 'text', text: RESUME_PROMPT }] }
        await controller.prompt(request, AbortSignal.timeout(30_000)) // the Remote method requires a caller signal
      } catch (error) {
        // DSH no longer has the session (deleted): nothing to resume.
        if (error?.code === 'session/not-found') { store.resolve(id, { kind: 'session-ended' }); log?.('service: item ' + id + ' closed as session-ended: DSH no longer has its session (resume)'); return { ok: false, error: 'session-gone' } }
        return { ok: false, error: String(error?.message ?? error) }
      } finally { resuming.delete(id) }
      paused?.markHandled(item)
      store.resolve(id, { kind: 'resumed', by: 'card' })
      return { ok: true }
    },
    /** Dismisses a paused session: it stays out of the list until its log is written again. */
    dismissPaused(id) {
      const item = openItem(id)
      if (!item) return { ok: false, error: 'not-open' }
      if (item.type !== 'paused') return { ok: false, error: 'not-paused' }
      paused?.markHandled(item)
      store.resolve(id, { kind: 'dismissed', by: 'card' })
      return { ok: true }
    },
    /** Looks for sessions cut off by a restart now (the agent also does at startup): { ok, added, updated, resolved, total }. */
    scanPaused: async () => (paused ? paused.scan() : { ok: false, error: 'no-scanner' }),
    /**
     * Pause all and quit: cancels every running top-level session, remembers them (they come back as paused items after the restart) and closes the DSH
     * desktop app. Refused, with nothing paused, when there is no desktop to close. power = { canQuit, pauseSessions, quitSoon } (userpause.js, desktop.js).
     * -> { ok: true, paused, quitting: true } | { ok: false, error }
     */
    async pauseAll() {
      if (typeof power?.pauseSessions !== 'function') return { ok: false, error: 'no-power' }
      if (!(await power.canQuit())) return { ok: false, error: 'no-desktop' }
      let result
      try { result = await power.pauseSessions() } catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 200) } }
      if (!result?.ok) return { ok: false, error: result?.error ?? 'failed' }
      try { await paused?.scan() } catch { /* the next scan after the restart lists them */ }
      power.quitSoon()
      return { ok: true, paused: result.paused, quitting: true }
    },
    /** Quit: closes the DSH desktop app (the Close menu). Running sessions are not paused first; the paused scan lists the cut-off ones after the restart. */
    async quitApp() {
      if (typeof power?.quitSoon !== 'function') return { ok: false, error: 'no-power' }
      if (!(await power.canQuit())) return { ok: false, error: 'no-desktop' }
      power.quitSoon()
      return { ok: true, quitting: true }
    },
    /** Todo (the TODO function): addTodo(text, { workspaceId?, sparc? }) -> { ok, id, state }; confirmTodo(id, { workspaceId? }) also retries a failed one; cancelTodo(id). Background work: todoIdle(). */
    addTodo: (text, opts) => todos.add(text, opts),
    confirmTodo: (id, opts) => todos.confirm(String(id), opts),
    cancelTodo: (id) => todos.cancel(String(id)),
    todoIdle: () => todos.idle(),
    /** The "Tune prompt" button: the text rewritten with the prompt-tune rules, { ok, text } | { ok: false, error }. Adds nothing to the list; this app's own model, so never forwarded to the hub. */
    async tuneTodo(text) {
      const body = typeof text === 'string' ? text.trim() : ''
      if (!body) return { ok: false, error: 'empty' }
      if (body.length > MAX_TODO) return { ok: false, error: 'too-long' }
      if (typeof tuner?.tune !== 'function') return { ok: false, error: 'no model available' }
      if (tuning) return { ok: false, error: 'busy' }
      tuning = true
      try { return await tuner.tune(body) } catch (error) {
        // Security: the provider's message can carry endpoints or key fragments; the client gets a generic text, the detail only the log.
        log?.('service: tune failed: ' + String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300))
        return { ok: false, error: 'LLM error' }
      } finally { tuning = false }
    },
    workspaces: () => todos.workspaces(),
    /** Open items only: how many wait in total and per type. */
    count() {
      const byType = Object.fromEntries(TYPES.map((t) => [t, 0]))
      const all = store.snapshot().open
      for (const item of all) if (item.type in byType && needsUser(item)) byType[item.type]++
      byType.paused = all.filter((i) => i.type === 'paused').length
      return { total: all.filter(needsUser).length, byType }
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
      ui.cmd = cmd
      ui.seq++
      emit()
      return { ok: true, seq: ui.seq }
    },
    /** The show/hide state this service reads and writes (a second view of the same app shares it). */
    uiState: () => ui,
    stop() {
      const was = reading
      stopReading()
      if (was !== undefined) emit()
      return { ok: true }
    },
    /** A misclicked Reviewed, a result replaced by a newer one, or one hidden as needing no action (or trimmed by the per-session cap) goes back into the queue. */
    reopen(id) {
      const item = store.get(id)
      if (!item) return { ok: false, error: 'not-found' }
      const kind = item.resolution?.kind
      if (item.type !== 'completed' || item.status !== 'resolved' || (kind !== 'reviewed' && kind !== 'superseded' && kind !== 'no-action' && kind !== 'trimmed')) return { ok: false, error: 'not-reopenable' }
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
      const refused = await promptSession(item, text)
      if (refused) return refused
      store.resolve(id, { kind: 'replied', by: 'card' })
      return { ok: true }
    },
    /**
     * The chat view of the phone: the last text messages of the session of any item that has one (open or resolved, never a todo), read
     * from the session log. { before, limit } page back (see thread.js). -> { ok, sessionId, title, messages, hasMore, cursor? } or { ok: false, error }.
     * after (a message id, the newest page only, i.e. no before): when the newest message of the log IS that id the answer is { ok: true, unchanged: true } and no
     * page is sent (the phone polls every few seconds; a log that grew or no longer has that message gets the page). The text of a logged message never changes.
     * sessionId is only given by a command of the hub (agent/executor.js): an ownerless open item is read by the coordinator, whose store does not
     * hold it, so the hub names the session (the hub has already refused a todo, hub/routing.js). It is used only when this store has no such item
     * (an empty title then) and only when it is a valid session id (thread.js isSessionId); server.js never passes it on.
     */
    async thread(id, { before, limit, after, sessionId } = {}) {
      const item = store.get(id) ?? (isSessionId(sessionId) ? { sessionId } : undefined)
      if (!item) return { ok: false, error: 'not-found' }
      if (!hasSession(item)) return { ok: false, error: 'no-session' }
      if (typeof threadOf !== 'function') return { ok: false, error: 'no-reader' }
      let read
      try { read = await threadOf({ sessionId: item.sessionId, before, limit }) } catch (error) {
        log?.('thread: ' + String(error?.code ?? error?.name ?? 'error').slice(0, 40)) // the code only: an error message can carry a path or content
        return { ok: false, error: 'unreadable' }
      }
      if (!read?.ok) return { ok: false, error: read?.error ?? 'unreadable' }
      if (!Number.isFinite(before) && Number.isInteger(after) && after >= 0 && read.messages.at(-1)?.id === after) return { ok: true, unchanged: true } // the phone already shows the newest message
      return { ok: true, sessionId: item.sessionId, title: item.sessionTitle ?? '', messages: read.messages, hasMore: read.hasMore, ...(read.cursor === undefined ? {} : { cursor: read.cursor }) }
    },
    /**
     * A follow-up typed into the chat view: queued as a prompt of the item's session like a reply (same limits). An open completed item is
     * resolved as replied, exactly as by reply; any other item (another type, or already resolved) keeps its state. Whatever the item, a session
     * takes one post at a time: while one is on its way another post for the same session id is busy (released when it settles). A paused item
     * takes none: resuming it is done at the PC (resumePaused), whose guard, markHandled and resolve a plain prompt would skip.
     * key (the phone's idempotency key, post-key.js; an invalid one is ignored): a repeat of a key whose first attempt was ACCEPTED is answered
     * { ok: true, duplicate: true } without prompting again, so a retry after a lost answer does not send the message twice. Failed attempts are
     * not remembered; the last 200 keys of the last 10 minutes are kept in memory.
     */
    async post(id, text, { key } = {}) {
      const item = store.get(id)
      if (!item) return { ok: false, error: 'not-found' }
      if (!hasSession(item)) return { ok: false, error: 'not-a-session' }
      if (item.type === 'paused') return { ok: false, error: 'paused' }
      const idem = postKeyOf(key)
      const repeat = seenPostKey(idem)
      if (repeat) return repeat
      if (posting.has(item.sessionId)) return { ok: false, error: 'busy' }
      posting.add(item.sessionId)
      try {
        const refused = await promptSession(item, text)
        if (refused) return refused
        if (openItem(id)?.type === 'completed') store.resolve(id, { kind: 'replied', by: 'card' })
        rememberPostKey(idem, { ok: true })
        return { ok: true }
      } finally { posting.delete(item.sessionId) }
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
