/**
 * The hub side of a Follow-up todo (docs/hub.md 6.4a): the text of the todo is a message for an EXISTING session, which may live in any app.
 * add: the hub asks every online app for its sessions (command sessions-list, a short timeout, an app that fails adds nothing; the snippets cost a log read on the app's PC, so when the
 * words hold a ticket / PR number the first round asks for none and the snippets are asked for only if no title decides), tags each with the
 * app it came from, joins them (a session id once, newest 60) and hands the union to the coordinator as followup-suggest; the item stays the
 * coordinator's while it waits for the confirm. confirm: the message is sent by the app the chosen session lives in (followup-send): the item's own
 * app, or, as for a todo started in another app's workspace, the item moves there first and moves back when that fails.
 * The candidates only ever come from the apps: nothing a client puts in its body is used for them.
 */
import { MAX_QUERY, MAX_TODO, MAX_WAITING_FOLLOW_UPS, MAY_HAVE_BEEN_SENT, REF_REASON, SESSIONS_LIMIT, TOO_MANY_FOLLOW_UPS, cleanSessions, codeOf, refNumbersOf, suggestSessionByRef } from '../follow-up-shared.js'

export { MAX_WAITING_FOLLOW_UPS, MAY_HAVE_BEEN_SENT, SESSIONS_LIMIT, cleanSessions } // the old home of the shared cleaner: tests and callers keep importing it from here

/** How long one caller's union of the apps' sessions is reused: every add would otherwise cost a session list (and log reads) on every PC. */
export const UNION_TTL_MS = 5000

const timeOf = (s) => (Number.isFinite(s.updatedAt) ? s.updatedAt : -Infinity)

/** The answer of an owner that was handed the send and did not report back: the same error, plus the warning (a plain refusal or a command nobody fetched sent nothing). */
const withWarning = (result) => (result?.error === 'unknown-outcome' ? { ...result, warning: MAY_HAVE_BEEN_SENT } : result)

/**
 * @param {{ store: any, instances: any, reachable: (owner: string) => { inst?: any, error?: string }, send: (inst: any, command: object) => Promise<any>,
 *   tell: (owner: string, change: object) => void, log?: (line: string) => void }} deps the helpers of hub/routing.js, and the hub log
 */
export function createHubFollowUps({ store, instances, reachable, send, tell, log = () => {}, now = Date.now }) {
  /** One app's sessions, tagged with that app: { list }, or { skipped: <why> } when it cannot be reached, fails, or does not answer in time (logged). snippets false: without the snippets. */
  async function sessionsOf(inst, snippets) {
    const to = reachable(inst.id)
    if (to.error) { log('follow-up: app ' + inst.id + ' skipped (' + codeOf(to.error) + ')'); return { skipped: to.error, list: [] } }
    try {
      const result = await send(to.inst, { kind: 'sessions-list', args: snippets ? {} : { snippets: false } })
      if (result?.ok === true) return { list: cleanSessions(result.sessions, { owner: inst.id }) }
      log('follow-up: app ' + inst.id + ' skipped (' + codeOf(result?.error) + ')')
      return { skipped: result?.error ?? 'failed', list: [] }
    } catch (error) {
      log('follow-up: app ' + inst.id + ' skipped (' + codeOf(error?.code ?? error?.name) + ')')
      return { skipped: 'failed', list: [] }
    }
  }

  const unions = new Map() // key (the caller's registered instance id, or '') -> { promise } while it is being made, { at, value } once it is complete
  /**
   * The union for a caller, shared: adds that overlap await one round of questions (single flight), a complete answer (no app skipped) is reused for UNION_TTL_MS, an
   * incomplete one is not kept. Keyed by the caller's registered instance id because the caller's own sessions come first; a caller that names no registered app (the header is
   * client input) shares the entry of '', so the map never holds more than one entry per app plus that one.
   */
  async function sessions(caller, snippets = true) {
    const known = instances.get(caller)
    const id = known?.registered ? known.id : ''
    caller = id || undefined
    const key = snippets ? id : id + '|plain' // the union without snippets is a round of its own
    for (const [k, e] of unions) if (e.at !== undefined && now() - e.at >= UNION_TTL_MS) unions.delete(k) // expired entries go
    const hit = unions.get(key)
    if (hit?.promise) return hit.promise
    if (hit) return hit.value
    const promise = unionOf(caller, snippets)
    unions.set(key, { promise })
    try {
      const value = await promise
      if (value.skippedApps === 0) unions.set(key, { at: now(), value })
      else unions.delete(key)
      return value
    } catch (error) { unions.delete(key); throw error }
  }

  /** The sessions of every online app: the caller's own first (so it wins a session id both list), a session id once, the 60 newest; and how many apps did not answer. */
  async function unionOf(caller, snippets) {
    const online = instances.list().filter((i) => i.registered && i.state === 'online')
    const ordered = [...online.filter((i) => i.id === caller), ...online.filter((i) => i.id !== caller)]
    const answers = await Promise.all(ordered.map((inst) => sessionsOf(inst, snippets)))
    const seen = new Set()
    const union = []
    for (const s of answers.flatMap((a) => a.list)) {
      if (seen.has(s.sessionId)) continue
      seen.add(s.sessionId)
      union.push(s)
    }
    return {
      sessions: union.map((s, index) => ({ s, index })).sort((x, y) => timeOf(y.s) - timeOf(x.s) || x.index - y.index).slice(0, SESSIONS_LIMIT).map((x) => x.s),
      skippedApps: answers.filter((a) => a.skipped !== undefined).length,
    }
  }

  /** The answer of a send with an unknown outcome also marks the item failed, with the warning, in the hub's store (what every UI shows). Any other answer is returned as it is. */
  function unknownOutcomeFails(id, result) {
    if (result?.error === 'unknown-outcome' && store.get(id)?.status === 'open') store.update(id, { state: 'failed', suggesting: false, error: MAY_HAVE_BEEN_SENT })
    return result
  }

  let adding = 0 // adds that passed the cap and have not ended: they count against it, or concurrent adds would all pass
  const waiting = () => store.count((i) => i.status === 'open' && i.type === 'todo' && i.kind === 'followup' && i.state === 'awaiting-confirm')

  /** The states a follow-up may be confirmed in: waiting for the user, or failed (Retry). */
  const CONFIRMABLE = new Set(['awaiting-confirm', 'failed'])

  /** The items whose confirm is on its way (the owner has been handed the send and has not answered): a second confirm of one of them must not send again. */
  const confirming = new Set()

  async function confirmOnce(item, body) {
    // Only a follow-up that waits for its confirm, or a failed one (Retry), may be sent or moved: one an app is already sending ('starting') must keep its owner.
    if (!CONFIRMABLE.has(item.state)) return { ok: false, error: 'not-confirmable' }
    const given = body.sessionId
    if (given !== undefined && given !== null && given !== '' && typeof given !== 'string') return { ok: false, error: 'unknown-session' }
    const wanted = given || item.suggested?.sessionId
    if (!wanted) return { ok: false, error: 'no-session' }
    // A session that is running now may be in the middle of a task: a MODEL's pick of it is never sent without the user choosing a session (the cards do not preselect it). The deterministic ticket / PR number pick and an explicit session are.
    if (!given && item.suggested?.running === true && item.suggested.reason !== REF_REASON) return { ok: false, error: 'no-session' }
    const hit = (item.candidates ?? []).find((c) => c.sessionId === wanted)
    if (!hit) return { ok: false, error: 'unknown-session' }
    const target = hit.owner ?? (item.suggested?.sessionId === wanted ? item.suggested.owner : undefined) ?? item.owner
    const to = reachable(target)
    if (to.error) return { ok: false, error: to.error }
    if (to.inst.id === item.owner) return unknownOutcomeFails(item.id, withWarning(await send(to.inst, { kind: 'followup-send', itemId: item.id, args: { sessionId: wanted } })))
    // The new owner must be the owner before it reports what it does with the item.
    const previous = item.owner
    store.setOwner(item.id, to.inst.id)
    const result = await send(to.inst, { kind: 'followup-send', itemId: item.id, args: { sessionId: wanted, item: store.get(item.id) } })
    if (result.error === 'unknown-outcome') {
      tell(previous, { op: 'drop', id: item.id }) // the new owner keeps the item: the old one must not show a copy that can be sent again from there
      return unknownOutcomeFails(item.id, withWarning(result))
    }
    if (!result.ok) {
      store.setOwner(item.id, previous)
      tell(to.inst.id, { op: 'drop', id: item.id }) // the new owner may have taken a copy
      return withWarning(result)
    }
    tell(previous, { op: 'drop', id: item.id })
    return result
  }

  return {
    /** POST /v1/todo with followUp: the words and the text are checked first, then the apps are asked, then the coordinator suggests. */
    async add(body, caller) {
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) return { ok: false, error: 'empty' }
      if (text.length > MAX_TODO) return { ok: false, error: 'too-long' }
      const followUp = typeof body.followUp === 'string' ? body.followUp.trim() : ''
      if (!followUp) return { ok: false, error: 'empty-query' }
      if (followUp.length > MAX_QUERY) return { ok: false, error: 'too-long' }
      const coordinator = instances.coordinator(caller)
      if (!coordinator) return { ok: false, error: 'no-registry' }
      if (waiting() + adding >= MAX_WAITING_FOLLOW_UPS) return { ok: false, error: TOO_MANY_FOLLOW_UPS }
      adding++
      try {
        let found
        if (refNumbersOf(followUp).size) {
          found = await sessions(caller, false) // a number of the words may decide on the titles: then no app reads a log for a snippet
          if (!suggestSessionByRef(followUp, found.sessions)) found = await sessions(caller)
        } else found = await sessions(caller)
        return await send(coordinator, { kind: 'followup-suggest', args: { text, followUp, sessions: found.sessions, ...(found.skippedApps ? { skippedApps: found.skippedApps } : {}) } })
      } finally { adding-- }
    },

    /**
     * todo-confirm of a follow-up item: the session (body, else the suggestion) must be one of the item's candidates; its app sends the message.
     * An owner that took the send and never reported (unknown-outcome) may have sent it: the item is NOT put back to awaiting-confirm (the next person to look would not know). It stays
     * open with the app that was handed the send (it may have adopted the item and sent the message), marked failed with the warning as its error so every UI shows it; Retry is a
     * confirm again to the same item and session, which the apps turn into the same requestId (todo-<item id>-<session id>). The answer carries the warning too.
     */
    async confirm(item, body) {
      if (confirming.has(item.id)) return { ok: false, error: 'not-confirmable' } // a second confirm of the same item while the first is in flight: one send only, whatever session or app it names
      confirming.add(item.id)
      try { return await confirmOnce(item, body) } finally { confirming.delete(item.id) }
    },
  }
}
