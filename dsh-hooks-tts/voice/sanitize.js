/**
 * Text hygiene for everything the voice flow speaks or sends to the decider LLM. The speak path (scripts/tts-client.ps1
 * Clean-ForSpeech) drops markdown link targets, backticks, | ~ ^ _ * # and non-ASCII letters, and humans cannot hear
 * zero-width or control characters at all, so text carrying them would be confirmed unheard (security: the user must
 * hear EXACTLY what will execute). Titles and descriptions come from other programs and are untrusted.
 */

/** Control, format (zero-width, bidi, BOM, soft hyphen), private-use and lone-surrogate chars, tag chars, invisible fillers and variation selectors. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u{E0000}-\u{E007F}\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u
const UNSAFE_RUN = new RegExp('(?:' + UNSAFE.source + ')+', 'gu')
/** Markdown link syntax ("](") and backticks: Clean-ForSpeech would read a link as its label only, or drop the backticks. */
const MARKUP = /`|\]\(/
/** What Clean-ForSpeech keeps: printable ASCII and the CJK blocks. */
const NOT_SPEAKABLE = /[^\x20-\x7E\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]+/gu

const NEWLINES = /\r\n|\r|\n/g

/** Spoken names of the ASCII characters Clean-ForSpeech would silently drop. */
const SYMBOL_WORDS = { '`': ' backtick ', '|': ' pipe ', '~': ' tilde ', '^': ' caret ', _: ' underscore ', '*': ' star ', '#': ' hash ', '[': ' left bracket ', ']': ' right bracket ' }

const collapse = (text) => text.replace(/\s+/g, ' ').trim()

/**
 * Free text that will be spoken AND executed (prompt text, slash args, a clarify question): newlines become spaces,
 * whitespace is collapsed, and it is undefined (= reject) when it holds a control/format/tag/private-use char, a markdown
 * link or a backtick. The result is what is spoken, so what executes equals what was heard.
 */
export function speakableText(value) {
  if (typeof value !== 'string') return undefined
  const text = value.replace(NEWLINES, ' ')
  if (UNSAFE.test(text) || MARKUP.test(text)) return undefined
  return collapse(text)
}

/** An untrusted label (session title, slash description): unsafe chars and link/backtick markup stripped, whitespace collapsed, cut to max. */
export function cleanLabel(value, max) {
  if (typeof value !== 'string') return ''
  const flat = collapse(value.replace(UNSAFE_RUN, ' ').replace(/[\[\]`]/g, ''))
  return flat.slice(0, max).trimEnd()
}

export const cleanTitle = (value, max = 40) => cleanLabel(value, max)

/**
 * The first max characters of a tool's command/path/URL as it can be heard: hidden characters and non-ASCII letters
 * become spoken warnings, the symbols Clean-ForSpeech drops are spelled out, and a cut says "and more".
 * undefined when nothing is left.
 */
export function spokenSummary(value, max = 100) {
  const flat = collapse(String(value ?? '').replace(NEWLINES, ' ').replace(/\t/g, ' '))
  const cut = flat.length > max
  let text = flat.slice(0, max)
  text = text.replace(UNSAFE_RUN, ' hidden character ').replace(NOT_SPEAKABLE, ' unusual character ')
  text = text.replace(/[`|~^_*#[\]]/g, (c) => SYMBOL_WORDS[c])
  text = collapse(collapse(text).replace(/ - /g, ' dash '))
  if (!text) return undefined
  return cut ? text + ' and more' : text
}
