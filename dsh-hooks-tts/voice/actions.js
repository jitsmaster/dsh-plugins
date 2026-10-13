import { randomUUID } from 'node:crypto'
import { permissionHeadline } from './headline.js'

/**
 * Pure helpers for the voice flow's action stage: validate the decider's raw JSON into a frozen-ready action,
 * phrase it for the read-back, map it onto the app's collaborators, and phrase the spoken result.
 * The LLM only ever sees session handles ("s1".."sN"); validation swaps them for real ids.
 */

const ACTIONS = new Set(['switch', 'prompt', 'new', 'approve', 'deny', 'cancel', 'slash', 'clarify'])
const MAX_TEXT = 4000
const MAX_ARGS = 500
const MAX_QUESTION = 200
const INVALID = Object.freeze({ ok: false, error: 'invalid' })
const NO_SESSION = Object.freeze({ ok: false, error: 'no-session' })
const STALE_TEXT = 'That request changed. Nothing done.'

/** Trimmed string, '' when absent, or undefined when the value is present but not a string. */
function str(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim() : undefined
}

const fits = (text, min, max) => text !== undefined && text.length >= min && text.length <= max
const titleOf = (s) => s.title || 'session ' + String(s.handle).replace(/^s/, '')
const resolved = (s) => ({ sessionId: s.id, title: titleOf(s) })

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
  const text = str(raw.text)
  if (!fits(text, 0, MAX_TEXT)) return INVALID
  // The default target only lends its cwd to the new session; with no target the host default cwd is used.
  const target = defaultSession(opts.sessions ?? [], opts.target)
  return { ok: true, action: { action: 'new', ...(target ? { sessionId: target.id } : {}), ...(text ? { text } : {}) } }
}

function validateClarify(raw) {
  const question = str(raw.question)
  return fits(question, 1, MAX_QUESTION) ? { ok: true, action: { action: 'clarify', question } } : INVALID
}

/** Per-action fields for actions bound to a session (already resolved to { sessionId, title }). */
function sessionFields(raw, where, { peek, slashNames }) {
  switch (raw.action) {
    case 'prompt': {
      const text = str(raw.text)
      return fits(text, 1, MAX_TEXT) ? { text } : INVALID
    }
    case 'approve':
    case 'deny': {
      const pending = peek?.({ sessionId: where.sessionId })
      // The peeked token is frozen into the action so execution can refuse a request that changed meanwhile.
      return pending ? { toolName: pending.toolName, token: pending.token } : { ok: false, error: 'no-approval', title: where.title }
    }
    case 'slash': {
      const name = str(raw.name)?.replace(/^\/+/, '').trim()
      const args = str(raw.args)
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
  const where = resolved(picked.session)
  const fields = sessionFields(raw, where, opts)
  if (fields.ok === false) return fields
  return { ok: true, action: { action: raw.action, ...where, ...fields } }
}

/** headline.js permission wording without its "Approve ...?" frame: pwsh -> "run command", my_tool -> "my tool". */
const toolPhrase = (toolName) => permissionHeadline({ toolName }).replace(/^Approve /, '').replace(/\?$/, '')

/** The x in "I will {x}. Shall I do it?" — built only from the validated action, never from LLM prose. */
export function readBack(action) {
  switch (action.action) {
    case 'switch': return 'talk to ' + action.title
    case 'prompt': return 'send to ' + action.title + ': ' + action.text
    case 'new': return 'start a new session' + (action.text ? ' and send: ' + action.text : '')
    case 'approve':
    case 'deny': return action.action + ' ' + toolPhrase(action.toolName) + ' in ' + action.title
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
