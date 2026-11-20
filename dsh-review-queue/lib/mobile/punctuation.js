/**
 * Spoken and automatic punctuation for the phone's dictation. The Web Speech engine returns one run-on sentence with no punctuation, so this
 * local layer (pure: no DOM, no network, free and instant) does three things before any model is involved:
 *   - spoken words become symbols ("comma" -> ",", "question mark" -> "?", "new line" -> a line break; 逗号 -> ，for a Chinese mic language);
 *     they are always converted, so a real noun such as "period" or "colon" becomes a symbol too;
 *   - the first letter of each sentence and line is capitalised (plain words only). A word is left exactly as spoken when it has a digit or any
 *     of # / _ . inside (ab#26344, src/index.js, snake_case, node.js), an inner capital (getUser, iPhone, iOS), or is one of the lower-case
 *     tech words in KEEP_LOWER (npm, pnpm, git, npx, yarn, eslint, kubectl, docker);
 *   - the pause-based sentence end: a finished chunk gets a full stop unless it already ends in punctuation (endSentence).
 * It also holds the pure helpers of the cleanup flow (the Haiku polish of a finished dictation): cleanWorthy (is a dictated part worth a model
 * call), dictatedPart (the text dictated after the base) and applyCleaned (put the cleaned text back, or drop it when the box changed meanwhile).
 */

// Kinds: attach (glued to the previous word, space after), brk (line break, no spaces around), open (space before, none after),
// close (none before, space after; the same spacing as attach), join (no space either side), word (a spaced mark, like a word: " - ").
const PHRASES = new Map([
  ['question mark', ['attach', '?']],
  ['exclamation mark', ['attach', '!']],
  ['exclamation point', ['attach', '!']],
  ['full stop', ['attach', '.']],
  ['semi colon', ['attach', ';']],
  ['new paragraph', ['brk', '\n\n']],
  ['new line', ['brk', '\n']],
  ['open quote', ['open', '"']],
  ['close quote', ['close', '"']],
  ['end quote', ['close', '"']],
  ['open parenthesis', ['open', '(']],
  ['close parenthesis', ['close', ')']],
  ['open paren', ['open', '(']],
  ['close paren', ['close', ')']],
  ['comma', ['attach', ',']],
  ['period', ['attach', '.']],
  ['colon', ['attach', ':']],
  ['semicolon', ['attach', ';']],
  ['newline', ['brk', '\n']],
  ['hyphen', ['join', '-']],
  ['dash', ['word', '-']],
])
const MAX_PHRASE_WORDS = 2

// Mandarin words, applied only for a Chinese mic language. Longest names first is not needed: none is a part of another.
// Performance: the patterns are built once here, not per interim result (this runs on every speech-recognition update).
const ZH_WORDS = [['新段落', '\n\n'], ['换行', '\n'], ['逗号', '，'], ['句号', '。'], ['问号', '？'], ['感叹号', '！'], ['冒号', '：'], ['分号', '；']]
  .map(([word, symbol]) => [new RegExp('[ \\t]*' + word + '[ \\t]*'), symbol])

const isChinese = (lang) => typeof lang === 'string' && /^zh/i.test(lang)
// The English words are applied for an English or unset mic language, and for a Chinese one (mixed speech); in Italian or Spanish \"comma\" and \"colon\" are ordinary words.
const usesEnglishWords = (lang) => !lang || typeof lang !== 'string' || /^(en|zh)/i.test(lang)

/** The spoken punctuation words of `text` replaced by their symbols, with the spacing of written text. */
export function applySpokenPunctuation(text, lang) {
  let s = typeof text === 'string' ? text : ''
  if (isChinese(lang)) for (const [pattern, symbol] of ZH_WORDS) s = s.split(pattern).join(symbol)
  const words = s.split(/[ \t]+/).filter(Boolean)
  if (!usesEnglishWords(lang)) return words.join(' ') // same spacing, no spoken-word conversion
  let out = ''
  let glue = true // true: no space before the next word (start of text, after a line break, an opening mark or a hyphen)
  for (let i = 0; i < words.length;) {
    let hit
    let used = 1
    for (let n = Math.min(MAX_PHRASE_WORDS, words.length - i); n >= 1 && !hit; n--) {
      hit = PHRASES.get(words.slice(i, i + n).join(' ').toLowerCase())
      if (hit) used = n
    }
    i += used
    if (!hit) { out += (glue ? '' : ' ') + words[i - 1]; glue = false; continue }
    const [kind, symbol] = hit
    if (kind === 'attach' || kind === 'close') { out += symbol; glue = false } // no space before, a space after
    else if (kind === 'word') { out += (glue ? '' : ' ') + symbol; glue = false } // a spaced mark, like a word
    else if (kind === 'brk') { out += symbol; glue = true }
    else if (kind === 'open') { out += (glue ? '' : ' ') + symbol; glue = true }
    else { out += symbol; glue = true } // join
  }
  return out
}

const CORE = /^(["“‘(\[]*)(\p{L}[\p{L}'’]*)([.,;:!?"”’)\]。！？，；：]*)$/u
const ENDS_SENTENCE = /[.?!。？！][”"')\]]*$/
const INNER_CAPITAL = /\p{Ll}\p{Lu}/u // getUser, iPhone, iOS
// Commands and tools that are written in lower case: kept as spoken at a sentence start. Only these exact words (not "gitlab" or "dockerfile").
const KEEP_LOWER = new Set(['npm', 'pnpm', 'git', 'npx', 'yarn', 'eslint', 'kubectl', 'docker'])
// Abbreviations whose full stop does not end a sentence ("e.g. the api" stays lower case). Only these exact tokens: an ordinary word before a full stop still ends one.
const ABBREVIATION = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'mr.', 'mrs.', 'ms.', 'dr.', 'approx.'])
/** A token without the opening marks before it and the marks after it other than its own full stop, lower-cased: "(E.g.," -> "e.g.". */
const bareOf = (token) => token.replace(/^["“‘(\[]+/, '').replace(/[,;:!?"”’)\]]+$/, '').toLowerCase()

/**
 * The first letter of each sentence is upper case: the start (when atStart), after . ? ! and after a line break. Only plain words are changed;
 * a word stays as spoken when it has digits, # / _ or an inner dot (ab#26344, node.js, src/index.js, snake_case), when it has an inner capital
 * (getUser, iPhone) or when it is one of the lower-case tech words in KEEP_LOWER (npm, git ...). A full stop that closes an abbreviation (e.g., i.e., etc.,
 * vs., Mr.) does not start a new sentence.
 */
export function capitalizeSentences(text, atStart) {
  if (typeof text !== 'string' || !text) return ''
  let cap = atStart === true
  let out = ''
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue
    if (/^\s+$/.test(part)) { if (part.includes('\n')) cap = true; out += part; continue }
    let word = part
    if (cap) {
      const m = CORE.exec(part)
      if (m && !INNER_CAPITAL.test(m[2]) && !KEEP_LOWER.has(m[2])) word = m[1] + m[2][0].toUpperCase() + m[2].slice(1) + m[3]
      cap = false
    }
    if (ENDS_SENTENCE.test(part) && !ABBREVIATION.has(bareOf(part))) cap = true
    out += word
  }
  return out
}

/** True when text read so far ends a sentence (or is empty or ends a line), so the next dictated word starts a new one. */
function startsSentence(base) {
  return !base || /(^|[.?!。？！][”"')\]]*|\n)[ \t]*$/.test(base)
}

/**
 * The box text after dictation: `base` (what was in the box when dictation started, never changed) plus the transcript with its spoken
 * punctuation applied and its sentences capitalised. Merging into the captured base lets a refined interim result replace the previous one.
 */
export function formatDictation(base, transcript, lang) {
  let b = base == null ? '' : String(base)
  const t = transcript == null ? '' : String(transcript)
  if (!t.trim()) return b
  const spoken = applySpokenPunctuation(t.trim(), lang)
  if (!spoken) return b
  const dictated = capitalizeSentences(spoken, startsSentence(b))
  // The pause closes a chunk with an automatic stop; a mark spoken first in the next chunk must not double it ("world., and"). A base that ends in a
  // single stop (the pause's, or typed: they cannot be told apart) gives way to a comma, colon or semicolon, is replaced by a stronger ? or !, and
  // absorbs a spoken stop (an ellipsis is left alone).
  if (/[^.][.。]$/.test(b)) {
    if (/^[,;:，；：?!？！]/.test(dictated)) b = b.slice(0, -1)
    else if (/^[.。]/.test(dictated)) return b + dictated.slice(1) // the rest already starts with its own space, if any
  }
  if (/^[,.;:!?，。；：！？)\n]/.test(dictated)) b = b.replace(/[ \t]+$/, '')
  else if (b && !/\s$/.test(b)) b += ' '
  return b + dictated
}

/** A full stop (or 。 after Chinese) when the text does not already end in punctuation or a line break: the pause-based sentence end. */
export function endSentence(text) {
  if (typeof text !== 'string') return ''
  if (!text.trim() || /\n$/.test(text)) return text
  const trimmed = text.replace(/[ \t]+$/, '')
  if (/[.?!:;,。？！：；，…"”)\]]$/.test(trimmed)) return text
  // A text that ends in an opening or joining mark (a spoken dash or bracket) is still going on: a stop would land after the mark ("word -.").
  if (/[-–—(\[{]$/.test(trimmed)) return text
  // Arabic, Devanagari and Thai do not end a sentence with the ASCII stop: left as spoken.
  if (/[\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F]$/.test(trimmed)) return text
  return trimmed + (/[\u3400-\u9fff]$/.test(trimmed) ? '。' : '.')
}

// The notice for a cleanup that failed. Silent (null) for the expected failures: no coordinator app online ('no-registry'), no Haiku model ('no model
// available'), the route's own limit ('rate-limited'), a lost pairing ('signed-out': the phone goes back to pairing), nothing to clean ('empty'), another cleanup still running ('busy') or replaced by a newer one ('superseded'),an older coordinator app that does not know the command ('unknown-command'), the app not answering in time ('owner-timeout') and the app going away while the hub waited for it ('owner-offline', 'unknown-outcome', 'shutting-down').
const SILENT_CLEAN_FAILURES = new Set(['no-registry', 'no model available', 'rate-limited', 'signed-out', 'empty', 'busy', 'unknown-command', 'owner-timeout', 'owner-offline', 'unknown-outcome', 'shutting-down', 'superseded'])
/** The message to show for a failed cleanup (`error` is the code cleanDictation answered), or null to stay quiet: the local text simply stays. */
export function cleanFailureNote(error) {
  return SILENT_CLEAN_FAILURES.has(error) ? null : 'Could not tidy the text: kept as dictated.'
}

// The longest dictated part sent for cleanup. It MUST equal MAX_DICTATION in follow-up-shared.js (the hub and the service refuse longer text); this file runs on the phone
// and cannot import that server-side module, so a test pins the two numbers together.
export const CLEAN_MAX_CHARS = 2000

/**
 * True when a dictated part is worth a model cleanup: at least 3 words, or 6 CJK characters (a short phrase is left as it is), and at most CLEAN_MAX_CHARS characters
 * (a longer part would only be refused by the hub: it is left as dictated).
 */
export function cleanWorthy(part) {
  if (typeof part !== 'string') return false
  if (part.length > CLEAN_MAX_CHARS) return false
  if ((part.match(/[\u3400-\u9fff]/g) || []).length >= 6) return true
  return part.trim().split(/\s+/).filter(Boolean).length >= 3
}

/** The text dictated after `base` (trimmed): '' when the box no longer starts with the base it had when dictation began. */
export function dictatedPart(base, full) {
  const b = base == null ? '' : String(base)
  const f = full == null ? '' : String(full)
  return f.startsWith(b) ? f.slice(b.length).trim() : ''
}

/**
 * The box text with the dictated part (after `base`) replaced by the cleaned text, or null (drop the result) when the box is no longer exactly
 * what was sent for cleaning (the user typed or dictated more meanwhile) or the cleaned text is empty. The separator after the base is kept.
 */
export function applyCleaned({ base, sent, current, cleaned }) {
  const c = typeof cleaned === 'string' ? cleaned.trim() : ''
  if (!c || typeof current !== 'string' || current !== sent) return null
  const b = base == null ? '' : String(base)
  if (!current.startsWith(b)) return null
  const rest = current.slice(b.length)
  const separator = rest.slice(0, rest.length - rest.trimStart().length)
  return b + separator + c
}
