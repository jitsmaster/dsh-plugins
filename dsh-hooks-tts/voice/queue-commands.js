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
 *   reply { n: 1 }                   "reply to the first item" (the first item only; a done item dictates, a question starts a free-text answer)
 *
 * Answering the first item (slice 6; the runner checks the item's type and speaks a correction on a mismatch):
 *   approve / deny                   "approve", "yes approve it", "deny", "reject"                         (permission item)
 *   option { n }                     "option two", "choose option 2", "the second one"                      (question item)
 *   recommended                      "recommended", "go with the recommended one"                           (question item)
 *   answer { text }                  "answer use Postgres" (the text keeps its own case and punctuation)    (question item)
 * parseOptionAnswer(text) reads the option / recommended forms inside a question step, where the matcher itself never runs.
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
const LIST = '(?:(?:the|my|our) )?(?:task ?lists?|tasks|queue|coding boss review queue|review queue|review list|to do list|todo list)(?: (?:screen|panel|window|view|overlay|sidebar))?'

const FILLER_LEAD = /^(?:(?:hey|hi|ok|okay|no|well|so|please|kindly|(?:can|could|would|will) you|i would like you to|id like you to|i want you to|i need you to|i want to|i wanna|i need to|lets|go ahead and) )+/
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

/** The lead-ins of a choice: "choose option 2", "go with the recommended one", "answer option two". */
const PICK = '(?:(?:i choose|i pick|i select|choose|pick|select|take|use|go with|answer)(?: the)? )?'
/** What approve / deny may refer to. */
const THAT = '(?: (?:it|this|that|this request|the request|that request|this permission|the permission|the first item|the first one))?'

const READ_VERB = '(?:read(?: me| out(?: loud)?| aloud)?|play)'
const IT = '(?:it|that|this|that one|the item|that item|the last one|the last item)'

/** [kind, pattern, (match) => result]. First match wins; patterns are anchored to the whole normalised utterance. */
const RULES = [
  ['show', new RegExp(`^(?:show(?: me)?|see|open|display|bring up|pull up|view) ${LIST}$`), () => ({ kind: 'show' })],
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
  ['reply', new RegExp(`^reply to (?:the )?(?:(?:first|1st) (?:${NOUN}|question)|item(?: number)? (?:one|1))$`), () => ({ kind: 'reply', n: 1 })],
  ['approve', new RegExp(`^(?:(?:yes|yeah) )?approve${THAT}$`), () => ({ kind: 'approve' })],
  ['deny', new RegExp(`^(?:(?:yes|yeah) )?(?:deny|reject)${THAT}$`), () => ({ kind: 'deny' })],
  ['option', new RegExp(`^${PICK}(?:option|choice) (?:number |no )?(${NUM})$`), (m) => {
    const n = numberOf(m[1])
    return n >= 1 ? { kind: 'option', n } : undefined
  }],
  ['option', new RegExp(`^${PICK}(?:the )?(${ORD}) (?:one|option|choice)$`), (m) => {
    const n = ordinalOf(m[1])
    return n >= 1 ? { kind: 'option', n } : undefined
  }],
  ['recommended', new RegExp(`^${PICK}(?:the )?(?:recommended|recommendation)(?: (?:one|option|choice|answer))?$`), () => ({ kind: 'recommended' })],
]

/** Lower-case, NFKC, hidden characters gone, punctuation to spaces, filler removed. */
function clean(text) {
  // The recogniser sometimes writes a glossary-style camelCase word ("showTaskList"): split it into words before lower-casing.
  const plain = String(text).normalize('NFKC').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/[\p{Cc}\p{Cf}]/gu, (c) => (/\s/.test(c) ? ' ' : ''))
  // "task-list" / "to-do" read as separate words; the apostrophe in "what's" / "item's" is dropped by normalize (so "items session").
  const norm = normalize(plain)
  // Words are counted before the filler is stripped, so a pile of "please" is not a command either.
  if (norm.split(' ').length > MAX_WORDS) return ''
  return norm.replace(FILLER_LEAD, '').replace(FILLER_TRAIL, '').trim()
}

/** First matching rule for a cleaned utterance (only the rules of the given kinds when `only` is set), or undefined. */
function matchRules(text, only) {
  const norm = clean(text)
  if (!norm) return undefined
  for (const [kind, pattern, build] of RULES) {
    if (only && !only.has(kind)) continue
    const m = pattern.exec(norm)
    if (m) return build(m)
  }
  return undefined
}

/** Free text may be as long as a dictated reply (the flow's own limits apply later: 1500 characters, speakable); a command phrase may not. */
const ANSWER_MAX_CHARS = 3000
const ANSWER_LEAD = /^([\s\S]*?)\banswer\b[\s,:;.\-!?]*([\s\S]*)$/iu

/** "answer <free text>": "answer" must lead the utterance (polite filler aside) and something must follow it. The text keeps its case. */
function matchAnswer(text) {
  if (text.length > ANSWER_MAX_CHARS) return undefined
  const m = ANSWER_LEAD.exec(text.normalize('NFKC'))
  if (!m) return undefined
  if ((normalize(m[1]) + ' ').replace(FILLER_LEAD, '').trim() !== '') return undefined
  const free = m[2].trim()
  if ((' ' + normalize(free)).replace(FILLER_TRAIL, '').trim() === '') return undefined
  return { kind: 'answer', text: free }
}

/** @returns {undefined | { kind: 'show'|'hide'|'count'|'read'|'next'|'again'|'stop'|'open'|'reply'|'approve'|'deny'|'option'|'recommended'|'answer', n?: number, text?: string }} */
export function matchQueueCommand(text) {
  if (typeof text !== 'string') return undefined
  return (text.length <= 400 ? matchRules(text) : undefined) ?? matchAnswer(text)
}

const OPTION_KINDS = new Set(['option', 'recommended'])

/** An option or recommended answer given inside a question step ("option two", "the second one", "recommended"), else undefined = free text. */
export function parseOptionAnswer(text) {
  if (typeof text !== 'string' || text.length > 400) return undefined
  return matchRules(text, OPTION_KINDS)
}
