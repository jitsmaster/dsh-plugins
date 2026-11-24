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
/** At most this many questions go back to the client, each cut at MAX_QUESTION_CHARS. */
export const MAX_QUESTIONS = 5
export const MAX_QUESTION_CHARS = 300
const OVERRIDE = 'OVERRIDE, wins over every rule above: output only the rewritten prompt, nothing else: no rationale, no explanation of what changed or why, no notes, '
  + "no preface, no trailing section, and no 'because ...' reason after a suggested default. A Decide item is just '<question>? Suggested default: <X>.' "
  + 'QUESTIONS: never put questions in the rewritten prompt, not even a Decide list. Put every open choice the rules call for after the prompt, on a line of its own that says QUESTIONS:, '
  + "one per line as '<question>? Suggested default: <X>.' (at most " + MAX_QUESTIONS + '); they are asked of the user separately. Without an open choice write no QUESTIONS line. '
  + 'FORMAT, wins over the layout above: reply with one JSON object and nothing else, {"prompt": "<the rewritten prompt, as one string>", "questions": [{"question": "<question>?", "default": "<X>"}]}. '
  + 'The "prompt" holds only the rewritten prompt, never a question or a Decide list; every open choice or clarifying question goes in "questions" ("default" is optional, "questions" is [] when there is none).'
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

// A QUESTIONS heading ("QUESTIONS:", "**Questions:**", "Open questions", "Clarifying questions:"), alone on its line or with the questions on the same line (group 1).
// The colon separates the two trailing classes, so there are no adjacent optional runs (linear time).
const QUESTIONS_LINE = /^[ \t]*[*_]*(?:(?:open|clarifying)[ \t]+)?questions[ \t*_]*(?::[ \t*_]*([^\n]*))?$/im
const ITEM_BULLET = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/
const DEFAULT_MARK = 'Suggested default:'
const DECIDE_HEADING = /^[ \t]*[*_#]*[ \t]*decide\b[^\n]*$/i

/** One line of a question list as { question, default? }, or undefined for a blank one. The bullet or number in front and the closing full stop of the default are not part of it. */
function questionOf(line) {
  const body = line.replace(ITEM_BULLET, '').trim()
  if (!body) return undefined
  const at = body.indexOf(DEFAULT_MARK)
  const question = (at < 0 ? body : body.slice(0, at)).trim().slice(0, MAX_QUESTION_CHARS)
  if (!question) return undefined
  const given = at < 0 ? '' : body.slice(at + DEFAULT_MARK.length).trim().replace(/\.$/, '').trim()
  return given ? { question, default: given.slice(0, MAX_QUESTION_CHARS) } : { question }
}

/** One entry of the "questions" field as { question, default? }: a string, or an object with a text; anything else is skipped. */
function jsonQuestionOf(entry) {
  const text = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && typeof entry.question === 'string' ? entry.question : ''
  const question = text.trim().slice(0, MAX_QUESTION_CHARS)
  if (!question) return undefined
  const given = entry && typeof entry === 'object' && typeof entry.default === 'string' ? entry.default.trim().slice(0, MAX_QUESTION_CHARS) : ''
  return given ? { question, default: given } : { question }
}

/**
 * The model answer read as the structured reply it was asked for, { prompt, questions }: the whole answer (or the whole content of one code fence) is a JSON object
 * with a string "prompt". Anything else (prose around it, broken JSON, no string prompt) is undefined and goes through the shape rules.
 */
function jsonReply(raw) {
  let text = raw.trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced) text = fenced[1].trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return undefined
  let value
  try { value = JSON.parse(text) } catch { return undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.prompt !== 'string') return undefined
  const list = Array.isArray(value.questions) ? value.questions : []
  return { prompt: value.prompt, questions: list.map(jsonQuestionOf).filter(Boolean).slice(0, MAX_QUESTIONS) }
}

// Several questions on one line ("Which file? Suggested default: a.js. Which error?"): each "<question>?" with the default that may follow it.
const INLINE_QUESTION = /([^?\n]+\?)(?:[ \t]*Suggested default:[ \t]*(.*?)(?:\.(?=[ \t]+[A-Z0-9])|\.?$))?/gm

/** The questions of one line of a question list: a line with several question marks is split, any other line is one question. */
function questionsOfLine(line) {
  const body = line.replace(ITEM_BULLET, '')
  if ((body.match(/\?/g) ?? []).length < 2) return [questionOf(line)].filter(Boolean)
  const out = []
  for (const m of body.matchAll(INLINE_QUESTION)) {
    const question = m[1].trim().slice(0, MAX_QUESTION_CHARS)
    const given = (m[2] ?? '').trim().replace(/\.$/, '').trim()
    if (question) out.push(given ? { question, default: given.slice(0, MAX_QUESTION_CHARS) } : { question })
  }
  return out.length ? out : [questionOf(line)].filter(Boolean)
}

/** A first paragraph of nothing but questions, ahead of a prompt of its own, as { prompt, questions }; undefined for any other answer. */
function leadingQuestions(cleaned) {
  const paragraphs = cleaned.split(/\n[ \t]*\n/)
  if (paragraphs.length < 2) return undefined
  const head = paragraphs[0].replace(/\s*\n\s*/g, ' ').trim()
  if (!head.endsWith('?')) return undefined
  const pieces = head.split('?').map((p) => p.trim()).filter(Boolean)
  if (!pieces.length || pieces.some((p) => /[.!:;]/.test(p))) return undefined
  const rest = paragraphs.slice(1).join('\n\n').trim()
  if (!rest) return undefined
  return { prompt: rest, questions: pieces.map((p) => ({ question: (p + '?').slice(0, MAX_QUESTION_CHARS) })).slice(0, MAX_QUESTIONS) }
}

/**
 * The open questions of the model answer, apart from the prompt: { prompt, questions } (questions [] when there are none).
 * They come from a QUESTIONS: (or "Open/Clarifying questions") block after the prompt, on its own lines or on the heading's line, or, failing that, from the
 * "<question>? Suggested default: <X>." items of a Decide list inside a prompt that has text of its own. When the typed prompt is not itself a question, bulleted or numbered
 * lines that end in a question mark (no default) and a first paragraph of only questions go out too. An answer that is only such items comes back with an empty prompt and
 * the questions (a lead-in line such as "I need to know:" goes with them); tune() then keeps the typed text (flag stripped).
 */
function splitQuestions(raw, typedBody = '') {
  const structured = jsonReply(raw)
  if (structured) {
    // Fields, not shapes: the prompt is the box text and the questions are the asked ones. Only a Decide list the model left inside the prompt is still moved out
    // (the typed body is passed as a question so the loose shape rules stay off: nothing is guessed from how a JSON prompt reads).
    const inside = splitQuestions(structured.prompt, '?')
    return { prompt: inside.prompt, questions: [...structured.questions, ...inside.questions].slice(0, MAX_QUESTIONS), structured: true }
  }
  const typedAsks = typedBody.includes('?')
  const mark = QUESTIONS_LINE.exec(raw)
  if (mark) {
    const inline = (mark[1] ?? '').replace(/[ \t*_]+$/, '')
    const tail = raw.slice(mark.index + mark[0].length).trim()
    const text = withoutDefaultReasons(withoutTrailingNotes([inline, tail].filter(Boolean).join('\n')))
    const items = text.split('\n').flatMap(questionsOfLine)
    return { prompt: raw.slice(0, mark.index), questions: items.slice(0, MAX_QUESTIONS) }
  }
  const cleaned = cleanAnswer(raw)
  const lines = cleaned.split('\n')
  const endsAsking = (line) => /\?[ \t*_]*$/.test(line)
  // Loose items (a bullet or number that only ends in a question mark) count only when EVERY list line is such a question: a task list with one question in it is a prompt.
  const listLines = lines.filter((line) => ITEM_BULLET.test(line))
  const looseOk = !typedAsks && listLines.length > 0 && listLines.every(endsAsking)
  const isItem = (line) => ITEM_BULLET.test(line) && line.includes('?') && (line.includes(DEFAULT_MARK) || (looseOk && endsAsking(line)))
  const keep = lines.filter((line) => !isItem(line))
  if (keep.length === lines.length) return (!typedAsks && leadingQuestions(cleaned)) || { prompt: raw, questions: [] }
  const first = lines.findIndex(isItem)
  let heading = first - 1
  while (heading >= 0 && !lines[heading].trim()) heading--
  const dropHeading = heading >= 0 && DECIDE_HEADING.test(lines[heading]) ? heading : -1
  let rest = lines.filter((line, i) => !isItem(line) && i !== dropHeading).join('\n').trim()
  if (!rest.includes('\n') && rest.endsWith(':')) rest = '' // only a lead-in ("Before I rewrite this I need to know:") is left
  // No prompt of its own (only questions): the prompt is empty and tune() keeps what the user typed. Questions never replace the box text.
  return { prompt: rest, questions: lines.filter(isItem).map(questionOf).filter(Boolean).slice(0, MAX_QUESTIONS) }
}

/**
 * A model answer that is nothing but clarifying questions (the rules' "ask 1-2 questions when ambiguous" step), with no marker and no default:
 * every line ends with a question mark. Only when the typed prompt itself is not a question, so a prompt that is a question may still be rewritten as one.
 */
function plainQuestions(prompt, typedBody) {
  if (typedBody.includes('?')) return []
  const lines = cleanAnswer(prompt).split('\n').filter((l) => l.trim())
  if (!lines.length || !lines.every((l) => /\?[ \t*_]*$/.test(l.replace(ITEM_BULLET, '')))) return []
  return lines.map(questionOf).filter(Boolean).slice(0, MAX_QUESTIONS)
}

/** The failure of a model call as { error, logged }: the client's words (a generic LLM error for a provider failure) and the line for the log (with the detail). */
export function reasonOf(error, timeoutMs) {
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
 * tune(text, { signal }) -> { ok: true, text, questions? } | { ok: false, error }; never throws. questions: [{ question, default? }], the open choices that are asked of the user instead of
 * standing in the prompt (none: no key). rulesText wins over the rulesPath file
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
      + 'Answer with only the rewritten prompt: no preface, no rationale, no code fence around it. When the prompt is ambiguous, make a best effort; an open choice goes after the prompt as a question (see the end), never in it. '
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
      let { prompt, questions, structured } = splitQuestions(await within(ask(parsed, ac.signal), timeoutMs, signal), parsed.body)
      if (!questions.length && !structured) {
        const plain = plainQuestions(prompt, parsed.body)
        if (plain.length) { questions = plain; prompt = '' }
      }
      // Questions without a rewritten prompt: the typed text stays in the box (its trailing flag stripped, so a Decisions list added after it never strands the flag mid-text); the questions are asked apart.
      const answer = questions.length && !cleanAnswer(prompt) ? parsed.body.trimEnd() : cleanAnswer(prompt)
      if (!answer) error = EMPTY
      else if (answer.length > MAX_TODO) error = TOO_LONG
      else return questions.length ? { ok: true, text: answer, questions } : { ok: true, text: answer }
    } catch (e) {
      ac.abort()
      ;({ error, logged } = e?.message === 'aborted' ? { error: 'cancelled' } : reasonOf(e, timeoutMs))
    }
    log('todo-tune: ' + (logged ?? error))
    return { ok: false, error }
  }
  return { tune }
}
