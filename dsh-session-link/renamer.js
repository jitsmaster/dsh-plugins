import { cleanLine, cleanTitle, isSessionId } from './envelope.js'
import { isSubagent } from './sessions.js'

const MAX_TITLE = 120
const APPROVE = 'Rename'
const KEEP = 'Keep current name'
const reject = (reason) => ({ status: 'rejected', reason })

/**
 * rename_session: a session asks to be renamed. The user is asked through a normal question card in the Review Queue (old title, proposed title);
 * only an approving answer renames. Nothing is returned after the rename: approval of the card is the end of the flow (no done message).
 */
export function createRenamer({ get, titleOf = (agent) => { try { return get('sessionTitle')?.get(agent.session)?.title ?? agent.id } catch { return agent?.id } }, log = () => {} }) {
  async function rename({ agent, title, signal } = {}) {
    if (!agent || !isSessionId(agent.id)) return reject('no-sender')
    if (isSubagent(agent)) return reject('sub-agent-sender')
    const next = typeof title === 'string' ? cleanLine(title, MAX_TITLE) : ''
    if (!next) return reject('empty')
    let old
    try { old = cleanTitle(titleOf(agent)) } catch { old = '' }
    if (next === old) return reject('unchanged')
    const questions = get('userQuestions')
    if (typeof questions?.ask !== 'function') return reject('no-questions')
    const controller = get('sessionController')
    if (typeof controller?.rename !== 'function') return reject('no-controller')

    let answer
    try {
      answer = await questions.ask({
        agent,
        ...(signal ? { signal } : {}),
        questions: [{
          id: 'rename',
          header: 'Rename session',
          question: 'Rename this session from "' + old + '" to "' + next + '"?',
          options: [{ label: APPROVE }, { label: KEEP }],
        }],
      })
    } catch { log('session-link: rename question failed'); return reject('question-failed') }
    const picked = answer?.answers?.find((a) => a?.id === 'rename')?.selected
    if (!Array.isArray(picked) || !picked.includes(APPROVE)) return undefined
    try { await controller.rename({ sessionId: agent.id, title: next }) } catch { log('session-link: rename failed'); return reject('rename-failed') }
    return undefined
  }
  return { rename }
}
