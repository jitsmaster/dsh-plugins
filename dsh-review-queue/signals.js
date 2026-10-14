/** Small readers for the session events and messages the capture reacts to (shapes: DSH user-questions, agent pre-step). */

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('') : '')

const jsonOf = (content) => { try { return JSON.parse(textOf(content)) } catch { return undefined } }

/** True when a tool result is the "still pending" payload of a timed question (the wait ran out; the call goes on as continued). */
export const isPendingResult = (content) => jsonOf(content)?.pending === true

/** The answer batch of a reply or a tool result ([{ id, selected, custom? }]), or [] when it carries none. */
export function replyAnswers(content) {
	const answers = jsonOf(content)?.answers
	if (!Array.isArray(answers)) return []
	return answers.filter((a) => a && typeof a.id === 'string' && Array.isArray(a.selected)).map((a) => ({ id: a.id, selected: a.selected.filter((v) => typeof v === 'string'), ...(typeof a.custom === 'string' && a.custom ? { custom: a.custom } : {}) }))
}

/** A message the user typed (source 'user', or no source), as opposed to injected context, goal rounds or a reply to a question. */
export const isHumanMessage = (message) => !message?.source || message.source.kind === 'user'
