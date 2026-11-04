/**
 * Auto actor for the question class (rule straightforward-question): answers a one-question option card with the exact label the judge chose, backed by a
 * quote the user wrote. It re-reads the card as stored NOW and refuses unless it is still the card that was judged; it never types free text, never sends
 * `custom`, and never throws.
 */
import { clipAnswer } from './triage-clip.js'
import { AUTO_MIN_QUOTE_CHARS, autoAnswerRefusal, normalizeQuote, quoteSource } from './triage.js'
import { redact } from './triage-log.js'

const QUOTE_CAP = 300
const labelsOf = (q) => (Array.isArray(q?.options) ? q.options.map((o) => o?.label) : [])
/** The parts of a card that matter for acting: question id and text, option labels, call id. */
const shapeOf = (item) => JSON.stringify([(Array.isArray(item?.payload?.questions) ? item.payload.questions : []).map((q) => [q?.id, q?.question, labelsOf(q)]), item?.payload?.callId])

/**
 * @param {{ store: { get: (id: string) => object | undefined }, answer: (id: string, answers: { id: string, selected: string[] }[], resolution: object) => boolean | { ok?: boolean } | Promise<boolean | { ok?: boolean }> }} deps
 *   answer settles the pending question with the given resolution; it returns true / { ok: true } only when it did.
 */
export function createQuestionActor({ store, answer }) {
  return async ({ item, judgment, resolutionBase, sources } = {}) => {
    try {
      if (item?.type !== 'question') return { ok: false, reason: 'refused' }
      const current = store.get(item.id)
      if (!current || current.type !== 'question') return { ok: false, reason: 'refused' }
      if (current.status !== 'open') return { ok: false, reason: 'not-pending' }
      if (shapeOf(current) !== shapeOf(item)) return { ok: false, reason: 'changed' }
      const questions = current.payload?.questions
      const label = judgment?.answer
      if (!Array.isArray(questions) || questions.length !== 1 || typeof label !== 'string' || !labelsOf(questions[0]).includes(label)) return { ok: false, reason: 'refused' }
      // Defence in depth, the same Auto rules the verdict applied: the card marks a recommended option, the answer is exactly it, and the quote is long enough
      // (and, when the runner hands over the sources, still found verbatim in the user-authored source it names).
      if (autoAnswerRefusal(label, questions[0])) return { ok: false, reason: 'refused' }
      if (normalizeQuote(judgment.evidence_quote).length < AUTO_MIN_QUOTE_CHARS) return { ok: false, reason: 'refused' }
      if (Array.isArray(sources) && quoteSource(judgment.evidence_quote, sources, AUTO_MIN_QUOTE_CHARS) !== judgment.evidence_source) return { ok: false, reason: 'refused' }
      const answers = [{ id: questions[0].id, selected: [label] }]
      const quote = typeof judgment.evidence_quote === 'string' ? redact(judgment.evidence_quote.slice(0, QUOTE_CAP)) : undefined
      const shown = clipAnswer(label)
      const res = await answer(current.id, answers, { ...resolutionBase, action: 'answered', answer: shown, answers, ...(quote ? { quote } : {}) })
      return res === true || res?.ok === true
        ? { ok: true, action: 'answered', answer: shown, ...(quote ? { quote } : {}), ...(typeof judgment.evidence_source === 'string' ? { evidenceSource: judgment.evidence_source } : {}), basis: 'quoted-source' }
        : { ok: false, reason: 'not-pending' }
    } catch { return { ok: false, reason: 'error' } }
  }
}
