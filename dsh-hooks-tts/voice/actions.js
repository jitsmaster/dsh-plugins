import { randomUUID } from 'node:crypto'
import { permissionHeadline } from './headline.js'
import { cleanTitle, speakableText } from './sanitize.js'

/**
 * Pure helpers for the voice flow's action stage: validate the decider's raw JSON into a frozen-ready action,
 * phrase it for the read-back, map it onto the app's collaborators, and phrase the spoken result.
 * The LLM only ever sees session handles ("s1".."sN"); validation swaps them for real ids.
 */

const ACTIONS = new Set(['switch', 'prompt', 'new', 'approve', 'deny', 'cancel', 'slash', 'clarify'])
// A voice prompt is read back in full before it runs; much more than this cannot be confirmed by ear.
const MAX_TEXT = 1500
const MAX_ARGS = 500
const MAX_QUESTION = 200
const INVALID = Object.freeze({ ok: false, error: 'invalid' })
const NO_SESSION = Object.freeze({ ok: false, error: 'no-session' })
const TOO_LONG = Object.freeze({ ok: false, error: 'too-long' })
const STALE_TEXT = 'That request changed. Nothing done.'

/** Trimmed string, '' when absent, or undefined when the value is present but not a string. */
function str(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim() : undefined
}

/**
 * Text that will be both read back and executed: '' when absent, undefined (= invalid) when it is not a string or holds
 * hidden/control characters, markdown links or backticks (see sanitize.js); newlines become spaces.
 */
function spoken(value) {
  if (value === undefined || value === null) return ''
  return speakableText(value)
}

const fits = (text, min, max) => text !== undefined && text.length >= min && text.length <= max
const ordinal = (s) => String(s.handle).replace(/^s/, '')
const plainTitle = (s) => cleanTitle(s.title) || 'session ' + ordinal(s)

/** The spoken name of a session; a title another session shares also gets its ordinal ("Fix tests, session 2"). */
function titleOf(s, sessions = []) {
  const title = plainTitle(s)
  const shared = sessions.some((o) => o.handle !== s.handle && plainTitle(o).toLowerCase() === title.toLowerCase())
  return shared ? title + ', session ' + ordinal(s) : title
}
const resolved = (s, sessions) => ({ sessionId: s.id, title: titleOf(s, sessions) })

/** The default voice target: selected, else the last session that alerted, else the last active one. */
function defaultSession(sessions, target = {}) {
  const id = target.selected ?? target.lastAlerted ?? target.lastActive
  return id === undefined ? undefined : sessions.find((s) => s.id === id)
}

/** { session } for an explicit handle or the default target, or { error } ('invalid' | 'no-session'). */
function pickSession(raw, { sessions = [], target }) {
  const handle = str(raw.session)
  if (handle === undefined) return { error: INVALID }
  if (handle) {
    const named = sessions.find((s) => s.handle === handle)
    return named ? { session: named } : { error: INVALID }
  }
  if (raw.action === 'switch') return { error: INVALID }
  const fallback = defaultSession(sessions, target)
  return fallback ? { session: fallback } : { error: NO_SESSION }
}

function validateNew(raw, opts) {
  const text = spoken(raw.text)
  if (text === undefined) return INVALID
  if (text.length > MAX_TEXT) return TOO_LONG
  // The default target only lends its cwd to the new session; with no target the host default cwd is used.
  const target = defaultSession(opts.sessions ?? [], opts.target)
  return { ok: true, action: { action: 'new', ...(target ? { sessionId: target.id } : {}), ...(text ? { text } : {}) } }
}

function validateClarify(raw) {
  const question = spoken(raw.question)
  return fits(question, 1, MAX_QUESTION) ? { ok: true, action: { action: 'clarify', question } } : INVALID
}

/** Per-action fields for actions bound to a session (already resolved to { sessionId, title }). */
function sessionFields(raw, where, { peek, slashNames }) {
  switch (raw.action) {
    case 'prompt': {
      const text = spoken(raw.text)
      if (text === undefined || !text.length) return INVALID
      return text.length > MAX_TEXT ? TOO_LONG : { text }
    }
    case 'approve':
    case 'deny': {
      const pending = peek?.({ sessionId: where.sessionId })
      // The peeked token is frozen into the action so execution can refuse a request that changed meanwhile.
      if (!pending) return { ok: false, error: 'no-approval', title: where.title }
      // The summary and the count are frozen with the token: the read-back says what the user is about to approve.
      return {
        toolName: pending.toolName, token: pending.token,
        summary: typeof pending.summary === 'string' ? pending.summary : '', pendingCount: pending.count ?? 1,
      }
    }
    case 'slash': {
      const name = str(raw.name)?.replace(/^\/+/, '').trim()
      const args = spoken(raw.args)
      if (!name || !fits(args, 0, MAX_ARGS)) return INVALID
      return (slashNames?.(where.sessionId) ?? []).includes(name) ? { name, args } : INVALID
    }
    default:
      return {}
  }
}

/**
 * Validate the decider's raw object. Returns { ok:true, action } with unknown keys dropped and strings trimmed, or
 * { ok:false, error:'invalid'|'no-session'|'no-approval', title? }.
 */
export function validateAction(raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !ACTIONS.has(raw.action)) return INVALID
  if (raw.action === 'clarify') return validateClarify(raw)
  if (raw.action === 'new') return validateNew(raw, opts)
  const picked = pickSession(raw, opts)
  if (picked.error) return picked.error
  const where = resolved(picked.session, opts.sessions ?? [])
  const fields = sessionFields(raw, where, opts)
  if (fields.ok === false) return fields
  return { ok: true, action: { action: raw.action, ...where, ...fields } }
}

/** headline.js permission wording without its "Approve ...?" frame: pwsh -> "run command", my_tool -> "my tool". */
export const toolPhrase = (toolName) => permissionHeadline({ toolName }).replace(/^Approve /, '').replace(/\?$/, '')

/** "run command rm -rf build": what is approved, with "details not available" when the tool input was unknown. */
const approvalPhrase = (action) => toolPhrase(action.toolName) + ' ' + (action.summary || 'details not available')

/** More than one pending request: say so, since approve/deny answers the newest. */
const pendingNote = (action) => (action.pendingCount > 1 ? ', the newest of ' + action.pendingCount + ' pending requests' : '')

/** The x in "I will {x}. Shall I do it?" — built only from the validated action, never from LLM prose. */
export function readBack(action) {
  switch (action.action) {
    case 'switch': return 'talk to ' + action.title
    case 'prompt': return 'send to ' + action.title + ': ' + action.text
    case 'new': return 'start a new session' + (action.text ? ' and send: ' + action.text : '')
    case 'approve':
    case 'deny': return action.action + ' ' + approvalPhrase(action) + ' in ' + action.title + pendingNote(action)
    case 'cancel': return 'stop the run in ' + action.title
    case 'slash': return 'run slash ' + action.name + (action.args ? ' ' + action.args : '') + ' in ' + action.title
    default: return 'do that'
  }
}

/** The final spoken line after execute(action) resolved with result. */
export function resultText(action, result) {
  if (result?.stale) return STALE_TEXT
  switch (action.action) {
    case 'switch': return 'Now talking to ' + action.title + '.'
    case 'prompt': return 'Sent to ' + action.title + '.'
    case 'new': return 'New session started.' + (action.text ? ' Prompt sent.' : '')
    case 'approve': return 'Approved.'
    case 'deny': return 'Denied.'
    case 'cancel': return 'Stopped ' + action.title + '.'
    default: return 'Done.'
  }
}

/**
 * Maps a validated action onto exactly the collaborator calls it means. Rejects with the collaborator's error;
 * an approval whose token changed (or vanished) since the read-back resolves { stale: true } and answers nothing.
 */
export function createExecutor({ controller, runSlash, approvals, select, cwdOf, uuid = () => randomUUID().slice(0, 8) }) {
  const prompt = (sessionId, text) =>
    controller.prompt({ requestId: 'voice-' + uuid(), sessionId, mode: 'queue', content: [{ type: 'text', text }] })

  async function startNew(action) {
    const cwd = action.sessionId === undefined ? undefined : cwdOf(action.sessionId)
    const { sessionId } = await controller.create(cwd === undefined ? {} : { cwd })
    select(sessionId)
    if (action.text) await prompt(sessionId, action.text)
    return { sessionId }
  }

  function answer(action) {
    const pending = approvals.peek({ sessionId: action.sessionId })
    if (!pending || pending.token !== action.token) return { stale: true }
    return approvals.answer({ sessionId: action.sessionId, decision: action.action })
  }

  return async function execute(action) {
    switch (action.action) {
      case 'switch': select(action.sessionId); return {}
      case 'prompt': return (await prompt(action.sessionId, action.text)) ?? {}
      case 'new': return startNew(action)
      case 'approve':
      case 'deny': return answer(action)
      case 'cancel': return (await controller.cancel({ sessionId: action.sessionId })) ?? {}
      case 'slash': return (await runSlash({ sessionId: action.sessionId, name: action.name, input: action.args ? ' ' + action.args : '' })) ?? {}
      default: throw new Error('Unknown action ' + action.action)
    }
  }
}
