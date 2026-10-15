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
/** An update may carry a new resolution only for an item that is already resolved (a late answer replaces what was recorded). */
const OPEN_PATCH_BLOCKED = [...HUB_FIELDS, '__proto__']
const RESOLVED_PATCH_BLOCKED = HUB_FIELDS.filter((k) => k !== 'resolution').concat('__proto__')

const bad = { ok: false, error: 'bad-op' }
const without = (object, keys) => Object.fromEntries(Object.entries(object).filter(([k]) => !keys.includes(k)))

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

  const ops = {
    add(op, owner) {
      if (!op.item || typeof op.item !== 'object' || typeof op.item.type !== 'string') return bad
      const id = typeof op.item.id === 'string' && op.item.id ? op.item.id : uuid()
      const existing = inner.get(id)
      if (existing) return existing.owner === owner ? { ok: true, id, duplicate: true } : { ok: false, error: 'id-conflict' }
      inner.add({ ...without(op.item, OPEN_PATCH_BLOCKED), owner }, { id, createdAt: clamp(op.item.createdAt) })
      return { ok: true, id }
    },
    update(op, owner) {
      const item = inner.get(op.id)
      if (!item) return { ok: false, error: 'not-found' }
      if (!ownedBy(item, owner)) return { ok: false, error: 'not-owner' }
      const patch = without(op.patch ?? {}, item.status === 'resolved' ? RESOLVED_PATCH_BLOCKED : OPEN_PATCH_BLOCKED)
      const unset = (Array.isArray(op.unset) ? op.unset : []).filter((k) => typeof k === 'string' && !OPEN_PATCH_BLOCKED.includes(k))
      inner.update(op.id, { ...patch, ...Object.fromEntries(unset.map((k) => [k, undefined])) })
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
    applyOp(op, { owner } = {}) {
      const run = op && typeof op === 'object' && Object.hasOwn(ops, op.op) ? ops[op.op] : undefined
      return run ? run(op, owner) : bad
    },
    get: (id) => inner.get(id),
    list: (filter) => inner.list(filter),
    /** Move an item to another instance (adoption, a todo started elsewhere). */
    setOwner: (id, owner) => inner.update(id, { owner }),
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
