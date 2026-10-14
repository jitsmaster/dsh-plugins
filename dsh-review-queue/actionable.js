/**
 * The code-side guard of the "actionable" verdict. The summary model may say a finished message needs nothing from the
 * user; this decides whether we believe it. It is deliberately one-sided: it can only veto a hide, never create one.
 * Anything that reads like a question, a choice, a failure or blocker, a manual step, a request to review/approve/test
 * or an open next step keeps the item in the list, even when the model said "no". Unsure means show.
 */

/** Phrases that put something on the user's plate (matched case-insensitively on the reply without code). */
const NEEDS_USER = [
	/\?/, // any question
	/\bplease\b/, /\b(could|would|can|shall|should|do|did|will) (you|we|i)\b/, /\bwant me\b/, /\blet me know\b/, /\byour (call|choice|decision|turn)\b/, /\bup to you\b/,
	/\byou('ll| will)? (need|have|must|should|can|may|might|could|want)\b/, /\bneed(s)? (you|your|to be)\b/, /\bbefore you\b/, /\b(once|when|if) you\b/,
	/\b(decide|decision|choose|choice|which (one|option|approach)|options?:|approach(es)? (a|b|1|2)|alternatively|trade-?offs?)\b/,
	/\b(approve|approval|confirm|review|sign[- ]?off|verify|double[- ]?check|check (that|whether|if))\b/,
	/\b(test (it|this|that)|try (it|this|that)|by hand|manual(ly)?|restart|reload|re-?run|run (it|this|the))\b/,
	/\b(todo|to-do|follow[- ]?up|next steps?|remaining|left to do|still (need|todo|open|broken|fail)|not (yet|done|finished|fixed|working|tested)|outstanding|unresolved|open (question|issue|item))\b/,
	/\b(block(ed|er|ing)?|stuck|waiting (on|for)|unable|cannot|can't|couldn't|could not|wasn't able|didn't|did not|doesn't work|does not work|not able)\b/,
	/\b(fail(s|ed|ing|ure|ures)?|error(s)?|broken|crash(ed|es)?|exception|regression|warning(s)?|caveat|skipped|incomplete|partial(ly)?|workaround|risk(y)?)\b/,
	/\b(recommend|suggest|propose|consider|note that|heads[- ]up)\b/,
]

/** "0 failures", "no errors", "without errors" are the good kind of the words above. */
const CLEAN = /\b(0|zero|no|without|none|nothing)\s+(?:test\s+|new\s+)?(?:fail\w*|errors?|warnings?|regressions?|issues?|problems?)\b/gi

const stripCode = (text) => text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')

/** True when the message must stay in the list whatever the model said. */
export function needsUser(reply) {
	if (typeof reply !== 'string' || !reply.trim()) return true
	const text = stripCode(reply).replace(CLEAN, ' ')
	return NEEDS_USER.some((re) => re.test(text.toLowerCase()))
}
