/**
 * Task-list voice commands (dsh-review-queue "task list", see dsh-review-queue/docs/voice-task-list.md).
 *
 * A pure phrase matcher: matchQueueCommand(text) → undefined | { kind, n? }. Only an utterance that IS the command
 * matches (optionally wrapped in polite filler); a normal prompt that merely contains such words ("stop the server",
 * "show the task list in the UI") must fall through to the LLM flow, so every pattern is anchored to the whole utterance.
 *
 *   show / hide                      "show me the task list", "close the queue"
 *   count                            "how many items are waiting", "what's in my queue"
 *   read { n }                       "read the first item", "read item two"   (n = 1-based queue position)
 *   next                             "read the next one", "next"
 *   again                            "read it again", "repeat", "say that again"
 *   stop                             "stop", "stop reading", "be quiet"
 *   open                             "open the first item", "open its session"
 *   reply { n: 1 }                   "reply to the first item" (the first item only)
 */
import { normalize } from './answers.js'

/** Longer than this many words is never a command (and skips the regex work). */
const MAX_WORDS = 14

const UNITS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth']
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50 }
/** What a speech recogniser writes for "two"/"four"/"one" right after "item"/"number". */
const HOMOPHONES = { to: 2, too: 2, for: 4, won: 1 }

const NUM_WORD = [...Object.keys(HOMOPHONES), ...UNITS].sort((a, b) => b.length - a.length).join('|')
/** One number as words (one..twenty, twenty one, twenty-one → "twenty one" after normalisation) or digits. */
const NUM = `(?:${Object.keys(TENS).join('|')}) (?:${UNITS.slice(0, 9).join('|')})|${NUM_WORD}|\\d{1,3}`
const ORD = `(?:${ORDINALS.join('|')}|\\d{1,3}(?:st|nd|rd|th))`
const NOUN = '(?:item|task|thing|entry|one)'
/** The task list under any of its names. */
const LIST = '(?:(?:the|my|our) )?(?:task list|tasks|queue|review queue|review list|to do list|todo list)'

const FILLER_LEAD = /^(?:(?:hey|hi|ok|okay|please|kindly|(?:can|could|would|will) you|i would like you to|id like you to|i want you to|lets|go ahead and) )+/
const FILLER_TRAIL = /(?: (?:please|thanks|thank you|now|for me))+$/

const numberOf = (word) => {
  if (word === undefined) return undefined
  if (/^\d+/.test(word)) return Number.parseInt(word, 10)
  if (word in HOMOPHONES) return HOMOPHONES[word]
  const [a, b] = word.split(' ')
  if (b !== undefined) return TENS[a] + (UNITS.indexOf(b) + 1)
  return UNITS.indexOf(a) + 1
}
const ordinalOf = (word) => (/^\d/.test(word) ? Number.parseInt(word, 10) : ORDINALS.indexOf(word) + 1)

/** "the first item" / "first one" / "item two" / "number 3" / "item number 4" → 1-based position, else undefined via no match. */
const POSITION = `(?:(?:the )?(${ORD}) ${NOUN}|(?:the )?(?:item|task|entry|number|no)(?: number)? (${NUM}))`

const READ_VERB = '(?:read(?: me| out(?: loud)?| aloud)?|play)'
const IT = '(?:it|that|this|that one|the item|that item|the last one|the last item)'

/** [kind, pattern, (match) => result]. First match wins; patterns are anchored to the whole normalised utterance. */
const RULES = [
  ['show', new RegExp(`^(?:show(?: me)?|open|display|bring up|pull up|view) ${LIST}$`), () => ({ kind: 'show' })],
  ['hide', new RegExp(`^(?:hide|close|dismiss) ${LIST}$`), () => ({ kind: 'hide' })],
  ['count', new RegExp(`^(?:(?:can you |could you )?(?:please )?tell me )?how many (?:(?:items|tasks|things|reviews|entries)(?: are| do i have| i have| do i have waiting)?|are)(?: (?:waiting|pending|left|there))?(?: (?:in|on) ${LIST})?(?: (?:waiting|pending|left))?$`), () => ({ kind: 'count' })],
  ['count', new RegExp(`^(?:whats|what is|what are) (?:in|on) ${LIST}$`), () => ({ kind: 'count' })],
  ['count', new RegExp(`^(?:(?:whats|what is) (?:waiting|pending)(?: for me)?|(?:is )?(?:there )?anything (?:waiting|pending)(?: (?:in|on) ${LIST})?)$`), () => ({ kind: 'count' })],
  ['read', new RegExp(`^${READ_VERB} ${POSITION}$`), (m) => {
    const n = m[1] !== undefined ? ordinalOf(m[1]) : numberOf(m[2])
    return n >= 1 ? { kind: 'read', n } : undefined
  }],
  ['next', new RegExp(`^(?:${READ_VERB} (?:me )?)?(?:the )?next(?: ${NOUN})?$`), () => ({ kind: 'next' })],
  ['again', new RegExp(`^(?:(?:repeat|${READ_VERB}|say)(?: ${IT})? again|repeat(?: ${IT})?)$`), () => ({ kind: 'again' })],
  ['stop', /^(?:stop(?: (?:reading|talking|speaking|that|it|the reading)(?: it)?)?|be quiet|quiet)$/, () => ({ kind: 'stop' })],
  ['open', new RegExp(`^open (?:the )?(?:(?:first|1st|top|oldest) (?:(?:item|task|entry)(?:s? session)?|one)|item (?:one|1)|session (?:of|for) the first item|its session|the items session)$`), () => ({ kind: 'open' })],
  ['reply', new RegExp(`^reply to (?:the )?(?:(?:first|1st) ${NOUN}|item(?: number)? (?:one|1))$`), () => ({ kind: 'reply', n: 1 })],
]

/** Lower-case, NFKC, hidden characters gone, punctuation to spaces, filler removed. */
function clean(text) {
  const plain = String(text).normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, (c) => (/\s/.test(c) ? ' ' : ''))
  // "task-list" / "to-do" read as separate words; the apostrophe in "what's" / "item's" is dropped by normalize (so "items session").
  const norm = normalize(plain)
  // Words are counted before the filler is stripped, so a pile of "please" is not a command either.
  if (norm.split(' ').length > MAX_WORDS) return ''
  return norm.replace(FILLER_LEAD, '').replace(FILLER_TRAIL, '').trim()
}

/** @returns {undefined | { kind: 'show'|'hide'|'count'|'read'|'next'|'again'|'stop'|'open'|'reply', n?: number }} */
export function matchQueueCommand(text) {
  if (typeof text !== 'string') return undefined
  if (text.length > 400) return undefined
  const norm = clean(text)
  if (!norm) return undefined
  for (const [, pattern, build] of RULES) {
    const m = pattern.exec(norm)
    if (m) return build(m)
  }
  return undefined
}
