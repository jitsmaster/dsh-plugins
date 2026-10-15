/**
 * The store.js interface over the instance's own local store plus an op log (docs/hub.md 6.1): capture.js, service.js and todo.js
 * keep calling the same synchronous methods, and every change is also recorded as an op for the hub (add, update, resolve, reopen,
 * resolveSession, retitle) with a durable per-instance counter n. The file local/<instanceKey>.json is store.js's v1 file plus
 * { agent: { n, outbox } }, written on every change like store.js does. The hub acknowledges the last applied n (ack); more than
 * maxOutbox unacknowledged ops are dropped in favour of a full sync (needsResync). Items get ids <instance short>-<12 hex>.
 * What the hub changes itself (applyRemote, adopt) is applied without an op.
 */
import { randomBytes } from 'node:crypto'
import { createStore } from '../store.js'

const MAX_OUTBOX = 2000
const MAX_RESOLVED_SYNC = 100
/** Fields the hub owns; an adopted item loses them. */
const HUB_ONLY = ['owner', 'seq', 'status', 'resolvedAt', 'resolution', 'ownerLabel', 'ownerState', 'position']

const safe = (fn, fallback) => { try { return fn() } catch { return fallback } }

/**
 * @param {{ instanceId: string, io?: { read: () => string | undefined, write: (text: string) => void }, legacyRead?: () => string | undefined,
 *   now?: () => number, retentionMs?: number, randomHex?: () => string, maxOutbox?: number }} opts
 */
export function createStoreAdapter({ instanceId, io, legacyRead, now = Date.now, retentionMs, randomHex = () => randomBytes(6).toString('hex'), maxOutbox = MAX_OUTBOX }) {
  const short = String(instanceId).slice(0, 4)
  const inner = createStore({ now, uuid: () => short + '-' + randomHex(), retentionMs })
  const listeners = new Set()
  const opListeners = new Set()
  let n = 0
  let outbox = []
  let resync = false

  // ---- file ----
  const persist = () => { if (io) safe(() => io.write(JSON.stringify({ v: 1, ...inner.dump(), agent: { n, outbox, resync } }))) }
  function load() {
    const text = io ? safe(() => io.read()) : undefined
    const own = parse(text)
    if (own) {
      inner.restore(own)
      const agent = own.agent ?? {}
      n = Number.isInteger(agent.n) && agent.n >= 0 ? agent.n : 0
      outbox = Array.isArray(agent.outbox) ? agent.outbox.filter((o) => Number.isInteger(o?.n)) : []
      resync = agent.resync === true
      return
    }
    if (text === undefined || text === '') {
      const legacy = parse(legacyRead ? safe(() => legacyRead()) : undefined) // read once, never written
      if (legacy) inner.restore(legacy)
    }
  }
  function parse(text) {
    if (!text) return undefined
    return safe(() => { const d = JSON.parse(text); return d && d.v === 1 && Array.isArray(d.items) ? d : undefined }, undefined)
  }
  load()

  /** An item moved here (a phone todo started in a workspace of this app, an item the hub gave this app by its session): applied without an op. */
  function adopt(item) {
    if (inner.get(item.id)) return { ok: true, existing: true }
    const fields = Object.fromEntries(Object.entries(item).filter(([k]) => !HUB_ONLY.includes(k)))
    inner.add(fields, { id: item.id, createdAt: item.createdAt })
    persist()
    return { ok: true }
  }

  const emit = () => { for (const l of [...listeners]) safe(() => l()) }
  inner.onChange(emit)

  function record(op) {
    n++
    outbox.push({ n, ...op })
    if (outbox.length > maxOutbox) { outbox = []; resync = true }
    persist()
    for (const l of [...opListeners]) safe(() => l({ n, ...op }))
  }

  return {
    ...inner,
    add(input, opts) {
      const item = inner.add(input, opts)
      record({ op: 'add', item })
      return item
    },
    update(id, patch) {
      if (!inner.update(id, patch)) return false
      const entries = Object.entries(patch ?? {})
      const unset = entries.filter(([, v]) => v === undefined).map(([k]) => k)
      record({ op: 'update', id, patch: Object.fromEntries(entries.filter(([, v]) => v !== undefined)), ...(unset.length ? { unset } : {}) })
      return true
    },
    resolve(id, resolution) {
      if (!inner.resolve(id, resolution)) return false
      record({ op: 'resolve', id, resolution: inner.get(id).resolution })
      return true
    },
    reopen(id) {
      if (!inner.reopen(id)) return false
      record({ op: 'reopen', id })
      return true
    },
    resolveSession(sessionId, resolution) {
      if (!inner.resolveSession(sessionId, resolution)) return false
      record({ op: 'resolveSession', sessionId, resolution })
      return true
    },
    reconcile(liveIds) {
      const open = inner.list({ status: 'open' }).map((i) => i.id)
      if (!inner.reconcile(liveIds)) return false
      for (const id of open) if (inner.get(id).status === 'resolved') record({ op: 'resolve', id, resolution: { kind: 'session-ended' } })
      return true
    },
    /** A session was renamed: its items (open and resolved) show the new title. */
    retitle(sessionId, title) {
      const ids = inner.list().filter((i) => i.sessionId === sessionId && i.sessionTitle !== title).map((i) => i.id)
      for (const id of ids) inner.update(id, { sessionTitle: title })
      if (ids.length) record({ op: 'retitle', sessionId, title })
      return ids.length > 0
    },
    prune() { inner.prune(); persist() },
    restore(data) { inner.restore(data); persist() },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },

    // ---- the hub's side ----
    onOp(listener) { opListeners.add(listener); return () => { opListeners.delete(listener) } },
    get n() { return n },
    get needsResync() { return resync },
    outbox: () => structuredClone(outbox),
    /** The hub applied every op up to upTo. */
    ack(upTo) { outbox = outbox.filter((o) => o.n > upTo); persist() },
    /** A full sync carried the state as of op upTo: older ops are moot, and so is an overflow. */
    synced(upTo) { outbox = outbox.filter((o) => o.n > upTo); resync = false; persist() },
    /** The owner view for register / resync: open items, the most recently resolved ones, the sessions of the open ones. */
    syncPayload({ maxResolved = MAX_RESOLVED_SYNC } = {}) {
      const openItems = inner.list({ status: 'open' })
      const resolvedItems = inner.list({ status: 'resolved' }).sort((a, b) => b.resolvedAt - a.resolvedAt).slice(0, maxResolved)
      return { n, openItems, resolvedItems, sessionIds: [...new Set(openItems.map((i) => i.sessionId).filter((s) => typeof s === 'string'))] }
    },
    /** A change the hub made (reviewed on the phone, a todo moved away): applied locally, no op. */
    applyRemote(change) {
      if (change?.op === 'resolve') inner.resolve(String(change.id), change.resolution ?? {})
      else if (change?.op === 'reopen') inner.reopen(String(change.id))
      else if (change?.op === 'adopt' && typeof change.item?.id === 'string') return adopt(change.item)
      else if (change?.op === 'drop') {
        const data = inner.dump()
        inner.restore({ seq: data.seq, items: data.items.filter((i) => i.id !== change.id) })
        emit()
      } else return { ok: false, error: 'bad-change' }
      persist()
      return { ok: true }
    },
    adopt,
  }
}
