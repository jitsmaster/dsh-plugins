/**
 * Speakable text for queue items. Item text comes from other programs (session titles, model replies, tool arguments)
 * and is untrusted: control and invisible characters are removed, markdown noise is dropped and length is capped, so what
 * the user hears is what is on screen. Also feeds the card summary fallback.
 */

const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u{E0000}-\u{E007F}\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F]/gu

/** Plain, single-line text: no markdown, no hidden characters, optionally capped by words or characters. */
export function cleanText(value, { maxWords, maxChars } = {}) {
  if (typeof value !== 'string') return ''
  let text = value.normalize('NFKC')
    .replace(/\r\n|\r|\n|\t/g, ' ')
    .replace(UNSAFE, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  let cut = false
  if (maxWords !== undefined) {
    const words = text.split(' ')
    if (words.length > maxWords) { text = words.slice(0, maxWords).join(' '); cut = true }
  }
  if (maxChars !== undefined && text.length > maxChars) { text = text.slice(0, maxChars).trimEnd(); cut = true }
  return cut ? text + '...' : text
}

/** The last non-empty paragraph of a reply, markdown removed; '' for nothing. */
export function lastParagraph(text) {
  if (typeof text !== 'string') return ''
  const paragraphs = text.split(/\r?\n\s*\r?\n/).map((p) => cleanText(p)).filter(Boolean)
  return paragraphs.at(-1) ?? ''
}

/** The option label a question marks "(Recommended)", or undefined. */
export function recommendedOf(question) {
  return (question?.options ?? []).map((o) => o?.label).find((l) => typeof l === 'string' && /\(recommended\)/i.test(l))
}

const name = (item) => cleanText(item.sessionTitle, { maxWords: 8 }) || 'a session'
const sentence = (text) => (/[.!?]$/.test(text) ? text : text + '.')

/**
 * What the user hears for an item at a queue position: a short headline and the full text.
 * Position is the item's current place in the queue (oldest = 1).
 */
export function spokenFor(item, position) {
  const who = name(item)
  const lead = 'Item ' + position + '. '
  if (item.type === 'question') {
    const questions = item.payload?.questions ?? []
    const first = questions[0]
    const options = first?.options ?? []
    const head = cleanText(first?.question, { maxWords: 15 })
    const count = options.length ? ' ' + options.length + ' option' + (options.length === 1 ? '' : 's') + '.' : ''
    const full = questions.map((q, i) => {
      const rec = recommendedOf(q)
      const opts = (q.options ?? []).map((o, n) => {
        const label = cleanText(o.label, { maxChars: 200 })
        const desc = cleanText(o.description, { maxChars: 300 })
        return 'Option ' + (n + 1) + ': ' + sentence(label) + (o.label === rec ? ' Recommended.' : '') + (desc ? ' ' + sentence(desc) : '')
      })
      return [(questions.length > 1 ? 'Question ' + (i + 1) + ': ' : '') + cleanText(q.question, { maxChars: 1000 }), ...opts].join(' ')
    }).join(' ')
    return { headline: lead + 'Question from ' + who + ': ' + head + count, full: lead + full }
  }
  if (item.type === 'permission') {
    const what = cleanText(item.payload?.summary, { maxWords: 20 }) || cleanText(item.payload?.toolName, { maxWords: 4 }) || 'a tool'
    return { headline: lead + 'Permission from ' + who + ': ' + what, full: lead + 'Permission request from ' + who + ': ' + what + '. Say approve or deny.' }
  }
  const summary = cleanText(item.summary) || lastParagraph(item.payload?.reply)
  const firstSentence = cleanText(summary.split(/(?<=[.!?])\s/)[0] ?? '', { maxWords: 20 })
  return { headline: lead + 'Done in ' + who + ': ' + (firstSentence || 'finished.'), full: lead + 'Done in ' + who + '. ' + cleanText(summary, { maxChars: 600 }) }
}
