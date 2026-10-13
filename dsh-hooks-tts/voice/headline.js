import { cleanTitle, spokenSummary } from './sanitize.js'

const QUESTION_WORDS = 15

const TOOL_SPEECH = {
  write: 'write file', edit: 'edit file', read: 'read file', pwsh: 'run command', bash: 'run command',
  web_fetch: 'fetch web page', web_search: 'search the web', subagent: 'start subagent',
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
  const what = TOOL_SPEECH[toolName] ?? (cleanTitle(String(toolName ?? '')) || 'tool').replace(/[_-]+/g, ' ')
  return 'Approve ' + what + '?'
}

/** The input fields that say what a tool call will do, most telling first (command, file path, URL, query ...). */
const SUMMARY_KEYS = ['command', 'cmd', 'script', 'file_path', 'filePath', 'path', 'url', 'query', 'prompt', 'task', 'description']

/**
 * What a pending tool call will do, as one bounded sentence fragment for the spoken approve/deny read-back: the first
 * ~100 characters of its command / file path / URL (see sanitize.js spokenSummary). undefined when the input is unknown.
 */
export function toolSummary(toolName, input) {
  let data = input
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { return spokenSummary(data) }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  for (const key of SUMMARY_KEYS) {
    if (typeof data[key] === 'string' && data[key].trim()) return spokenSummary(data[key])
  }
  return Object.keys(data).length ? spokenSummary(JSON.stringify(data)) : undefined
}
