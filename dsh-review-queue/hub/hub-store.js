/**
 * The hub's item store: the order, snapshot and prune logic of store.js (reused, not copied) plus what only the hub has: an owner
 * per item, a rev that counts changes (the snapshot id is epoch + rev, so it survives a restart), agent-supplied ids and times,
 * and a debounced, atomic file: 200 ms after the last change, never later than 1 s after the first unsaved one, flushed on close.
 * The last good file stays as <name>.bak; a corrupt file is replaced from it. Single writer: only the hub process writes the file.
 */
import { randomUUID } from 'node:crypto'
import { createStore } from '../store.js'

export const QUEUE_VERSION = 2
export const DEBOUNCE_MS = 200
export const MAX_DELAY_MS = 1000
const MAX_CREATED_SKEW_MS = 24 * 3600 * 1000
/** Fields an agent can never set or patch: identity, order, state and ownership belong to the hub. */
export const HUB_FIELDS = ['id', 'seq', 'status', 'owner', 'createdAt', 'resolvedAt', 'resolution']
/** The decision payload of a done card is written only by the app's own triage runner (local store), never by an agent. */
const OPEN_PATCH_BLOCKED = [...HUB_FIELDS, 'decision', '__proto__']
/** An update may carry a new resolution only for an item that is already resolved (a late answer replaces what was recorded). */
const RESOLVED_PATCH_BLOCKED = HUB_FIELDS.filter((k) => k !== 'resolution').concat('decision', '__proto__')

const bad = { ok: false, error: 'bad-op' }
const without = (object, keys) => Object.fromEntries(Object.entries(object).filter(([k]) => !keys.includes(k)))

// Limits of the judge's decision payload (triage-judge.js MAX_DECISION_TEXT, MAX_OPTION, MAX_OPTIONS): the hub accepts nothing wider.
const DECISION_TEXT_MAX = 400
const DECISION_OPTION_MAX = 120
const DECISION_OPTIONS_MAX = 4
/** A decision payload as the owning app's triage runner writes it, or undefined when its shape is not exactly that (nothing is repaired or stringified). */
export function cleanDecision(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined
  if (typeof d.text !== 'string' || !d.text || d.text.length > DECISION_TEXT_MAX) return undefined
  if (!Array.isArray(d.options) || d.options.length > DECISION_OPTIONS_MAX) return undefined
  if (!d.options.every((o) => typeof o === 'string' && o && o.length <= DECISION_OPTION_MAX)) return undefined
  return { text: d.text, options: [...d.options], free: true }
}

/** Texts and option labels of a question item as one comparable string ('' when it has no text): case, spacing and punctuation do not matter, the options do. */
function questionKey(item) {
  const qs = Array.isArray(item?.payload?.questions) ? item.payload.questions : []
  const norm = (t) => String(t ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}/._-]+/gu, ' ').trim()
  const text = qs.map((q) => norm(q?.question)).filter(Boolean).join(' ')
  if (!text || text.length > 600) return ''
  return text + '\n' + qs.map((q) => (Array.isArray(q?.options) ? q.options : []).map((o) => norm(o?.label)).sort().join('|')).join('||')
}

/**
 * @param {{ now?: () => number, uuid?: () => string, io?: { read: (which: 'main' | 'bak') => string | undefined, write: (text: string, opts: { rotate: boolean }) => void },
 *   retentionMs?: number, debounceMs?: number, maxDelayMs?: number, timers?: { setTimeout: Function, clearTimeout: Function }, log?: (line: string) => void }} [opts]
 */
export function createHubStore({ now = Date.now, uuid = () => randomUUID().slice(0, 12), io, retentionMs, debounceMs = DEBOUNCE_MS, maxDelayMs = MAX_DELAY_MS, timers = globalThis, log = () => {} } = {}) {
  const inner = createStore({ now, uuid, retentionMs })
  const listeners = new Set()
  let epoch = uuid()
  let rev = 0
  let instances = []
  let loadedFrom = 'empty'
  let dirty = false
  let firstDirtyAt = 0
  let timer
  let closed = false
  let rotate = false // the file on disk is a known-good one, so the next write may keep it as .bak
  const stats = { writes: 0, failures: 0, lastBytes: 0, lastMs: 0 }

  // ---- load: main file, else .bak, else empty ----
  function parse(text) {
    if (!text) return undefined
    try {
      const data = JSON.parse(text)
      return data && data.v === QUEUE_VERSION && Array.isArray(data.items) ? data : undefined
    } catch { return undefined }
  }
  function load() {
    if (!io) return
    for (const which of ['main', 'bak']) {
      const data = parse(io.read(which))
      if (!data) continue
      inner.restore(data)
      if (typeof data.epoch === 'string' && data.epoch) epoch = data.epoch
      rev = Number.isInteger(data.rev) && data.rev >= 0 ? data.rev : 0
      instances = Array.isArray(data.instances) ? data.instances : []
      loadedFrom = which
      rotate = which === 'main'
      if (which === 'bak') log('queue file unreadable, recovered from the last good copy (' + inner.list().length + ' items)')
      return
    }
    if (io.read('main') !== undefined || io.read('bak') !== undefined) log('queue files unreadable, starting empty')
  }
  load()

  // ---- debounced persistence ----
  function schedule() {
    const t = now()
    if (!dirty) { dirty = true; firstDirtyAt = t }
    const delay = Math.max(0, Math.min(debounceMs, maxDelayMs - (t - firstDirtyAt)))
    timers.clearTimeout(timer)
    timer = timers.setTimeout(flush, delay)
    timer.unref?.()
  }

  function flush() {
    timers.clearTimeout(timer)
    timer = undefined
    if (!dirty || !io) return
    const started = performance.now()
    try {
      const text = JSON.stringify({ v: QUEUE_VERSION, epoch, ...inner.dump(), rev, instances })
      io.write(text, { rotate })
      dirty = false
      rotate = true
      stats.writes++
      stats.lastBytes = text.length
      stats.lastMs = performance.now() - started
    } catch (error) {
      stats.failures++
      log('queue file not written: ' + String(error?.code ?? error?.name ?? 'error'))
      if (!closed) schedule()
    }
  }

  inner.onChange(() => {
    rev++
    schedule()
    for (const listener of [...listeners]) {
      try { listener() } catch { /* one bad listener must not stop the others */ }
    }
  })

  const clamp = (createdAt) => {
    const t = now()
    return Number.isFinite(createdAt) ? Math.min(t, Math.max(t - MAX_CREATED_SKEW_MS, createdAt)) : t
  }
  const ownedBy = (item, owner) => owner === undefined || item.owner === owner

  /**
   * A question of a session that another instance (an app restarted under a new key) already has open, with the same text and options,
   * is a repeat: the older copy is superseded by the new one. Same-owner repeats are the app's own question merge's business.
   */
  function mergeAcrossOwners(id) {
    const added = inner.get(id)
    if (added?.type !== 'question' || typeof added.sessionId !== 'string') return
    const text = questionKey(added)
    if (!text) return
    let count = added.merged?.count ?? 1
    let merged = false
    for (const old of inner.list({ status: 'open' })) {
      if (old.id === id || old.type !== 'question' || old.sessionId !== added.sessionId || old.owner === added.owner) continue
      if (questionKey(old) !== text) continue
      if (!inner.resolve(old.id, { kind: 'superseded', by: 'merge', into: id })) continue
      count += old.merged?.count ?? 1
      merged = true
    }
    if (merged) inner.update(id, { merged: { count } })
  }

  const ops = {
    add(op, owner, trusted) {
      if (!op.item || typeof op.item !== 'object' || typeof op.item.type !== 'string') return bad
      const id = typeof op.item.id === 'string' && op.item.id ? op.item.id : uuid()
      const existing = inner.get(id)
      if (existing) return existing.owner === owner ? { ok: true, id, duplicate: true } : { ok: false, error: 'id-conflict' }
      const decision = trusted ? cleanDecision(op.item.decision) : undefined // only the owning app's own sync may carry a decision, and only a well-formed one
      inner.add({ ...without(op.item, OPEN_PATCH_BLOCKED), ...(decision ? { decision } : {}), owner }, { id, createdAt: clamp(op.item.createdAt) })
      mergeAcrossOwners(id)
      return { ok: true, id }
    },
    update(op, owner, trusted) {
      const item = inner.get(op.id)
      if (!item) return { ok: false, error: 'not-found' }
      if (!ownedBy(item, owner)) return { ok: false, error: 'not-owner' }
      const patch = without(op.patch ?? {}, item.status === 'resolved' ? RESOLVED_PATCH_BLOCKED : OPEN_PATCH_BLOCKED)
      const decision = trusted ? cleanDecision(op.patch?.decision) : undefined
      const unsetDecision = trusted === true && Array.isArray(op.unset) && op.unset.includes('decision')
      const unset = (Array.isArray(op.unset) ? op.unset : []).filter((k) => typeof k === 'string' && !OPEN_PATCH_BLOCKED.includes(k))
      if (unsetDecision) unset.push('decision')
      inner.update(op.id, { ...patch, ...(decision ? { decision } : {}), ...Object.fromEntries(unset.map((k) => [k, undefined])) })
      return { ok: true }
    },
    resolve(op, owner) {
      const item = inner.get(op.id)
      if (!item) return { ok: false, error: 'not-found' }
      if (!ownedBy(item, owner)) return { ok: false, error: 'not-owner' }
      return inner.resolve(op.id, op.resolution ?? {}) ? { ok: true } : { ok: false, error: 'not-open' }
    },
    reopen(op, owner) {
      const item = inner.get(op.id)
      if (!item) return { ok: false, error: 'not-found' }
      if (!ownedBy(item, owner)) return { ok: false, error: 'not-owner' }
      return inner.reopen(op.id) ? { ok: true } : { ok: false, error: 'not-reopenable' }
    },
    resolveSession(op, owner) {
      const sessionId = String(op.sessionId)
      if (owner === undefined) return { ok: true, changed: inner.resolveSession(sessionId, op.resolution ?? {}) }
      let changed = false
      for (const item of inner.list({ status: 'open' })) {
        if (item.sessionId === sessionId && item.owner === owner && inner.resolve(item.id, op.resolution ?? {})) changed = true
      }
      return { ok: true, changed }
    },
    /** The session was renamed: every item of the owner for that session shows the new title. */
    retitle(op, owner) {
      if (typeof op.sessionId !== 'string' || typeof op.title !== 'string') return bad
      let changed = 0
      for (const item of inner.list()) {
        if (item.sessionId === op.sessionId && ownedBy(item, owner) && item.sessionTitle !== op.title && inner.update(item.id, { sessionTitle: op.title })) changed++
      }
      return { ok: true, changed }
    },
  }

  return {
    /** Apply one agent op (add, update, resolve, reopen, resolveSession, retitle) for owner; answers { ok, ... } with an error code on refusal. */
    applyOp(op, { owner, trusted } = {}) {
      const run = op && typeof op === 'object' && Object.hasOwn(ops, op.op) ? ops[op.op] : undefined
      return run ? run(op, owner, trusted === true) : bad
    },
    get: (id) => inner.get(id),
    list: (filter) => inner.list(filter),
    /** store.js count: how many (live, not copied) items a test accepts. */
    count: (test) => inner.count(test),
    /** Move an item to another instance (adoption, a todo started elsewhere). */
    setOwner: (id, owner) => inner.update(id, { owner }),
    /** A change the hub itself makes to an item (a follow-up whose send has an unknown outcome is marked failed); false when the id is unknown. */
    update: (id, patch) => inner.update(id, patch),
    /** The store.js snapshot with the hub's snapshot id (epoch + rev). */
    snapshot() {
      return { ...inner.snapshot(), snapshotId: epoch + ':' + rev, rev }
    },
    isCurrent: (snapshotId) => snapshotId === epoch + ':' + rev,
    /** Hub-local transitions (reviewed, reopen, a stale owner's items): the same rules as store.js. */
    resolve: (id, resolution) => inner.resolve(id, resolution),
    reopen: (id) => inner.reopen(id),
    prune: () => inner.prune(),
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getInstances: () => structuredClone(instances),
    setInstances(list) { instances = structuredClone(list); rev++; schedule() },
    /** Write now (also when nothing changed, when force is set: the first start of a hub). */
    flush(force = false) { if (force && io) { dirty = true } flush() },
    close() { closed = true; flush() },
    get rev() { return rev },
    get epoch() { return epoch },
    get loadedFrom() { return loadedFrom },
    stats,
  }
}
