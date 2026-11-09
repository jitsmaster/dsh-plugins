/**
 * The code-side guard of the "actionable" verdict. The summary model may say a finished message needs nothing from the
 * user; this decides whether we believe it. It is deliberately one-sided: it can only veto a hide, never create one.
 * It looks only at the TAIL of the reply (the last two paragraphs, code removed), because that is where an assistant
 * addresses the user; topic words earlier in a long report ("review", "error", "risk") say nothing about what the user
 * must do. Only signals addressed to the user veto: a question, a request, a manual step, a blocker, open work.
 */

/** Strong signals in the tail (matched case-insensitively on the tail without code). */
const STRONG = [
	/\?/, // any question
	/\bplease\b/, /\b(could|would|can|shall|should|do|did|will) (you|we)\b/, /\bwant me\b/, /\blet me know\b/, /\byour (call|choice|decision|turn|go-?ahead)\b/, /\bup to you\b/,
	/\byou(?:'ll| will)? (?:need|have to|must|should|can|may|might|could|want)\b/, /\bneeds? (you|your)\b/, /\bbefore you\b/, /\b(once|when|if) you\b/,
	/\b(decide|choose|which (?:one|option|approach)|options:)/,
	/\bready for (?:your |the )?(?:review|merge|merging)\b/, /\bfor your (?:review|attention)\b/, // a review request addressed to the user, also next to a PR or ticket mention
	/\b(approve|approval|sign[- ]?off|go-?ahead)\b/, /\b(confirm|verify|double[- ]?check) (that|whether|if|it|this)\b/,
	/\b(test (it|this|that)|try (it|this|that)|by hand|manually|restart (it|the|your)|reload)\b/,
	/\b(blocked (on|by)|stuck|waiting (on|for) (you|your|the user)|unable to|cannot|can't|couldn't|could not|wasn't able)\b/,
	/\b(still|remaining) (failing|broken|open|unresolved|todo)\b/, /\bnot (yet )?(done|finished|fixed|working|tested)\b/,
	/\b(unresolved|outstanding|open question|open issue)\b/,
	// Hand-backs that used to be caught only by the PR/handoff/ticket mention veto, which AI triage of done cards does not apply.
	/\bawaiting\b/, /\bwaiting (?:on|for) (?:ci|a reviewer|review|approval)\b/, /\bpending (?:review|approval)\b/, /\breview (?:is )?requested\b/,
	/\b(?:take|have) a look\b/, /\bpick (?:it|this|that) up\b/, /\bnext (?:session|step)\b/, /\bwhen (?:you(?:'re| are) )?ready\b/,
	/\bsee (?:the )?(?:pr|pull request|ticket)\b/, /\b(?:open|review|check) the (?:pr|pull request|diff)\b/,
	// Open work and advice left for the user.
	/\bfollow-?ups?\b/, /\bremaining work\b/, /\bi (?:recommend|suggest|propose)\b/,
]

/**
 * Extra signals for AI triage only. Plain failure verbs ("3 tests failed", "the build failed") must veto an auto-cleared
 * done card, but stay out of STRONG: for the hide guard (needsUser) a bare failure word is deliberately not a trigger
 * (the summary model and the other tail words decide). "a failure counter" is a topic and does not match.
 */
const TRIAGE_ONLY = [/\b(?:fail(?:ed|ing)|fails)\b/]

/** Signals that only mention a pull request, a handoff or a ticket: a veto for the hide, but not for AI triage (see needsUserForTriage). */
const MENTIONS = [
	/\bhand(?:ed)?[- ]?offs?\b/, // a handoff ("hand off", "handed off", "hand-off") is for the next session: the user starts or checks it
	/\b(pull requests?|prs?\s*#?\d+)\b|\bpr[- ]?wait\b/, // a pull request waits for a review or a merge; a PR-WAIT heartbeat is the poll for its comments
	/\b(tickets?|work items?)\b|\bab#\d+/, // a ticket or work item to confirm or follow up
]

/** Every signal, in one list for needsUser. */
const NEEDS_USER = [...STRONG, ...MENTIONS]

/** "0 failures", "no errors", "without errors" are the good kind of the words above. */
const CLEAN = /\b(0|zero|no|without|none|nothing)\s+(?:tests?\s+|new\s+)?(?:fail\w*|errors?|warnings?|regressions?|issues?|problems?)\b/gi

/** How many trailing paragraphs hold the part addressed to the user. */
const TAIL_PARAGRAPHS = 2

const stripCode = (text) => text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')

/** The last paragraphs (split on blank lines) of the reply, code removed; paragraphs left empty by that are not counted. */
function tailOf(reply) {
	const paragraphs = stripCode(reply).split(/\r?\n[ \t]*\r?\n/).map((p) => p.trim()).filter(Boolean)
	return paragraphs.slice(-TAIL_PARAGRAPHS).join('\n\n')
}

function check(reply, patterns) {
	if (typeof reply !== 'string' || !reply.trim()) return true
	const tail = tailOf(reply)
	if (!tail) return true // nothing but code: we cannot tell, so show it
	const text = tail.replace(CLEAN, ' ').toLowerCase().replace(/[’‘]/g, "'") // curly apostrophes read like straight ones
	return patterns.some((re) => re.test(text))
}

/** True when the message must stay in the list whatever the model said. */
export function needsUser(reply) {
	return check(reply, NEEDS_USER)
}

/** The raw (code kept) last paragraphs of the reply. */
const rawTailOf = (reply) => reply.split(/\r?\n[ \t]*\r?\n/).map((p) => p.trim()).filter(Boolean).slice(-TAIL_PARAGRAPHS).join('\n\n')

/** True when inline or fenced code in the raw tail holds a "?": stripCode hides it from the normal scan, but a question in backticks is still a question. */
function codeQuestionInTail(reply) {
	if (typeof reply !== 'string') return false
	const tail = rawTailOf(reply)
	const fenced = tail.match(/```[\s\S]*?```/g) ?? []
	const inline = tail.replace(/```[\s\S]*?```/g, ' ').match(/`[^`\n]*`/g) ?? []
	return [...fenced, ...inline].some((c) => c.includes('?'))
}

/** Like needsUser, but a tail that only mentions a pull request, a handoff or a ticket does not count, and a "?" inside code in the tail does (AI triage of done cards). */
export function needsUserForTriage(reply) {
	return check(reply, [...STRONG, ...TRIAGE_ONLY]) || codeQuestionInTail(reply)
}

/** A "?" (or fullwidth "？") anywhere in the whole reply, code included; a URL query string (`?b=1`) does not count. Fails closed on a non-string or blank reply. */
export function questionAnywhere(reply) {
	if (typeof reply !== 'string' || !reply.trim()) return true
	return /[?？]/.test(reply.replace(/\bhttps?:\/\/\S+/gi, ' '))
}

/**
 * Failure and blocker wording, scanned over the WHOLE reply for an ended session (code removed, clean phrases like "0 failures" masked).
 * Deliberately a superset of the failure/blocker words of STRONG and TRIAGE_ONLY, which only look at the tail: keep them in step when adding words.
 */
const PROBLEM = [
	/\bfail(?:ed|s|ing)\b/, /\bunable to\b/, /\bcannot\b/, /\bcan't\b/, /\bcouldn't\b/, /\bcould not\b/, /\bblocked\b/, /\bstuck\b/,
	/\bnot (?:yet )?(?:done|finished|fixed|working|tested)\b/, /\bawaiting\b/, /\bfollow-?ups?\b/, /\bremaining work\b/,
]

/** True when failure or blocker wording appears anywhere in the reply. Broad on purpose: it only vetoes. Fails closed on a non-string or blank reply. */
export function problemAnywhere(reply) {
	if (typeof reply !== 'string' || !reply.trim()) return true
	const text = stripCode(reply).replace(CLEAN, ' ').toLowerCase().replace(/[’‘]/g, "'")
	return PROBLEM.some((re) => re.test(text))
}

const BACKGROUND = [
	/\bstill (?:running|going|executing|working|processing)\b/, /\bin the background\b/, /\bbackground\b/, /\b(?:is|are|it['’]s|they['’]re) running\b/, /\bin progress\b/, /\bongoing\b/, /\bpending\b/,
	/\bwill (?:continue|keep)\b/, /\bcontinu(?:es|ing)\b/, /\b(?:kicked off|launched|started|spawned)\b/, /\bnohup\b/,
]

/** True when anywhere in the reply says work is still running or will continue: from an ended session that work was abandoned unseen. Fails closed on a non-string or blank reply. */
export function mentionsBackgroundWork(reply) {
	if (typeof reply !== 'string' || !reply.trim()) return true
	const text = reply.toLowerCase()
	return BACKGROUND.some((re) => re.test(text))
}
