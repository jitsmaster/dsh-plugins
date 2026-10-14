/**
 * Text hygiene for everything the voice flow speaks or sends to the decider LLM. The speak path (scripts/tts-client.ps1
 * Clean-ForSpeech) drops markdown link targets, backticks, | ~ ^ _ * # and non-ASCII letters, and humans cannot hear
 * zero-width or control characters at all, so text carrying them would be confirmed unheard (security: the user must
 * hear EXACTLY what will execute). Titles and descriptions come from other programs and are untrusted.
 */

/** The text cut to at most max UTF-8 bytes; a character cut in half at the end is dropped, not left as U+FFFD. */
export const cutBytes = (text, max) => (Buffer.byteLength(text) <= max ? text : Buffer.from(text).subarray(0, max).toString('utf8').replace(/\uFFFD+$/, ''))

/** Control, format (zero-width, bidi, BOM, soft hyphen), private-use and lone-surrogate chars, tag chars, invisible fillers and variation selectors. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u{E0000}-\u{E007F}\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u
const UNSAFE_RUN = new RegExp('(?:' + UNSAFE.source + ')+', 'gu')
/** What Clean-ForSpeech keeps: printable ASCII and the CJK blocks. */
const CJK = '\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uF900-\\uFAFF'
const NOT_SPEAKABLE = new RegExp('[^\\x20-\\x7E' + CJK + ']+', 'gu')
const NOT_ASCII = /[^\x20-\x7E]/u
const NOT_ASCII_OR_CJK = new RegExp('[^\\x20-\\x7E' + CJK + ']', 'u')
const HAS_CJK = new RegExp('[' + CJK + ']', 'u')
/** The one list of symbols Clean-ForSpeech drops (a regex character-class body); DROPPED and FOLDABLE are both built from it. */
const DROPPED_SYMBOLS = '|~^_*#\\[\\]`'
/**
 * Free text must survive Clean-ForSpeech unchanged: its dropped symbols (| ~ ^ _ * # backtick and the [ ] of links) and a dash
 * between spaces (also at either end, where the read-back's own words are the neighbours) would be executed but not heard.
 */
const DROPPED = new RegExp('[' + DROPPED_SYMBOLS + ']|(?:^|\\s)-(?:\\s|$)')

const NEWLINES = /\r\n|\r|\n/g
/** Dictation symbols that Clean-ForSpeech drops (see DROPPED), plus en/em dashes, which it also turns into spaces. */
const FOLDABLE = new RegExp('[' + DROPPED_SYMBOLS + '\\u2013\\u2014]', 'g')
/** A maximal run of foldable symbols ("|", "***", "_ _" is two runs). */
const FOLDABLE_RUN = new RegExp('[' + DROPPED_SYMBOLS + '\\u2013\\u2014]+', 'g')
/**
 * True when some run of foldable symbols is NOT delimited by whitespace (or a string boundary) on BOTH sides. Any other neighbour
 * (a word, path or flag character, a quote, bracket, $ ! @ < > = : , ; + % & #, a CJK or other non-ASCII letter, another
 * non-foldable symbol) means the symbol is part of something ("~/x", "*.log", "foo_bar", '"*"', "#!/bin/bash", "$_"), so folding
 * it to a space would change what executes: the whole utterance is rejected instead. A run is judged by its two outer neighbours.
 */
function foldWouldChangeMeaning(text) {
  for (const m of text.matchAll(FOLDABLE_RUN)) {
    const before = text[m.index - 1]
    const after = text[m.index + m[0].length]
    if ((before !== undefined && !/\s/.test(before)) || (after !== undefined && !/\s/.test(after))) return true
  }
  return false
}

/** Spoken names of the ASCII characters that are dropped by Clean-ForSpeech or that are shell syntax a listener could not otherwise tell apart. */
const SYMBOL_WORDS = {
  '`': ' backtick ', '|': ' pipe ', '~': ' tilde ', '^': ' caret ', _: ' underscore ', '*': ' star ', '#': ' hash ', '[': ' left bracket ', ']': ' right bracket ',
  '>': ' greater than ', '<': ' less than ', '&': ' ampersand ', ';': ' semicolon ', $: ' dollar ', '(': ' open paren ', ')': ' close paren ',
  '{': ' open brace ', '}': ' close brace ', '\\': ' backslash ', '"': ' quote ', "'": ' apostrophe ', '=': ' equals ', '!': ' bang ',
}
const SPELLED = /[`|~^_*#[\]><&;$(){}\\"'=!]/g

const collapse = (text) => text.replace(/\s+/g, ' ').trim()

/** Typographic quotes are heard exactly as their ASCII twins, so they are folded rather than rejected (STT engines emit them). */
const typographic = (text) => text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')

/** True when the text holds a CJK ideograph (what Clean-ForSpeech lets through besides ASCII). */
export const hasCjk = (value) => typeof value === 'string' && HAS_CJK.test(value.normalize('NFKC'))

/**
 * A JS port of scripts/tts-client.ps1 Clean-ForSpeech (cross-checked against the real function in voice-scripts.test.mjs):
 * what the listener actually hears of a text.
 */
export function cleanForSpeech(value) {
  let text = String(value ?? '')
  if (text.length > 4000) text = text.slice(0, 4000)
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,6}\s*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[\u2013\u2014]/g, ' ')
    .replace(/\s+-\s+/g, ' ')
    .replace(/[|~^_]/g, ' ')
    .replace(new RegExp('[^\\x20-\\x7E\\r\\n' + CJK + ']', 'g'), '  ')
}

/**
 * Free text that will be spoken AND executed (prompt text, slash args, a clarify question): newlines become spaces,
 * whitespace is collapsed, and the text is NFKC-normalised (fullwidth latin becomes the ASCII that is heard). It is undefined
 * (= reject) when it then holds anything but printable ASCII (CJK ideographs only when allowCjk: the confirmed utterance
 * itself contained CJK), a control/format/tag/private-use char, or a symbol the speaker drops (see DROPPED).
 * The result is what is spoken, so what executes equals what was heard.
 */
export function speakableText(value, { allowCjk = false, fold = false } = {}) {
  if (typeof value !== 'string') return undefined
  const flat = value.replace(NEWLINES, ' ')
  if (UNSAFE.test(flat)) return undefined
  let normal = typographic(flat.normalize('NFKC'))
  // fold: the symbols and dashes the speaker drops become spaces BEFORE the checks, so the folded text (the one that is echoed,
  // decided on and executed) is exactly what is heard. Only symbol runs delimited by whitespace (or the string ends) on both sides fold: one with any other neighbour
  // ("rm -rf ~/x", "*.log", "foo_bar.txt", '"*"', "$_") would silently change meaning, so the whole text is rejected. Hidden and
  // non-ASCII characters are never folded: they are rejected too.
  if (fold && foldWouldChangeMeaning(normal)) return undefined
  // A lone "-" token (whitespace-delimited single hyphen: "cd -") is NOT folded: Clean-ForSpeech drops it, so dropping it silently would
  // execute "cd -" after the user heard "cd". It stays in the text and the DROPPED check below rejects the whole utterance.
  if (fold) normal = normal.replace(FOLDABLE, ' ')
  const text = collapse(normal)
  if (UNSAFE.test(text) || (allowCjk ? NOT_ASCII_OR_CJK : NOT_ASCII).test(text) || DROPPED.test(text)) return undefined
  return text
}

/** The utterance the flow echoes and hands to the decider, cut at max chars: { ok:true, text } | { ok:false, error:'invalid'|'too-long' }. */
export function speakableUtterance(value, max = 1500) {
  if (typeof value !== 'string') return { ok: false, error: 'invalid' }
  if (value.length > max * 2) return { ok: false, error: 'too-long' }
  const text = speakableText(value, { allowCjk: true, fold: true })
  // Nothing but folded symbols is not an utterance (a blank input keeps its old result).
  if (text === undefined || (text === '' && value.trim() !== '')) return { ok: false, error: 'invalid' }
  return text.length > max ? { ok: false, error: 'too-long' } : { ok: true, text }
}

/** An untrusted label (session title, slash description): unsafe chars and link/backtick markup stripped, whitespace collapsed, cut to max. */
export function cleanLabel(value, max) {
  if (typeof value !== 'string') return ''
  const flat = collapse(value.replace(UNSAFE_RUN, ' ').replace(/[\[\]`]/g, ''))
  return flat.slice(0, max).trimEnd()
}

export const cleanTitle = (value, max = 40) => cleanLabel(value, max)

/**
 * A name (session title, tool name) as the speaker will really say it: cleaned like cleanLabel, then run through the same
 * transformation as Clean-ForSpeech (symbols dropped, _ becomes a space, non-ASCII gone), so two names that sound alike
 * compare equal. altered = the spoken form (before the length cut) differs from the written one.
 */
export function spokenName(value, max = 40) {
  const before = collapse(typeof value === 'string' ? value.replace(NEWLINES, ' ') : '')
  const clean = before.normalize('NFKC').replace(UNSAFE_RUN, ' ').replace(/[\[\]`]/g, '')
  const heard = collapse(cleanForSpeech(clean))
  return { text: heard.slice(0, max).trimEnd(), altered: heard !== before }
}

/**
 * The first max characters of a tool's command/path/URL as it can be heard: the symbols Clean-ForSpeech drops and the shell
 * syntax characters are spelled out, hidden characters and non-ASCII letters become spoken warnings, and a cut says "and more".
 * complete = nothing was cut, hidden or replaced (the user heard exactly the operand). text undefined when nothing is left.
 */
export function spokenSummaryInfo(value, max = 100) {
  // Bounded work: a huge operand (a pasted file) is cut BEFORE the whitespace collapse. Whitespace can shrink the slice, so the
  // margin is generous, and anything cut off still counts as cut (never complete).
  const raw = String(value ?? '')
  const window = raw.slice(0, max * 16)
  const flat = collapse(window.replace(NEWLINES, ' ').replace(/\t/g, ' '))
  const cut = flat.length > max || window.length < raw.length
  const head = flat.slice(0, max)
  // Anything the listener cannot hear as written (hidden or non-ASCII characters) makes the summary incomplete.
  const hidden = UNSAFE.test(head) || NOT_ASCII_OR_CJK.test(head)
  let text = head.replace(UNSAFE_RUN, ' hidden character ').replace(NOT_SPEAKABLE, ' unusual character ')
  text = text.replace(SPELLED, (c) => SYMBOL_WORDS[c])
  text = collapse(collapse(text).replace(/(^|\s)-(?=\s|$)/g, ' dash '))
  if (!text) return { text: undefined, complete: false }
  return { text: cut ? text + ' and more' : text, complete: !cut && !hidden }
}

export const spokenSummary = (value, max = 100) => spokenSummaryInfo(value, max).text
