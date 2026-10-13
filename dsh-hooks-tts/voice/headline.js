import { spokenName, spokenSummaryInfo } from './sanitize.js'

const QUESTION_WORDS = 15

const TOOL_SPEECH = {
  write: 'write file', edit: 'edit file', read: 'read file', pwsh: 'run command', bash: 'run command',
  web_fetch: 'fetch web page', web_search: 'search the web', subagent: 'start subagent', run_code: 'run code',
}

/** Own keys only: a tool called "constructor" must not resolve to Object.prototype.constructor. */
export const isKnownTool = (toolName) => typeof toolName === 'string' && Object.hasOwn(TOOL_SPEECH, toolName)

/** Longest spoken tool name in a permission alert: long MCP names must not be cut mid-word (spokenName's default is 40). */
const TOOL_NAME_MAX = 80

/**
 * A tool's spoken wording: the fixed phrase of a known tool; any other name as the speaker will say it (see sanitize.js spokenName),
 * prefixed "unknown tool" when it would sound like a known phrase (a tool named run_command must not pass for pwsh).
 */
function toolWords(toolName) {
  if (isKnownTool(toolName)) return TOOL_SPEECH[toolName]
  const words = spokenName(String(toolName ?? ''), TOOL_NAME_MAX).text.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'tool'
  return Object.values(TOOL_SPEECH).includes(words) ? 'unknown tool ' + words : words
}

/** Collapse whitespace and keep at most max words, marking a cut with an ellipsis. */
export function capWords(text, max) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  return words.length <= max ? words.join(' ') : words.slice(0, max).join(' ') + '...'
}

/**
 * The last prose paragraph of a markdown reply, ready to be read aloud: code blocks are dropped, wrapped
 * lines are joined, and a final bullet list becomes sentences.
 */
export function lastParagraph(text) {
  const clean = String(text ?? '').replace(/\r\n?/g, '\n').replace(/(```|~~~)[^\n]*\n[\s\S]*?(\1|$)/g, '\n\n')
  const last = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).at(-1) ?? ''
  const lines = last.split('\n').map((l) => l.trim()).filter(Boolean)
  const marker = /^([-*+]|\d+[.)])\s+/
  return lines.length && lines.every((l) => marker.test(l))
    ? lines.map((l) => l.replace(marker, '')).join('. ')
    : lines.join(' ')
}

/** "Done on: Session: <title>; Workspace: <name>. <last paragraph>", leaving out whatever is not known. */
export function stopHeadline({ session, workspace, summary }) {
  const where = [session && 'Session: ' + session, workspace && 'Workspace: ' + workspace].filter(Boolean).join('; ')
  return 'Done' + (where ? ' on: ' + where : '') + '.' + (summary ? ' ' + summary : '')
}

export function questionHeadline({ questions }) {
  const first = (Array.isArray(questions) ? questions : [])
    .map((q) => q?.question)
    .find((q) => typeof q === 'string' && q.trim())
  return first ? 'Question: ' + capWords(first, QUESTION_WORDS) : 'Question.'
}

export function permissionHeadline({ toolName }) {
  return 'Approve ' + toolWords(toolName) + '?'
}

/**
 * The input fields that say what a tool call will do, most telling first (command, code, file path, URL, query ...).
 * Model-written prose (description, prompt, task) is deliberately NOT here: it need not match what executes.
 */
const OPERAND_KEYS = ['command', 'cmd', 'script', 'code', 'file_path', 'filePath', 'path', 'url', 'query']

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

/** The operand as { text, complete }: an identified field of the input, or the JSON of the whole input (never complete). */
function operandOf(data) {
  const key = OPERAND_KEYS.find((k) => nonEmpty(data[k]))
  if (key) return spokenSummaryInfo(data[key])
  if (!Object.keys(data).length) return { text: undefined, complete: false }
  return { text: spokenSummaryInfo(JSON.stringify(data)).text, complete: false }
}

/** What the call does beyond its operand and that a listener must know: running outside the sandbox, where, and in the background. */
function modifiersOf(data) {
  const parts = []
  let complete = true
  if (data.sandbox_permissions) parts.push('outside the sandbox')
  if (data.workdir !== undefined && data.workdir !== null && data.workdir !== '') {
    const dir = nonEmpty(data.workdir) ? spokenSummaryInfo(data.workdir) : { text: undefined, complete: false }
    if (dir.text) parts.push('in directory ' + dir.text)
    complete = dir.complete
  }
  if (data.run_in_background === true) parts.push('in the background')
  return { parts, complete }
}

/**
 * What a pending tool call will do, as one bounded sentence fragment for the spoken approve/deny read-back, with whether
 * it is COMPLETE (a known tool whose operand was read in full: not cut, nothing hidden or replaced). Only a complete
 * summary may be approved by voice. The first ~100 characters of the command / code / file path / URL (see sanitize.js
 * spokenSummaryInfo), then "outside the sandbox", the work directory and "in the background" when they apply.
 * text is undefined when the input is unknown.
 */
export function toolSummaryInfo(toolName, input) {
  let data = input
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch {
      const raw = spokenSummaryInfo(data)
      return raw.text ? { text: raw.text, complete: raw.complete && isKnownTool(toolName) } : { complete: false }
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { complete: false }
  const operand = operandOf(data)
  if (!operand.text) return { complete: false }
  const extra = modifiersOf(data)
  return { text: [operand.text, ...extra.parts].join(', '), complete: operand.complete && extra.complete && isKnownTool(toolName) }
}

/** toolSummaryInfo's text only (undefined when the input is unknown). */
export const toolSummary = (toolName, input) => toolSummaryInfo(toolName, input).text

/**
 * Adds the approval request's own reason (why the asker needs a decision, e.g. an escalation) to a summary, so it is heard
 * too. A reason that does not fit is cut and makes the summary incomplete. Without any summary text there is nothing to add to.
 */
export function withReason(info, reason) {
  if (!info?.text || !nonEmpty(reason)) return info
  const said = spokenSummaryInfo(reason, 150)
  if (!said.text) return info
  return { text: info.text + ', reason: ' + said.text, complete: info.complete && said.complete }
}
