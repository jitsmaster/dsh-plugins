/**
 * Action routing of the hub (docs/hub.md 6.2): the same URL actions as server.js, but item actions are checked here (via comes
 * from the credential, never the body; the phone's confirm / hold; risky never as "similar") and then run by the owning app as a
 * command. reviewed and reopen are hub-local transitions and only tell the owner. Todos are routed by workspace owner.
 * Answers { ok, ... } with the error codes server.js outcome() maps (owner-offline, owner-away, owner-timeout, unknown-outcome).
 * An open item without an owner (the legacy import) whose session no app reports is tried by the coordinator: it is handed the item and
 * becomes its owner, or answers no-session, which the card gets as session-unavailable (the item stays ownerless). A post is only taken that
 * way for a done item (it resolves it); to any other ownerless open item it answers session-unavailable at once. open-session and thread
 * (a view and a read) are only sent to the coordinator: it is not handed the item and does not become its owner. thread and post of a todo are
 * refused here (no-session, not-a-session) before anything is sent: the coordinator, which does not hold the item, could not tell. The same two are refused to a
 * phone for a follow-up todo that was already sent (it has a session, but a phone gets no chat view of it); the desktop still reaches it.
 * A todo with body.followUp is a follow-up for an existing session of any app (hub/follow-up.js).
 * A paused item whose owner is GONE (the app that scanned it was stopped or restarted, so its instance key changed) is handled like an ownerless one for
 * paused-resume / paused-dismiss: the coordinator takes it and runs the action; on a refusal the item goes back to its previous owner. An owner that is only
 * away is not robbed (owner-away), and with no app online it stays owner-offline.
 */
import { riskOf } from '../risk.js'
import { postKeyOf } from '../post-key.js'
import { createHubFollowUps } from './follow-up.js'
import { isSentFollowUp } from '../follow-up-shared.js'

const HUB_LOCAL = ['reviewed', 'reopen']
const PAUSED_ACTIONS = ['paused-resume', 'paused-dismiss']
/** Value: the item must still be open (an expired question can still be answered late, any session can be opened, the chat of a finished item can be read and continued). */
const OWNER_ACTIONS = { answer: true, approve: true, 'approve-similar': true, deny: true, reply: true, archive: true, 'paused-resume': true, 'paused-dismiss': true, hold: true, 'hold-release': true, 'hold-continue': true, 'todo-confirm': true, 'todo-cancel': true, 'late-answer': false, 'open-session': false, thread: false, post: false }
export const ACTION_KINDS = [...HUB_LOCAL, 'todo', ...Object.keys(OWNER_ACTIONS)]

const risksOf = (item) => (item.type === 'permission' ? riskOf({ toolName: item.payload?.toolName, detail: item.payload?.detail ?? item.payload?.summary, path: item.payload?.path, workspace: item.workspace }) : [])
const text = (v) => (v === undefined || v === null || v === '' ? undefined : String(v))

/** @param {{ store: any, queue: any, instances: any, commands: any, log?: (line: string) => void }} deps */
export function createRouting({ store, queue, instances, commands, log = () => {}, now = Date.now }) {
  /** The owner as a send target: its state decides between a command and 409 owner-offline / owner-away. */
  function reachable(owner) {
    const inst = instances.get(owner)
    if (!inst || inst.state === 'gone') return { error: 'owner-offline' }
    if (inst.state === 'away') return { error: 'owner-away' }
    return { inst }
  }
  const send = (inst, command) => commands.enqueue(inst.id, command)
  const tell = (owner, change) => { if (instances.live(owner)) void commands.enqueue(owner, { kind: 'apply', args: { change }, wait: false }) }
  const followUps = createHubFollowUps({ store, instances, reachable, send, tell, log, now }) // Follow-up todos: a message for an existing session of any app (hub/follow-up.js)

  function hubLocal(kind, id) {
    const result = kind === 'reviewed' ? queue.markReviewed(id) : queue.reopen(id)
    const item = store.get(id)
    if (result.ok && item?.owner) tell(item.owner, kind === 'reviewed' ? { op: 'resolve', id, resolution: item.resolution } : { op: 'reopen', id })
    return result
  }

  /** The phone's checks (D8). Returns an error result, or undefined to go on. */
  function guard(kind, item, body, via) {
    if (kind !== 'approve' && kind !== 'approve-similar') return undefined
    const risky = risksOf(item).length > 0
    if (via === 'phone' && (kind === 'approve-similar' || item.type === 'permission') && body.confirmed !== true) return { ok: false, error: 'needs-confirm' }
    if (kind === 'approve-similar') return item.type === 'permission' && risky ? { ok: false, error: 'risky' } : undefined
    if (via === 'phone' && item.type === 'permission' && risky && body.held !== true) return { ok: false, error: 'needs-hold' }
    return undefined
  }
  const argsFor = (kind, body, via, item) => ({
    answer: { answers: body.answers }, 'late-answer': { answers: body.answers },
    approve: { via, confirmed: body.confirmed === true, held: body.held === true }, 'approve-similar': { via, confirmed: body.confirmed === true },
    reply: { text: body.text }, hold: { reason: body.reason }, 'open-session': { sessionId: item.sessionId }, thread: { before: body.before, limit: body.limit, after: body.after, sessionId: item.sessionId }, post: { text: body.text, ...(postKeyOf(body.key) === undefined ? {} : { key: body.key }) },
  })[kind] ?? {}

  /**
   * A workspace id of the union ("<short>/<id>") to its instance, or undefined. The short part is the id of one start of an app, so a card that
   * waited over a restart carries one nobody has any more: then the workspace id alone finds the app, but only when exactly one app lists it.
   */
  function findWorkspace(wanted) {
    const slash = wanted.indexOf('/')
    if (slash < 0) return undefined
    const [prefix, local] = [wanted.slice(0, slash), wanted.slice(slash + 1)]
    const live = instances.list().filter((i) => i.registered && i.state !== 'gone')
    const listing = (i) => i.workspaces.some((x) => x.id === local)
    const named = live.filter((i) => instances.short(i.id) === prefix)
    const candidates = named.length ? named.filter(listing) : live.filter(listing)
    return candidates.length === 1 ? { inst: candidates[0], workspaceId: local } : undefined
  }

  /** The coordinator takes an ownerless open item (it is handed a copy first, commands of one app run in order), runs the action and keeps it on success. */
  /** A paused card whose owner is gone: nobody can run resume / dismiss there, any online app can (it has the session log on the same machine). */
  const goneOwnedPaused = (kind, item) => item.type === 'paused' && PAUSED_ACTIONS.includes(kind) && (instances.get(item.owner)?.state ?? 'gone') === 'gone'

  async function actOnOrphan(kind, item, body, via, caller) {
    // A post resolves only a done item (as replied), so only that one is worth taking: any other type would be adopted without anything to show for it.
    if (kind === 'post' && item.type !== 'completed') return { ok: false, error: 'session-unavailable' }
    const coordinator = instances.coordinator(caller)
    if (!coordinator) return { ok: false, error: 'owner-offline' }
    if (kind === 'open-session' || kind === 'thread') return send(coordinator, { kind, itemId: item.id, args: argsFor(kind, body, via, item) }) // a view or a read: the item is not adopted
    const previous = item.owner // undefined for an ownerless item, the gone app for a paused one
    store.setOwner(item.id, coordinator.id)
    void commands.enqueue(coordinator.id, { kind: 'apply', args: { change: { op: 'adopt', item: store.get(item.id) } }, wait: false })
    const result = await runOwned(kind, store.get(item.id), body, via)
    if (result.ok) return result
    store.setOwner(item.id, previous)
    return result.error === 'no-session' ? { ok: false, error: 'session-unavailable' } : result
  }

  async function runOwned(kind, item, body, via) {
    if (kind === 'todo-confirm') return confirmTodo(item, body)
    const to = reachable(item.owner)
    if (to.error) return { ok: false, error: to.error }
    return send(to.inst, { kind, itemId: item.id, args: argsFor(kind, body, via, item) })
  }

  async function addTodo(body, caller, role) {
    const wanted = text(body.workspaceId)
    // Pasted images are the desktop form's (files on this PC): a phone never sends any, and what it sends as images is dropped.
    const base = { text: body.text, sparc: body.sparc === true, ...(typeof body.effort !== 'string' || !body.effort ? {} : { effort: body.effort }), ...(role !== 'device' && body.images !== undefined && body.images !== null ? { images: body.images } : {}) }
    if (wanted !== undefined) {
      const target = findWorkspace(wanted)
      if (!target) return { ok: false, error: instances.list().some((i) => i.state === 'online') ? 'unknown-workspace' : 'no-registry' }
      const to = reachable(target.inst.id)
      return to.error ? { ok: false, error: to.error } : send(to.inst, { kind: 'todo-start', args: { ...base, workspaceId: target.workspaceId } })
    }
    const coordinator = instances.coordinator(caller)
    if (!coordinator) return { ok: false, error: 'no-registry' }
    return send(coordinator, { kind: 'todo-suggest', args: { ...base, workspaces: instances.workspaces({ caller: coordinator.id, full: true }) } })
  }

  /** Start (or retry) a todo: in a workspace of its own instance as a todo-start there, in another instance's by moving the item. */
  async function confirmTodo(item, body) {
    if (item.type !== 'todo') return { ok: false, error: reachable(item.owner).error ?? 'not-todo' } // an unreachable owner is told first, like every owner action
    if (item.kind === 'followup') return followUps.confirm(item, body)
    const wanted = text(body.workspaceId) ?? text(item.workspaceId) ?? text(item.suggested?.workspaceId)
    if (!wanted) return { ok: false, error: 'no-workspace' }
    const found = findWorkspace(wanted)
    const prefixed = /^[A-Za-z0-9]{4}\//.test(wanted) && instances.list().some((i) => instances.short(i.id) === wanted.slice(0, 4))
    if (!found && prefixed) return { ok: false, error: 'unknown-workspace' }
    const target = found ?? { inst: instances.get(item.owner), workspaceId: wanted }
    const to = reachable(target.inst?.id)
    if (to.error) return { ok: false, error: to.error }
    if (to.inst.id === item.owner) return send(to.inst, { kind: 'todo-start', itemId: item.id, args: { workspaceId: target.workspaceId } })
    // The new owner must be the owner before it reports what it does with the item.
    const previous = item.owner
    store.setOwner(item.id, to.inst.id)
    const result = await send(to.inst, { kind: 'todo-start', itemId: item.id, args: { workspaceId: target.workspaceId, item: store.get(item.id) } })
    if (!result.ok) { store.setOwner(item.id, previous); return result }
    tell(previous, { op: 'drop', id: item.id })
    return result
  }

  return {
    /** The efforts of the default model of the coordinator app for the New todo form (the phone has no app of its own): the app's answer, or an empty list when there is none or it fails. */
    async modelEfforts(caller) {
      const coordinator = instances.coordinator(caller)
      if (!coordinator) return { ok: true, efforts: [] }
      const result = await send(coordinator, { kind: 'model-efforts' })
      return result?.ok === true && Array.isArray(result.efforts) ? result : { ok: true, efforts: [] }
    },
    /** The sessions of every online app for the follow-up form's dropdown (no snippets): { sessions, skippedApps }. */
    followUpSessions: (caller) => followUps.sessionList(caller),
    /** @param {{ role?: string, caller?: string }} [ctx] role 'device' is the phone, any other credential the desktop (D8). */
    async act(kind, body, { role, caller } = {}) {
      if (kind === 'todo') return body.followUp !== undefined && body.followUp !== null ? followUps.add(body, caller) : addTodo(body, caller, role)
      const id = String(body.id)
      if (HUB_LOCAL.includes(kind)) return hubLocal(kind, id)
      const item = store.get(id)
      if (!item) return { ok: false, error: 'not-found' }
      // A todo has no session of its own yet, whatever its sessionId says. A follow-up that was SENT has (the session it went to), but only the desktop may read or post into it: a phone may ask for a message to any session of any app, and gets no window into it.
      if (item.type === 'todo' && (kind === 'thread' || kind === 'post') && (role === 'device' || !isSentFollowUp(item))) return { ok: false, error: kind === 'thread' ? 'no-session' : 'not-a-session' }
      if (OWNER_ACTIONS[kind] === true && item.status !== 'open') return { ok: false, error: 'not-open' }
      const via = role === 'device' ? 'phone' : 'desktop'
      const refused = guard(kind, item, body, via)
      if (refused) return refused
      if (item.status === 'open' && (item.owner === undefined || goneOwnedPaused(kind, item))) return actOnOrphan(kind, item, body, via, caller)
      return runOwned(kind, item, body, via)
    },
  }
}
