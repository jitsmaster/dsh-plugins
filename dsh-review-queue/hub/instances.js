/**
 * The instance registry of the hub (docs/hub.md 6.3): which DSH app owns which items and whether it is still there.
 * online -> away (no poll for AWAY_MS) -> gone (no sign of life for GRACE_MS); a gone owner's questions and permissions end as
 * session-ended (by 'hub'), its other items stay as orphans for ORPHAN_KEEP_MS. A restarted app (same key, new id) has its dead
 * promises ended and its remaining items adopted; the same process coming back (hub restart, sleep) revives what the hub ended.
 * A hub start counts as a sign of life for every persisted instance, so agents get GRACE_MS to reconnect.
 * Adoption by session id: an open completed / pr-merged / todo item with no owner (legacy import) or a gone owner belongs to the ONLINE
 * instance that reports its session at register or sync. The answer to that register / sync carries the adopted items (adoptedItems),
 * because the new owner has no local copy; an item stays on the instance's handed list, and is handed again, until the instance lists it.
 * Session numbers: an app reports "N working / M open" with its register and with presence when they change (an old agent reports none and adds 0);
 * sessionsTotal() sums the apps that are online, and onSessions is called when that sum changes (it never touches the item store or its snapshot id).
 */
import { sessionsKey } from '../sessions.js'
import { HUB_FIELDS } from './hub-store.js'

export const AWAY_MS = 45_000
export const GRACE_MS = 120_000
export const ORPHAN_KEEP_MS = 24 * 3600 * 1000

const ID = /^[A-Za-z0-9]{4,32}$/
const ENDED = new Set(['question', 'permission'])
/** Only work that outlives its process can change hands: a question or permission died with the app that held its promise. */
const ADOPTABLE = new Set(['completed', 'pr-merged', 'todo'])
const BLOCKED = [...HUB_FIELDS, '__proto__']
const short = (id) => id.slice(0, 4)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const items = (v) => (Array.isArray(v) ? v.filter((i) => i && typeof i.id === 'string' && typeof i.type === 'string') : [])
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [])
/** The numbers an app reports, or undefined: whole numbers, working not above open, nothing absurd. A copy, never the caller's object. */
const MAX_SESSIONS = 100_000
const cleanSessions = (v) => (Number.isInteger(v?.working) && Number.isInteger(v?.open) && v.working >= 0 && v.working <= v.open && v.open <= MAX_SESSIONS ? { working: v.working, open: v.open } : undefined)
const cleanWorkspaces = (v) => (Array.isArray(v) ? v : []).filter((w) => w && typeof w.id === 'string' && w.id).map((w) => ({
  id: w.id, title: typeof w.title === 'string' && w.title ? w.title : w.id, path: typeof w.path === 'string' ? w.path : '', sessionIds: strings(w.sessionIds),
}))

/** @param {{ store: any, commands: any, now?: () => number, log?: (line: string) => void, awayMs?: number, graceMs?: number, orphanKeepMs?: number }} deps */
export function createInstances({ store, commands, now = Date.now, log = () => {}, awayMs = AWAY_MS, graceMs = GRACE_MS, orphanKeepMs = ORPHAN_KEEP_MS, onSessions = () => {} }) {
  const byId = new Map()
  const keyToId = new Map()

  const blank = (key, id) => ({
    key, id, label: '', pid: undefined, protocol: undefined, pluginVersion: undefined, state: 'online', registered: false, lastPollAt: 0, pollsOpen: 0, lastSeenAt: 0,
    goneAt: undefined, supersededBy: undefined, lastOp: 0, workspaces: [], sessionIds: [], sessions: undefined, lastDesktopActiveAt: undefined, handed: new Set(),
  })
  const newOut = () => ({ ok: true, adopted: 0, revived: 0, ended: 0, orphans: 0, foreign: [], resolved: [], adoptedItems: [], lastOp: 0 })
  /** No owner, an owner the hub forgot or one that is gone: nobody can run actions on the item. An away owner may still come back. */
  const ownerAbsent = (owner) => owner === undefined || byId.get(owner)?.state === 'gone' || !byId.has(owner)
  /** Hand the item to the instance (once per answer); it stays on the handed list until the instance lists it in a sync. */
  const handOver = (inst, item, out) => {
    inst.handed.add(item.id)
    if (!out.adoptedItems.some((i) => i.id === item.id)) out.adoptedItems.push(item)
  }
  const online = () => [...byId.values()].filter((i) => i.registered && i.state === 'online')
  /** The sum over the online apps that report numbers; undefined when none does (unknown, not zero). */
  const total = () => {
    const reporting = online().filter((i) => i.sessions)
    return reporting.length ? { working: reporting.reduce((n, i) => n + i.sessions.working, 0), open: reporting.reduce((n, i) => n + i.sessions.open, 0) } : undefined
  }
  let told = '' // the sum the listeners last heard of
  const notifySessions = () => {
    const t = total()
    const key = sessionsKey(t)
    if (key === told) return
    told = key
    try { onSessions(t) } catch { /* one bad listener must not stop the hub */ }
  }
  const live = (id) => { const i = byId.get(id); return i?.registered && i.state !== 'gone' ? i : undefined }
  const persist = () => store.setInstances([...byId.values()].map(({ key, id, label, state, lastSeenAt, goneAt }) => ({ key, id, label, state, lastSeenAt, goneAt })))

  // A persisted instance is away until it registers again; the hub start is its last sign of life.
  for (const p of store.getInstances()) {
    if (typeof p?.key !== 'string' || typeof p.id !== 'string') continue
    const inst = blank(p.key, p.id)
    const gone = p.state === 'gone'
    Object.assign(inst, { label: p.label ?? '', state: gone ? 'gone' : 'away', goneAt: gone ? p.goneAt ?? now() : undefined, lastSeenAt: gone ? p.lastSeenAt ?? now() : now(), lastPollAt: now() })
    byId.set(inst.id, inst)
    keyToId.set(inst.key, inst.id)
  }

  /** The hub ends an item by itself: it says which and why in its log. */
  function endItem(item, reason) {
    if (!store.resolve(item.id, { kind: 'session-ended', by: 'hub', reason })) return false
    log('session-ended ' + item.type + ' ' + item.id + ' (' + reason + ')')
    return true
  }

  /** Questions and permissions of an owner whose process is gone can never be answered. Idempotent. */
  function settle(inst, reason) {
    let ended = 0
    for (const item of store.list({ status: 'open' })) {
      if (item.owner === inst.id && ENDED.has(item.type) && endItem(item, reason)) ended++
    }
    return ended
  }
  function goneNow(inst, reason) {
    const ended = settle(inst, reason)
    inst.state = 'gone'
    inst.goneAt = now()
    commands.failInstance(inst.id)
    return ended
  }

  // ---- sync: the owner's view of its items (register carries one, resync sends one) ----
  function patchFor(cur, it) {
    const patch = Object.fromEntries(Object.entries(it).filter(([k, v]) => !BLOCKED.includes(k) && !same(v, cur[k])))
    const unset = Object.keys(cur).filter((k) => !BLOCKED.includes(k) && !(k in it) && cur[k] !== undefined)
    return Object.keys(patch).length || unset.length ? { op: 'update', id: cur.id, patch, unset } : undefined
  }
  function syncOpen(inst, it, out) {
    const cur = store.get(it.id)
    if (!cur) { store.applyOp({ op: 'add', item: it }, { owner: inst.id }); return }
    if (cur.owner !== inst.id) { out.foreign.push(it.id); return }
    if (cur.status === 'resolved') {
      if (cur.resolution?.by !== 'hub') { out.resolved.push({ id: cur.id, resolution: cur.resolution }); return }
      store.reopen(cur.id)
      out.revived++
    }
    const update = patchFor(store.get(it.id), it)
    if (update) store.applyOp(update, { owner: inst.id })
  }
  function syncResolved(inst, it, out) {
    const cur = store.get(it.id)
    const resolution = it.resolution ?? { kind: 'resolved' }
    if (!cur) {
      if (store.applyOp({ op: 'add', item: it }, { owner: inst.id }).ok) store.applyOp({ op: 'resolve', id: it.id, resolution }, { owner: inst.id })
    } else if (cur.owner !== inst.id) out.foreign.push(it.id)
    else if (cur.status === 'open') store.applyOp({ op: 'resolve', id: it.id, resolution }, { owner: inst.id })
  }
  function processSync(inst, sync, out) {
    const open = items(sync.openItems)
    const resolved = items(sync.resolvedItems)
    const mentioned = new Set([...open, ...resolved].map((i) => i.id))
    for (const it of open) syncOpen(inst, it, out)
    for (const it of resolved) syncResolved(inst, it, out)
    for (const id of mentioned) inst.handed.delete(id)
    for (const cur of store.list({ status: 'open' })) {
      if (cur.owner !== inst.id || mentioned.has(cur.id)) continue
      if (inst.handed.has(cur.id)) { handOver(inst, cur, out); continue } // the app never got it (a lost answer): hand it over again
      if (endItem(cur, 'not-in-sync')) out.ended++
    }
    inst.sessionIds = strings(sync.sessionIds)
    inst.workspaces = cleanWorkspaces(sync.workspaces)
    adoptBySession(inst, out)
    for (const id of [...inst.handed]) { const cur = store.get(id); if (cur?.status !== 'open' || cur.owner !== inst.id) inst.handed.delete(id) }
    if (Number.isInteger(sync.n) && sync.n >= 0) inst.lastOp = sync.n
  }

  /** Items nobody can act on (no owner, or a gone one) whose session this online instance reports become its own. */
  function adoptBySession(inst, out) {
    const known = new Set(inst.sessionIds)
    let n = 0
    for (const cur of store.list({ status: 'open' })) {
      if (!ADOPTABLE.has(cur.type) || !known.has(cur.sessionId) || cur.owner === inst.id || !ownerAbsent(cur.owner)) continue
      if (!store.setOwner(cur.id, inst.id)) continue
      handOver(inst, store.get(cur.id), out)
      n++
    }
    out.orphans += n
    if (n) log('adopted ' + n + ' by session')
  }

  /** The app was restarted: what only its dead process could answer ends, the rest moves to the new instance. */
  function replace(prev, id, out) {
    out.ended += settle(prev, 'restarted')
    const next = byId.get(id) ?? blank(prev.key, id)
    for (const item of store.list({ status: 'open' })) {
      if (item.owner !== prev.id || !store.setOwner(item.id, id)) continue
      out.adopted++
      handOver(next, store.get(item.id), out)
    }
    byId.set(id, next)
    prev.state = 'gone'
    prev.goneAt = now()
    prev.supersededBy = id
    commands.failInstance(prev.id)
  }

  function expireOrphans(inst) {
    for (const item of store.list({ status: 'open' })) if (item.owner === inst.id) endItem(item, 'orphan-expired')
  }

  const instances = {
    /** @returns {{ ok: true, adopted: number, revived: number, ended: number, orphans: number, foreign: string[], resolved: any[], adoptedItems: any[], lastOp: number } | { ok: false, error: string }} */
    register({ key, id, label, pid, protocol, pluginVersion, sync, sessions } = {}) {
      if (typeof key !== 'string' || !key || key.length > 200 || typeof id !== 'string' || !ID.test(id)) return { ok: false, error: 'bad-instance' }
      const existing = byId.get(id)
      if (existing && (existing.key !== key || existing.supersededBy)) return { ok: false, error: existing.key !== key ? 'bad-instance' : 'superseded' }
      const out = newOut()
      const prev = byId.get(keyToId.get(key))
      if (prev && prev.id !== id) replace(prev, id, out)
      const inst = existing ?? byId.get(id) ?? blank(key, id)
      Object.assign(inst, { label: typeof label === 'string' && label ? label.slice(0, 80) : 'DSH', pid, protocol, pluginVersion, state: 'online', registered: true, pollsOpen: 0, lastPollAt: now(), lastSeenAt: now(), goneAt: undefined })
      byId.set(id, inst)
      keyToId.set(key, id)
      if (sync && typeof sync === 'object') processSync(inst, sync, out)
      inst.sessions = cleanSessions(sessions) // a re-register without numbers (an old agent) forgets the old ones
      persist()
      notifySessions()
      out.lastOp = inst.lastOp
      return out
    },

    /** A long poll opens: the instance is polling for as long as it stays open. */
    pollOpen(id) {
      const inst = live(id)
      if (!inst) return undefined
      inst.pollsOpen++
      inst.lastPollAt = inst.lastSeenAt = now()
      if (inst.state === 'away') { inst.state = 'online'; persist(); notifySessions() }
      return inst
    },
    pollClose(id) {
      const inst = byId.get(id)
      if (!inst) return
      inst.pollsOpen = Math.max(0, inst.pollsOpen - 1)
      inst.lastPollAt = inst.lastSeenAt = now()
    },
    /** Any request of the instance is a sign of life (it keeps an away instance from going gone, but is not polling). */
    touch(id) {
      const inst = live(id)
      if (inst) inst.lastSeenAt = now()
      return inst
    },
    presence(id, { desktopActive, sessions } = {}) {
      const inst = instances.touch(id)
      if (inst && desktopActive === true) inst.lastDesktopActiveAt = now()
      const clean = cleanSessions(sessions)
      if (inst && clean) { inst.sessions = clean; notifySessions() }
      return inst
    },

    /** "N working / M open" summed over the online apps, or undefined when none reports. */
    sessionsTotal: total,

    /** Every 10 s: away, gone (settle), expired orphans, forgotten superseded instances. */
    tick() {
      const t = now()
      let changed = false
      for (const inst of [...byId.values()]) {
        if (inst.state === 'online' && inst.pollsOpen === 0 && t - inst.lastPollAt > awayMs) { inst.state = 'away'; changed = true }
        if (inst.state === 'away' && inst.pollsOpen === 0 && t - inst.lastSeenAt > graceMs) { goneNow(inst, 'owner-gone'); changed = true; log('instance gone (' + inst.id + ')') }
        if (inst.state !== 'gone' || inst.goneAt === undefined || t - inst.goneAt < orphanKeepMs) continue
        expireOrphans(inst)
        if (inst.supersededBy && !store.list().some((i) => i.owner === inst.id)) { byId.delete(inst.id); changed = true }
      }
      if (changed) { persist(); notifySessions() }
    },

    /** Graceful end (the app's cleanup): its questions and permissions end now, the rest stays as orphans. */
    bye(id) {
      const inst = byId.get(id)
      if (!inst) return { ok: false, error: 'unknown-instance' }
      goneNow(inst, 'owner-gone')
      persist()
      notifySessions()
      return { ok: true }
    },

    /** A sync outside of a register (after a 409 resync-needed): the same owner view, answered like register. */
    sync(id, sync) {
      const inst = live(id)
      if (!inst) return { ok: false, error: 'unknown-instance' }
      const out = newOut()
      processSync(inst, sync && typeof sync === 'object' ? sync : {}, out)
      inst.lastSeenAt = now()
      out.lastOp = inst.lastOp
      return out
    },

    /** Label and state of an owner for the snapshot; an unknown or missing owner is gone. */
    view(owner) {
      const inst = byId.get(owner)
      return inst ? { label: inst.label, state: inst.state } : { state: 'gone' }
    },

    /** The union of the workspaces of the online instances: ids are "<instance short>/<workspace id>", the caller's own first. */
    workspaces({ caller, full = false } = {}) {
      const list = online()
      const many = list.length > 1
      const ordered = [...list.filter((i) => i.id === caller), ...list.filter((i) => i.id !== caller)]
      return ordered.flatMap((inst) => inst.workspaces.map((ws) => {
        const suffix = inst.id !== caller && (caller !== undefined || many) ? ' (' + inst.label + ')' : ''
        const entry = { id: short(inst.id) + '/' + ws.id, title: ws.title + suffix }
        return full ? { ...entry, path: ws.path, sessionIds: ws.sessionIds, instanceId: inst.id, workspaceId: ws.id } : entry
      }))
    },

    /** Who runs the model pass for a phone todo: the caller when it is online, else the most recently desktop-active online instance. */
    coordinator(caller) {
      const mine = byId.get(caller)
      if (mine?.registered && mine.state === 'online') return mine
      return online().sort((a, b) => (b.lastDesktopActiveAt ?? -1) - (a.lastDesktopActiveAt ?? -1) || b.lastSeenAt - a.lastSeenAt)[0]
    },

    get: (id) => byId.get(id),
    byKey: (key) => byId.get(keyToId.get(key)),
    list: () => [...byId.values()],
    live,
    short,
  }
  return instances
}
