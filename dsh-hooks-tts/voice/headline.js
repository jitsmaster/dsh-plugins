const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']

const QUESTION_WORDS = 15

const TOOL_SPEECH = {
  write: 'write file', edit: 'edit file', read: 'read file', pwsh: 'run command', bash: 'run command',
  web_fetch: 'fetch web page', web_search: 'search the web', subagent: 'start subagent',
}

/** Spell small numbers so the TTS says them cleanly; larger ones stay digits. */
export const spoken = (n) => (Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : String(n))

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** Collapse whitespace and keep at most max words, marking a cut with an ellipsis. */
export function capWords(text, max) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  return words.length <= max ? words.join(' ') : words.slice(0, max).join(' ') + '...'
}

export const stopHeadline = ({ number, project }) =>
  [cap(spoken(number)), project, 'done'].filter(Boolean).join(', ') + '.'

export function questionHeadline({ number, questions }) {
  const first = (Array.isArray(questions) ? questions : [])
    .map((q) => q?.question)
    .find((q) => typeof q === 'string' && q.trim())
  return `${cap(spoken(number))}, question${first ? ': ' + capWords(first, QUESTION_WORDS) : '.'}`
}

export function permissionHeadline({ number, toolName }) {
  const what = TOOL_SPEECH[toolName] ?? String(toolName ?? 'tool').replace(/[_-]+/g, ' ')
  return `${cap(spoken(number))}, approve ${what}?`
}
