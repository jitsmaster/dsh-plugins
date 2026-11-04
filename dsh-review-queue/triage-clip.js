// Shared by triage-runner.js and triage-act-question.js (kept apart so the actor need not import the runner).
/** The proposed answer kept on the card: model text, so whitespace-collapsed and capped at 200 characters (ellipsis if cut). */
const ANSWER_CAP = 200
export function clipAnswer(answer) {
  if (typeof answer !== 'string') return answer
  const s = answer.replace(/\s+/g, ' ').trim()
  return s.length > ANSWER_CAP ? s.slice(0, ANSWER_CAP - 1) + '\u2026' : s
}
