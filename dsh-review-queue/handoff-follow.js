/**
 * "Follow handoff" on a done card: the card's reply says a handoff note was written, so one click opens a NEW session that resumes it (the sparcr flow of the
 * session menu's "Follow-up from handoff", published by dsh-hooks-tts as the service 'handoffFollowUp') and the follow-up archives the source session.
 */

// Source of truth: dsh-hooks-tts/handoffs.js (WRITE_WORD, TEXT_PATH, handoffMentions). Copied, not imported, because the plugins ship separately; keep in sync.
// lib/client.js holds a browser copy of handoffFollowable for the same reason.
const WRITE_WORD = /\b(?:written|wrote|write|writing|saved|created)\b/i
const TEXT_PATH = /`([^`\n]*?handoff\.md)`|((?<![\w.~-])(?:[A-Za-z]:[\\/]|\/)[^\s`"'<>|]*?handoff\.md)/gi
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/)/
// Performance/DoS fix: the reply is uncapped assistant text and TEXT_PATH backtracks quadratically on a long run of slashes, so only the last
// REPLY_TAIL chars are scanned and lines over LINE_MAX are skipped. lib/client.js has the same two numbers.
const REPLY_TAIL = 4000
const LINE_MAX = 1000

/**
 * Whether an item is an open done card whose reply says a handoff note was written to an absolute handoff.md path.
 * @param {unknown} item
 * @returns {boolean}
 */
export function handoffFollowable(item) {
	if (!item || item.type !== 'completed' || item.status !== 'open') return false
	if (typeof item.sessionId !== 'string' || item.sessionId === '') return false
	const reply = item.payload?.reply
	if (typeof reply !== 'string') return false
	for (const line of reply.slice(-REPLY_TAIL).split(/\r?\n/)) {
		if (line.length > LINE_MAX || !WRITE_WORD.test(line)) continue
		for (const m of line.matchAll(TEXT_PATH)) if (ABSOLUTE.test((m[1] ?? m[2] ?? '').trim())) return true
	}
	return false
}

/**
 * The server-side action. Errors are codes only: the note path and service messages never leave this module (a phone may be the caller).
 * @param {{ serviceOf: () => any, store: any, log?: (line: string) => void }} deps
 * @returns {{ follow: (itemId: string) => Promise<{ ok: true, sessionId: string } | { ok: false, error: string }> }}
 */
export function createHandoffFollow({ serviceOf, store, log }) {
	const inFlight = new Set() // a double click must not start two sessions
	const serviceNow = () => { try { return serviceOf() ?? undefined } catch { return undefined } }
	const fail = (error) => ({ ok: false, error })

	/** Asks the service; every outcome is a result, never a throw. */
	async function run(service, item) {
		let note
		try { note = service.latest(item.sessionId) } catch { log?.('handoff-follow: lookup failed'); return fail('failed') }
		if (!note) return fail('no-handoff')
		let result
		try { result = await service.followUp(item.sessionId) } catch { log?.('handoff-follow: follow-up failed'); return fail('failed') }
		if (result?.status === 404) return fail('no-handoff')
		if (result?.status === 409) return fail('follow-busy')
		if (result?.status !== 200 || typeof result.sessionId !== 'string' || result.sessionId === '') { log?.('handoff-follow: follow-up refused (' + String(result?.status) + ')'); return fail('failed') }
		return { ok: true, sessionId: result.sessionId }
	}

	return {
		async follow(itemId) {
			const item = store.get(itemId)
			if (!item) return fail('not-found')
			if (!handoffFollowable(item)) return fail('not-followable')
			if (inFlight.has(item.id)) return fail('follow-busy')
			const service = serviceNow()
			if (!service || typeof service.latest !== 'function' || typeof service.followUp !== 'function') return fail('unavailable')
			inFlight.add(item.id)
			try {
				const result = await run(service, item)
				// The follow-up archives the source session, which may already have closed this card: resolve only if it is still open.
				if (result.ok && store.get(item.id)?.status === 'open') store.resolve(item.id, { kind: 'handoff-followed', by: 'card', sessionId: result.sessionId })
				return result
			} finally { inFlight.delete(item.id) }
		},
	}
}
