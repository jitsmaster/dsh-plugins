import { createHash } from 'node:crypto'
import { MAX_CARD, MAX_RAW, buildTrailer, cleanTitle, hasEnvelope, hasTrailer, isSessionId, normalizeText } from './envelope.js'
import { isSubagent } from './sessions.js'
import { matchSessions } from './match.js'
import { createGuards, LIMITS } from './guards.js'

const reject = (reason, extra) => ({ status: 'rejected', reason, ...extra })
const sha = (s) => createHash('sha256').update(s).digest('hex')
const CARD_BODY_END = '\n\n[This session was requested by session '
const bodyHash = (text) => sha(normalizeText(text))
const cardBody = (text) => { const s = String(text ?? ''); const i = s.indexOf(CARD_BODY_END); return i < 0 ? s : s.slice(0, i) }
const PICK = 'the user will pick'
const MAX_WORKSPACE = 200

// perMinute and windowMs apply only to the guards instance (its minute window); hourly and waiting apply here.
export function createStarter({ get, guards = createGuards(), now = Date.now, log = () => {}, limits = LIMITS, titleOf = (agent) => { try { return get('sessionTitle')?.get(agent.session)?.title ?? agent.id } catch { return agent?.id } } }) {
  async function start(args) {
    const { agent, text, workspace, sparc, effort } = args
    if (!agent || !isSessionId(agent.id)) return reject('no-sender')
    if (isSubagent(agent)) return reject('sub-agent-sender')
    const body = String(text ?? '').trim()
    if (!body) return reject('empty')
    if (body.length > MAX_RAW) return reject('too-long')
    if (hasTrailer(body) || hasEnvelope(body)) return reject('loop-guard')
    if (sparc !== undefined && typeof sparc !== 'boolean') return reject('bad-sparc')
    if (workspace !== undefined && (typeof workspace !== 'string' || workspace.length > MAX_WORKSPACE)) return reject('bad-workspace')
    if (effort !== undefined && typeof effort !== 'string') return reject('bad-effort')
    const queue = get('reviewQueue')
    if (typeof queue?.addTodo !== 'function' || typeof queue.todoStates !== 'function') return reject('no-queue')
    // An older queue ignores requireConfirm and would start the session without a card.
    if (queue.supports?.requireConfirm !== true) return reject('queue-unsupported')
    const final = buildTrailer({ senderId: agent.id, senderTitle: titleOf(agent), text: body })
    if (final.length > MAX_CARD) return reject('too-long')

    // Reserve everything synchronously, before the first await below, so parallel calls cannot all pass the caps.
    const slot = guards.reserveMinute(agent.id)
    if (slot === null) return reject('rate-limit')
    const key = agent.id + '|start|' + bodyHash(body)
    if (!guards.reserveFlight(key, agent.id)) { guards.releaseMinute(agent.id, slot); return reject('duplicate') }
    if (guards.hourly(agent.id) >= limits.hourly) { guards.endFlight(key); guards.releaseMinute(agent.id, slot); return reject('hourly-cap') }
    const mark = slot
    guards.markHour(agent.id, mark)
    const othersInFlight = guards.flightsOf(agent.id) - 1
    let keep = false
    try {
      const res = await run(args, queue, final, othersInFlight, bodyHash(body))
      keep = res.status === 'queued-for-confirmation'
      return res
    } finally {
      if (!keep) { guards.releaseMinute(agent.id, slot); guards.releaseHour(agent.id, mark) }
      guards.endFlight(key)
    }
  }

  async function run({ agent, workspace, sparc, effort: rawEffort }, queue, final, othersInFlight, hash) {
    const effort = typeof rawEffort === 'string' && rawEffort.trim() ? rawEffort.trim() : undefined
    const listed = (await Promise.resolve(queue.todoStates({ senderId: agent.id }))) ?? []
    const states = listed.filter((s) => s.status === 'open' && s.state === 'awaiting-confirm')
    if (states.length + guards.pendingCards(agent.id, new Set(listed.map((s) => s.id))).length + othersInFlight >= limits.waiting) return reject('waiting-cap')
    if (states.some((s) => s.kind === 'newsession' && bodyHash(cardBody(s.text)) === hash)) return reject('duplicate')

    let workspaceId
    let offers = PICK
    if (workspace !== undefined && workspace.trim()) {
      const chosen = await pickWorkspace(queue, workspace.trim())
      if (chosen) { workspaceId = chosen.id; offers = cleanTitle(chosen.title) }
    }

    if (effort !== undefined) {
      let listed
      try { listed = await queue.modelEfforts() } catch { listed = undefined }
      const ids = Array.isArray(listed?.efforts) ? listed.efforts.map((e) => e.id) : []
      if (!ids.includes(effort)) return reject('bad-effort', { valid: ids })
    }

    let res
    try {
      res = await queue.addTodo(final, { ...(workspaceId !== undefined ? { workspaceId } : {}), sparc: sparc === true, ...(effort !== undefined ? { effort } : {}), requireConfirm: true, source: { sessionId: agent.id, title: titleOf(agent) } })
    } catch { log('session-link: addTodo failed'); return reject('queue-failed') }
    if (!res?.ok) return reject(String(res?.error ?? 'queue-failed'))
    guards.keepCard(agent.id, res.id)
    return { status: 'queued-for-confirmation', cardId: res.id, offers, sparc: sparc === true, ...(effort !== undefined ? { effort } : {}) }
  }

  async function pickWorkspace(queue, query) {
    let list
    try { list = await queue.workspaces?.() } catch { list = undefined }
    if (!Array.isArray(list)) return undefined
    const exact = list.find((w) => w?.id === query)
    if (exact) return exact
    // Hub ids contain '/', so the rows reuse matchSessions only for the title words; ids are looked up in the list afterwards.
    const rows = list.filter((w) => w && typeof w.id === 'string').map((w) => ({ sessionId: w.id, title: w.title ?? '', workspace: '', running: false, updatedAt: 0 }))
    const found = matchSessions(query, rows)
    if (found.kind !== 'one') return undefined
    const id = found.matches[0].session.sessionId
    return list.find((w) => w?.id === id)
  }
  return { start }
}
