/**
 * Classifies a spoken answer at a confirm step of the voice flow (echo, read-back, clarify). Only the WHOLE utterance
 * counts: "yes" inside a longer sentence is new text, never a confirmation.
 */

const YES = ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'correct', 'right', 'thats right', 'that is right',
  'do it', 'go ahead', '是', '是的', '对', '对的', '好', '好的', '确认', '确定', '没错']
const NO = ['no', 'nope', 'nah', '不', '不是', '不对', '不要', '否']
const STOP = ['stop', 'cancel', 'abort', 'quit', 'never mind', 'nevermind', '取消', '停', '停止', '算了']

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Matches one or more of the phrases, space-separated, filling the whole string ("yes", "yes yes", "yeah yes"). */
function wholeOf(phrases) {
  const alt = phrases.map(escape).join('|')
  return new RegExp('^(?:' + alt + ')(?: (?:' + alt + '))*$')
}

const IS_YES = wholeOf(YES)
const IS_NO = wholeOf(NO)
const IS_STOP = wholeOf(STOP)

/** Lower-case, drop apostrophes, turn other EN/ZH punctuation and symbols into spaces, collapse whitespace, trim. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 'yes' | 'no' | 'stop' | 'empty' | 'text' for one answer transcript. */
export function classifyAnswer(text) {
  const norm = normalize(text)
  if (!norm) return 'empty'
  if (IS_STOP.test(norm)) return 'stop'
  if (IS_YES.test(norm)) return 'yes'
  if (IS_NO.test(norm)) return 'no'
  return 'text'
}
