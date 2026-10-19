/**
 * The code-side guard of the "actionable" verdict. The summary model may say a finished message needs nothing from the
 * user; this decides whether we believe it. It is deliberately one-sided: it can only veto a hide, never create one.
 * It looks only at the TAIL of the reply (the last two paragraphs, code removed), because that is where an assistant
 * addresses the user; topic words earlier in a long report ("review", "error", "risk") say nothing about what the user
 * must do. Only signals addressed to the user veto: a question, a request, a manual step, a blocker, open work.
 */

/** Strong signals in the tail (matched case-insensitively on the tail without code). */
const NEEDS_USER = [
	/\?/, // any question
	/\bplease\b/, /\b(could|would|can|shall|should|do|did|will) (you|we)\b/, /\bwant me\b/, /\blet me know\b/, /\byour (call|choice|decision|turn|go-?ahead)\b/, /\bup to you\b/,
	/\byou(?:'ll| will)? (?:need|have to|must|should|can|may|might|could|want)\b/, /\bneeds? (you|your)\b/, /\bbefore you\b/, /\b(once|when|if) you\b/,
	/\b(decide|choose|which (?:one|option|approach)|options:)/,
	/\b(approve|approval|sign[- ]?off|go-?ahead)\b/, /\b(confirm|verify|double[- ]?check) (that|whether|if|it|this)\b/,
	/\b(test (it|this|that)|try (it|this|that)|by hand|manually|restart (it|the|your)|reload)\b/,
	/\b(blocked (on|by)|stuck|waiting (on|for) (you|your|the user)|unable to|cannot|can't|couldn't|could not|wasn't able)\b/,
	/\b(still|remaining) (failing|broken|open|unresolved|todo)\b/, /\bnot (yet )?(done|finished|fixed|working|tested)\b/,
	/\b(unresolved|outstanding|open question|open issue)\b/,
	/\bhand(?:ed)?[- ]?offs?\b/, // a handoff ("hand off", "handed off", "hand-off") is for the next session: the user starts or checks it
	/\b(pull requests?|prs?\s*#?\d+)\b|\bpr[- ]?wait\b/, // a pull request waits for a review or a merge; a PR-WAIT heartbeat is the poll for its comments
	/\b(tickets?|work items?)\b|\bab#\d+/, // a ticket or work item to confirm or follow up
]

/** "0 failures", "no errors", "without errors" are the good kind of the words above. */
const CLEAN = /\b(0|zero|no|without|none|nothing)\s+(?:test\s+|new\s+)?(?:fail\w*|errors?|warnings?|regressions?|issues?|problems?)\b/gi

/** How many trailing paragraphs hold the part addressed to the user. */
const TAIL_PARAGRAPHS = 2

const stripCode = (text) => text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')

/** The last paragraphs (split on blank lines) of the reply, code removed; paragraphs left empty by that are not counted. */
function tailOf(reply) {
	const paragraphs = stripCode(reply).split(/\r?\n[ \t]*\r?\n/).map((p) => p.trim()).filter(Boolean)
	return paragraphs.slice(-TAIL_PARAGRAPHS).join('\n\n')
}

/** True when the message must stay in the list whatever the model said. */
export function needsUser(reply) {
	if (typeof reply !== 'string' || !reply.trim()) return true
	const tail = tailOf(reply)
	if (!tail) return true // nothing but code: we cannot tell, so show it
	const text = tail.replace(CLEAN, ' ').toLowerCase()
	return NEEDS_USER.some((re) => re.test(text))
}
