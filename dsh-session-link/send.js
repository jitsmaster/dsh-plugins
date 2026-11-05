import { createHash } from 'node:crypto'
import { MAX_CARD, MAX_RAW, buildEnvelope, cleanTitle, hasEnvelope, isSessionId } from './envelope.js'
import { listPeers, isSubagent } from './sessions.js'
import { matchSessions } from './match.js'
import { createGuards, LIMITS } from './guards.js'

export { LIMITS }
const BUCKET_MS = 10 * 60_000
const SWEEP_ABOVE = 256
const reject = (reason) => ({ status: 'rejected', reason })
const sha = (s) => createHash('sha256').update(s).digest('hex')

export function createSender({ get, now = Date.now, log = () => {}, limits = LIMITS, guards = createGuards({ now, limits }), titleOf = (agent) => { try { return get('sessionTitle')?.get(agent.session)?.title ?? agent.id } catch { return agent?.id } } }) {
  // perMinute and windowMs apply only to the guards instance (its minute window); hourly, waiting and pairMs apply here.
  const pairs = new Map() // senderId|targetId -> time

  async function send(args) {
    const { agent, text, mode = 'queue' } = args
    if (!agent || !isSessionId(agent.id)) return reject('no-sender')
    if (isSubagent(agent)) return reject('sub-agent-sender')
    const body = String(text ?? '').trim()
    if (!body) return reject('empty')
    if (body.length > MAX_RAW) return reject('too-long')
    if (hasEnvelope(body)) return reject('loop-guard')
    if (mode !== 'queue' && mode !== 'steer') return reject('bad-mode')
    if (String(args.session ?? '').trim() === agent.id) return reject('self-send')
    const slot = guards.reserveMinute(agent.id)
    if (slot === null) return reject('rate-limit')
    const state = { keep: false, flight: undefined, pairKey: undefined, pairPrev: undefined }
    try {
      return await run(args, body, mode, slot, state)
    } finally {
      if (!state.keep) {
        guards.releaseMinute(agent.id, slot)
        // Roll back only our own reservation: a later send to the same target may have written its own entry while an approval was pending.
        if (state.pairKey && pairs.get(state.pairKey) === state.pairMine) { if (state.pairPrev === undefined) pairs.delete(state.pairKey); else pairs.set(state.pairKey, state.pairPrev) }
      }
      if (state.flight) guards.endFlight(state.flight)
    }
  }

  async function run({ agent, session, signal, callId }, body, mode, slot, state) {
    let peers
    try { peers = await listPeers({ controller: get('sessionController'), registry: get('workspaceRegistry'), senderId: agent.id, signal }) } catch (e) { return reject(/controller/.test(e.message) ? 'no-controller' : 'list-failed') }
    const found = matchSessions(session, peers)
    if (found.kind === 'none') return { status: 'no-match', near: found.near.map((p) => ({ sessionId: p.sessionId, title: cleanTitle(p.title) })) }
    const target = found.kind === 'one' ? found.matches[0].session : undefined
    const words = String(session).trim().slice(0, 300)
    const queue = get('reviewQueue')
    const hasQueue = typeof queue?.addTodo === 'function'
    if (!hasQueue && !target) return { status: 'ambiguous', candidates: found.matches.slice(0, 10).map((m) => ({ sessionId: m.session.sessionId, title: cleanTitle(m.session.title) })) }

    const envelope = buildEnvelope({ senderId: agent.id, senderTitle: titleOf(agent), text: body })
    if (envelope.length > MAX_CARD) return reject('too-long')
    if (hasQueue && typeof queue.todoStates !== 'function') return reject('queue-unsupported')

    // Reserve everything synchronously, before the first await below: the in-flight key and the pair cooldown.
    const key = agent.id + '|' + (target ? target.sessionId : words) + '|' + sha(envelope)
    const othersInFlight = guards.flightsOf(agent.id)
    if (!guards.reserveFlight(key, agent.id)) return reject('duplicate')
    state.flight = key
    if (target && now() - (pairs.get(agent.id + '|' + target.sessionId) ?? -Infinity) < limits.pairMs) return reject('pair-cooldown')
    if (pairs.size > SWEEP_ABOVE) for (const [k, t] of pairs) if (now() - t >= limits.pairMs) pairs.delete(k)
    if (target) { state.pairKey = agent.id + '|' + target.sessionId; state.pairPrev = pairs.get(state.pairKey); state.pairMine = now(); pairs.set(state.pairKey, state.pairMine) }

    if (hasQueue) {
      const listed = await Promise.resolve(queue.todoStates({ senderId: agent.id })) ?? []
      const own = listed.filter((s) => s.status === 'open' && s.state === 'awaiting-confirm')
      if (own.length + guards.pendingCards(agent.id, new Set(listed.map((s) => s.id))).length + othersInFlight >= limits.waiting) return reject('waiting-cap')
      if (own.some((s) => s.text === envelope && (!target || !s.targetSessionId || s.targetSessionId === target.sessionId))) return reject('duplicate')
      const followUp = target ? target.sessionId : (isSessionId(words) ? words + ' session' : words)
      let res
      try { res = await queue.addTodo(envelope, { followUp, mode, excludeSessionIds: [agent.id], source: { sessionId: agent.id, title: titleOf(agent) } }) } catch (e) { log('session-link: addTodo failed'); return reject('queue-failed') }
      if (!res?.ok) return reject(String(res?.error ?? 'queue-failed'))
      state.keep = true
      guards.keepCard(agent.id, res.id)
      return { status: 'queued-for-confirmation', cardId: res.id, mode, running: target ? target.running : undefined, offers: target ? cleanTitle(target.title) : 'the user will pick' }
    }

    // Fallback: no review queue. A blocking approval, then a direct prompt.
    const approval = get('approval')
    const controller = get('sessionController')
    if (typeof approval?.request !== 'function') return reject('no-approval')
    const id = callId ?? 'link-' + now()
    let outcome
    try { outcome = await approval.request({ agent, toolName: 'send_to_session', callId: id, reason: 'send a message to session "' + target.title + '" (' + target.sessionId + ') in ' + mode + ' mode: ' + body, ...(signal ? { signal } : {}) }) } catch { return reject('denied') }
    if (outcome !== 'allowed-once') return reject('denied')
    // The request id is a hash of sender, target, envelope and a 10-minute time bucket (not the callId): a model retry after a timeout gets a new callId but the same request, which the controller dedupes,
    // while an identical message 10+ minutes later gets a new id and is not silently dropped as a duplicate.
    // Recorded BEFORE the prompt, so the pair cooldown also stops a retry when the first prompt may already have been delivered (and stays recorded if the prompt throws).
    state.keep = true
    pairs.set(agent.id + '|' + target.sessionId, now())
    const requestId = 'todo-link-' + sha(agent.id + '|' + target.sessionId + '|' + envelope + '|' + Math.floor(now() / BUCKET_MS)).slice(0, 32)
    try { await controller.prompt({ requestId, sessionId: target.sessionId, mode, content: [{ type: 'text', text: envelope }] }, signal ?? AbortSignal.timeout(30_000)) } catch { log('session-link: prompt failed'); return reject('prompt-failed') }
    return { status: 'sent', mode, target: { sessionId: target.sessionId, title: cleanTitle(target.title) } }
  }
  return { send, sizes: () => ({ pairs: pairs.size }) }
}
