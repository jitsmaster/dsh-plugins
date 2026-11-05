import { cleanLine, cleanTitle, isSessionId } from './envelope.js'
import { isSubagent } from './sessions.js'
import { createGuards } from './guards.js'

const MAX_MESSAGE = 200
const reject = (reason) => ({ status: 'rejected', reason })
// A reason from the queue: no control characters, at most 40 characters.
const plain = (v) => String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 40)

/**
 * archive_self: a finished session asks the user to archive IT (never another session). Nothing is archived here; the queue only adds an
 * "archive" card with the message as its reason, and the user presses Archive session or Keep session.
 */
export function createArchiver({ get, guards = createGuards(), log = () => {}, titleOf = (agent) => { try { return get('sessionTitle')?.get(agent.session)?.title ?? agent.id } catch { return agent?.id } } }) {
  async function offer({ agent, message } = {}) {
    if (!agent || !isSessionId(agent.id)) return reject('no-sender')
    if (isSubagent(agent)) return reject('sub-agent-sender')
    const reason = typeof message === 'string' ? cleanLine(message, MAX_MESSAGE) : ''
    if (!reason) return reject('empty')
    const queue = get('reviewQueue')
    if (!queue) return reject('no-queue')
    // An older queue has no offerArchive or no switch; the explicit support flag is the contract.
    // The switch must exist too: a queue without it could not honour archiveOfferCommands:false.
    if (typeof queue.offerArchive !== 'function' || typeof queue.archiveOfferEnabled !== 'function' || queue.supports?.offerArchive !== true) return reject('queue-unsupported')
    // archiveOfferCommands:false: answered before the rate limit, so a disabled call costs no slot.
    let enabled
    try { enabled = queue.archiveOfferEnabled() } catch { log('session-link: archiveOfferEnabled failed'); return reject('queue-failed') }
    if (enabled !== true) return reject('disabled')

    // Reserved synchronously, before the first await, so parallel calls cannot all pass the limit.
    const slot = guards.reserveArchive(agent.id)
    if (slot === null) return reject('rate-limit')
    let keep = false
    try {
      let title
      try { title = cleanTitle(titleOf(agent)) } catch { title = '' }
      const cwd = agent.session?.header?.cwd
      let res
      try {
        res = await queue.offerArchive({ sessionId: agent.id, sessionTitle: title, workspace: typeof cwd === 'string' ? cwd : undefined, reason })
      } catch { log('session-link: offerArchive failed'); return reject('queue-failed') }
      if (!res?.ok) return reject(typeof res?.error === 'string' && plain(res.error) ? plain(res.error) : 'queue-failed')
      if (typeof res.id !== 'string') return reject('queue-failed')
      keep = true
      return { status: 'offered', cardId: res.id, updated: res.updated === true }
    } finally {
      if (!keep) guards.releaseArchive(agent.id, slot)
    }
  }
  return { offer }
}
