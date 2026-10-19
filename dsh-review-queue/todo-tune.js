/**
 * The "Tune prompt" button of the new-todo form: the typed task is rewritten by the model with the rules of the user's prompt-tune
 * skill (steps 2 to 4 of its command file, without the lines that ask for a rationale) and the result is put back in the box. Nothing is added to the Task list and nothing is
 * started; the user reads the result and can undo it. Same llm service and model pick as the summaries (summary.js) and the
 * workspace suggestions (todo.js).
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pickModel, within } from './summary.js'
import { MAX_TODO } from './todo.js'

export const DEFAULT_RULES_PATH = join(homedir(), '.claude', 'skills', 'prompt-tune', 'commands', 'prompt-tune.md')
const SECTION_START = '## 2. Parse the profile flag'
const SECTION_END = '## 5. Show the before/after'
const NO_MODEL = 'no model available'
const EMPTY = 'the model returned nothing'
const TOO_LONG = 'the tuned prompt is longer than ' + MAX_TODO + ' characters'
const ERROR_CHARS = 200
/** What the client is told for any provider failure: the provider's own message can carry endpoints or key fragments and goes to the log only. */
const LLM_ERROR = 'LLM error'
const EMPTY_TEXT = 'empty'
/** Last in the system prompt, so it wins over any rule above that asks for a rationale or a reason: the answer goes into the box as it is. */
const OVERRIDE = 'OVERRIDE, wins over every rule above: output only the rewritten prompt, nothing else: no rationale, no explanation of what changed or why, no notes, '
  + "no preface, no trailing section, and no 'because ...' reason after a suggested default. A Decide item is just '<question>? Suggested default: <X>.'"
/** The most of the rules file that goes to the model (a hand-edited or wrong file must not blow up every request). */
export const MAX_RULES_CHARS = 12000

/** A short copy of the rules, for a machine without the skill file (or whose file has no such section). */
export const EMBEDDED_RULES = `## Profile
The profile is concise by default, or thorough when the user asked for it.

## Rewrite
Count the paragraphs of the prompt. A single paragraph becomes one line of this formula: [VERB] [WHAT] in [WHERE]. [CONSTRAINT].
More than one paragraph becomes a numbered task list, one self-contained item per distinct step, with a one-line header "[VERB] [WHAT] in [WHERE]." only when every paragraph shares one target.
- concise: compress every constraint, qualifiers included, into one terse clause per line or item; the shortest correct wording.
- thorough: expand the constraints into explicit sub-constraints (edge cases, output format, a verification step); a numbered list when the prompt bundles sub-steps. At most 3 open implementation choices, each as one question with a suggested default and nothing after it; leave out anything the code itself can settle.

## Always
Preserve every detail of the prompt, hedges and qualifiers included ("something like", "roughly", "for now"): compress wording, never requirements.
Never resolve an unstated implementation choice by inventing a specific: a word that is not in the prompt and not a pure synonym of one that is does not go in. Where the prompt is neutral, stay neutral.
The result is unambiguous, self-contained and free of anything the model would have to guess.
`

/** The path to read: the default for none, the string given, nothing for anything else (a number would be read as a file descriptor, not a path). */
const rulesFileOf = (path) => (path === undefined || path === null ? DEFAULT_RULES_PATH : typeof path === 'string' ? path : undefined)

/**
 * The rules the model may follow: every line that tells it to write or note a rationale is gone (the box takes the prompt and nothing else),
 * and so is the ", because <reason>" clause of the Decide item template.
 */
const withoutRationale = (rules) => rules.split('\n').filter((line) => !/rationale/i.test(line)).join('\n').replace(/,[ \t]*because[ \t]*<[^>\n]*>/gi, '').replace(/\n{3,}/g, '\n\n')

/**
 * The rules section of the prompt-tune command file without its rationale instructions (at most MAX_RULES_CHARS); the embedded copy when the
 * path is not a string, or the file is missing, unreadable or has no such section. Never throws.
 */
export function loadRules(path) {
  const file = rulesFileOf(path)
  if (file === undefined) return EMBEDDED_RULES
  try {
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const from = text.indexOf(SECTION_START)
    const to = text.indexOf(SECTION_END, from)
    return from >= 0 && to > from ? withoutRationale(text.slice(from, to)).slice(0, MAX_RULES_CHARS).trimEnd() : EMBEDDED_RULES
  } catch { return EMBEDDED_RULES }
}

/**
 * The rules for each call, cached by the file's mtime and size (an edit of the skill applies at once, an untouched file is not read again),
 * and the resolved path logged once on the first load so a wrong or missing file can be traced.
 */
function createRulesSource(path, log) {
  const file = rulesFileOf(path)
  let cached // { key, rules }
  let logged = false
  return () => {
    let key = 'none'
    try { if (file !== undefined) { const st = statSync(file); key = st.mtimeMs + ':' + st.size } } catch { /* missing: the embedded rules, and a file that appears later is a new key */ }
    if (cached?.key !== key) cached = { key, rules: loadRules(path) }
    if (!logged) {
      logged = true
      log('todo-tune: rules file ' + (file ?? String(typeof path)) + (cached.rules === EMBEDDED_RULES ? ' not usable, using the embedded rules' : ' loaded (' + cached.rules.length + ' characters)'))
    }
    return cached.rules
  }
}

const FLAG_RE = /(^|\s)--(concise|thorough)\s*$/

// A closing explanation of the rewrite (the model writes one although it is told not to): the last paragraph of the answer, from a label line to the end.
// Only a trailing block goes: the same words inside the prompt, or followed by more prompt, stay. Which label lines count:
//   "Rationale:" at any line start of the last paragraph (also as the whole answer);
//   a wrapped label ("**Why:**", "*Why: ...*", "(Explanation: ...)", "*(Rationale: ...)*") under a line of the prompt, except Note(s);
//   a plain label ("Changes:", "- Why:") or a Note(s) label as a paragraph of its own, or right after a '---' / '***' separator line;
//   an italic or parenthesised remark that starts with Changed, Rewrote, I or This right after a separator line.
// The separator in front of a removed block goes with it.
const LABELS = 'rationale|notes?|changes|changed|what changed|why|explanation|summary of changes|reasoning'
const BULLET = String.raw`^[ \t]*(?:[-*+][ \t]+)?`
const PLAIN_LABEL = new RegExp(BULLET + '(' + LABELS + ')[ \\t]*:', 'i')
const WRAPPED_LABEL = new RegExp(BULLET + String.raw`(?:\*\*|__|\*\(|_\(|\(|\*|_)[ \t]*` + '(' + LABELS + ')' + String.raw`(?:\*\*|__|\*|_)?[ \t]*:`, 'i')
const WRAPPED_REMARK = /^[ \t]*(?:\*\*|__|\*\(|_\(|\(|\*|_)[ \t]*(?:Changed|Rewrote|I|This)\b/
const SEPARATOR = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/
const isBlank = (line) => line.trim() === ''
const isRationale = (label) => label.toLowerCase() === 'rationale'
const isNote = (label) => /^notes?$/i.test(label)

/** The line where the closing explanation starts, or -1. */
function closingBlockStart(lines) {
  let p = lines.length
  while (p > 0 && !isBlank(lines[p - 1])) p--
  const afterSeparator = (i) => { let j = i - 1; while (j >= 0 && isBlank(lines[j])) j--; return j >= 0 && SEPARATOR.test(lines[j]) }
  for (let i = p; i < lines.length; i++) {
    const line = lines[i]
    const plain = PLAIN_LABEL.exec(line)
    const wrapped = WRAPPED_LABEL.exec(line)
    const label = (plain ?? wrapped)?.[1]
    const own = (i === p && p > 0) || afterSeparator(i) // a paragraph of its own, or right after a separator
    if (label !== undefined && (isRationale(label) || own || (wrapped && !isNote(label) && i > 0))) return i
    if (WRAPPED_REMARK.test(line) && afterSeparator(i)) return i
  }
  return -1
}

function withoutTrailingNotes(text) {
  let lines = text.split('\n')
  for (let n = 0; n < 6; n++) {
    const at = closingBlockStart(lines)
    if (at < 0) break
    lines = lines.slice(0, at)
    while (lines.length && (isBlank(lines.at(-1)) || SEPARATOR.test(lines.at(-1)))) lines.pop()
  }
  return lines.join('\n').trimEnd()
}

// A Decide item is "<question>? Suggested default: <X>." with no reason: the ", because ..." / "; because ..." clause after the default goes, up to the end of its
// sentence (a full stop followed by a capital or a digit) or of its line; the closing punctuation stays.
const DEFAULT_REASON = /[,;][ \t]*because\b[^\n]*?([.!?])(?=[ \t]+[A-Z0-9]|[ \t]*(?:\n|$))|[,;][ \t]*because\b[^\n]*/g
const withoutDefaultReasons = (text) => text.split('\n').map((line) => {
  const at = line.indexOf('Suggested default:')
  return at < 0 ? line : line.slice(0, at) + line.slice(at).replace(DEFAULT_REASON, (_all, stop) => stop ?? '')
}).join('\n')

/** The model answer as a prompt: no trailing rationale/explanation block, no reason after a suggested default, no surrounding code fence, no leading label ("Optimized:", "Tuned prompt:"). */
function cleanAnswer(raw) {
  const unlabeled = withoutDefaultReasons(withoutTrailingNotes(raw.trim())).replace(/^(?:optimized|tuned prompt)\s*:\s*/i, '')
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(unlabeled)
  return (fenced && !fenced[1].includes('```') ? fenced[1] : unlabeled).trim()
}

/** The failure of a model call as { error, logged }: the client's words (a generic LLM error for a provider failure) and the line for the log (with the detail). */
function reasonOf(error, timeoutMs) {
  const message = String(error?.message ?? error).replace(/\s+/g, ' ').trim()
  if (message === 'timed out') { const text = 'timed out after ' + timeoutMs / 1000 + ' s'; return { error: text, logged: text } }
  if (message === NO_MODEL) return { error: NO_MODEL, logged: NO_MODEL }
  // Security: provider messages (endpoints, key fragments) never reach the browser; the detail stays in the log.
  return { error: LLM_ERROR, logged: LLM_ERROR + ': ' + message.slice(0, ERROR_CHARS) }
}

/** The prompt without its trailing profile flag, and the profile the flag asked for (concise without one). */
function parseFlag(text) {
  const flag = FLAG_RE.exec(text)
  return { body: flag ? text.slice(0, flag.index) : text, profile: flag ? flag[2] : 'concise' }
}

/**
 * tune(text, { signal }) -> { ok: true, text } | { ok: false, error }; never throws. rulesText wins over the rulesPath file
 * (checked on every call and reloaded when its mtime changes, so an edit of the skill applies at once), and without either the default skill file is used.
 */
export function createTuner({ llm, rulesText, rulesPath, timeoutMs = 60000, maxTokens = 1500, log = () => {} } = {}) {
  let chosen
  const rules = createRulesSource(rulesPath, log)
  async function ask({ body, profile }, signal) {
    if (!llm) throw new Error(NO_MODEL)
    const mine = (chosen ??= pickModel(llm, undefined, timeoutMs))
    let m
    try { m = await mine } catch (error) { if (chosen === mine) chosen = undefined; throw error }
    if (!m) { if (chosen === mine) chosen = undefined; throw new Error(NO_MODEL) }
    const system = 'You rewrite the prompt the user gives you, following the rules below. Profile: ' + profile + '.\n'
      + 'Answer with only the rewritten prompt: no preface, no rationale, no code fence around it. Never ask a question: when the prompt is ambiguous, make a best effort. '
      + "Keep the user's wording where it is already clear, preserve every detail and invent nothing.\n\n" + (rulesText ?? rules()) + '\n\n' + OVERRIDE
    const prepared = await llm.prepareCall({ provider: m.provider, model: m.model, maxTokens }, signal)
    let out = ''
    for await (const chunk of prepared.stream({
      ...prepared.config, system, signal,
      messages: [{ role: 'user', content: [{ type: 'text', text: body }] }],
    })) if (chunk.type === 'text-delta') out += chunk.text
    return out
  }
  async function tune(text, { signal } = {}) {
    if (typeof text !== 'string') return { ok: false, error: 'no text to tune' }
    if (signal?.aborted) return { ok: false, error: 'cancelled' }
    const parsed = parseFlag(text)
    if (!parsed.body.trim()) return { ok: false, error: EMPTY_TEXT } // only a flag was typed: nothing to rewrite, no model call
    const ac = new AbortController()
    let error
    let logged
    try {
      const answer = cleanAnswer(await within(ask(parsed, ac.signal), timeoutMs, signal))
      if (!answer) error = EMPTY
      else if (answer.length > MAX_TODO) error = TOO_LONG
      else return { ok: true, text: answer }
    } catch (e) {
      ac.abort()
      ;({ error, logged } = e?.message === 'aborted' ? { error: 'cancelled' } : reasonOf(e, timeoutMs))
    }
    log('todo-tune: ' + (logged ?? error))
    return { ok: false, error }
  }
  return { tune }
}
