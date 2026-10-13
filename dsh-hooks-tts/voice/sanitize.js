/**
 * Text hygiene for everything the voice flow speaks or sends to the decider LLM. The speak path (scripts/tts-client.ps1
 * Clean-ForSpeech) drops markdown link targets, backticks, | ~ ^ _ * # and non-ASCII letters, and humans cannot hear
 * zero-width or control characters at all, so text carrying them would be confirmed unheard (security: the user must
 * hear EXACTLY what will execute). Titles and descriptions come from other programs and are untrusted.
 */

/** Control, format (zero-width, bidi, BOM, soft hyphen), private-use and lone-surrogate chars, tag chars, invisible fillers and variation selectors. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u{E0000}-\u{E007F}\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u
const UNSAFE_RUN = new RegExp('(?:' + UNSAFE.source + ')+', 'gu')
/** What Clean-ForSpeech keeps: printable ASCII and the CJK blocks. */
const CJK = '\\u4E00-\\u9FFF\\u3400-\\u4DBF\\uF900-\\uFAFF'
const NOT_SPEAKABLE = new RegExp('[^\\x20-\\x7E' + CJK + ']+', 'gu')
const NOT_ASCII = /[^\x20-\x7E]/u
const NOT_ASCII_OR_CJK = new RegExp('[^\\x20-\\x7E' + CJK + ']', 'u')
const HAS_CJK = new RegExp('[' + CJK + ']', 'u')
/**
 * Free text must survive Clean-ForSpeech unchanged: its dropped symbols (| ~ ^ _ * # backtick and the [ ] of links) and a dash
 * between spaces (also at either end, where the read-back's own words are the neighbours) would be executed but not heard.
 */
const DROPPED = /[|~^_*#[\]`]|(?:^|\s)-(?:\s|$)/

const NEWLINES = /\r\n|\r|\n/g

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
export function speakableText(value, { allowCjk = false } = {}) {
  if (typeof value !== 'string') return undefined
  const flat = value.replace(NEWLINES, ' ')
  if (UNSAFE.test(flat)) return undefined
  const text = collapse(typographic(flat.normalize('NFKC')))
  if (UNSAFE.test(text) || (allowCjk ? NOT_ASCII_OR_CJK : NOT_ASCII).test(text) || DROPPED.test(text)) return undefined
  return text
}

/** The utterance the flow echoes and hands to the decider, cut at max chars: { ok:true, text } | { ok:false, error:'invalid'|'too-long' }. */
export function speakableUtterance(value, max = 1500) {
  if (typeof value !== 'string') return { ok: false, error: 'invalid' }
  if (value.length > max * 2) return { ok: false, error: 'too-long' }
  const text = speakableText(value, { allowCjk: true })
  if (text === undefined) return { ok: false, error: 'invalid' }
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
  const flat = collapse(String(value ?? '').replace(NEWLINES, ' ').replace(/\t/g, ' '))
  const cut = flat.length > max
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
