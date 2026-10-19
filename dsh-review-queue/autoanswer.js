/**
 * The pure parts of the question auto-answer (capture.js owns the timer): the answer to give and the text of the done card that tells
 * the user what was decided. A question is only auto-answered when every question of the request marks a recommended option.
 */
import { cleanText, recommendedOf } from './speech.js'

/** How long before a question's deadline the recommended option is taken. */
export const DEFAULT_AUTO_ANSWER_LEAD_MS = 10_000
const MAX_QUESTION_CHARS = 120
const MAX_LABEL_CHARS = 120

/** An option label as the card text and the log quote it: the label is model output, so it is cleaned and capped like the question text. */
export const shownLabel = (label) => cleanText(label, { maxChars: MAX_LABEL_CHARS })

/** One answer per question holding its recommended option; undefined when any question has none. */
export function recommendedAnswers(questions) {
  if (!Array.isArray(questions) || !questions.length) return undefined
  const answers = []
  for (const q of questions) {
    const rec = recommendedOf(q)
    if (rec === undefined) return undefined
    answers.push({ id: q.id, selected: [rec] })
  }
  return answers
}

/** The text of the done card: what was about to time out and which option the task list (not the user) gave the assistant as the answer. */
export function autoAnswerText(questions, answers) {
  const quoted = (text) => '"' + text + '"'
  const lines = questions.map((q) => quoted(cleanText(q.question, { maxChars: MAX_QUESTION_CHARS })) + (questions.length > 1 ? ': ' + quoted(shownLabel(answers.find((a) => a.id === q.id)?.selected[0] ?? '')) : ''))
  const tail = ' Reply in this session to change course.'
  if (questions.length === 1) return 'The question ' + lines[0] + ' was about to time out, so the task list answered it for you with the recommended option: ' + quoted(shownLabel(answers[0].selected[0])) + '. The assistant received that as the answer; you did not choose it.' + tail
  return questions.length + ' questions were about to time out, so the task list answered them for you with the recommended options: ' + lines.join('; ') + '. The assistant received those as the answers; you did not choose them.' + tail
}
