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

const firstSentenceOf = (text) => text.split(/(?<=[.!?])\s/)[0] ?? ''

/** A short name for the task an item stands for (shown as the card heading, beside the session title). */
export function titleFor(item) {
  if (item.type === 'question') {
    const first = item.payload?.questions?.[0]
    return cleanText(first?.header, { maxWords: 10 }) || cleanText(first?.question, { maxWords: 10 }) || 'Question'
  }
  if (item.type === 'permission') {
    return cleanText(item.payload?.summary, { maxWords: 10 }) || cleanText(item.payload?.toolName, { maxWords: 4 }) || 'Permission request'
  }
  return cleanText(item.title, { maxWords: 12 })
    || cleanText(item.payload?.request, { maxWords: 10 })
    || cleanText(firstSentenceOf(cleanText(String(item.payload?.reply ?? '').split(/\r?\n\s*\r?\n/).find((p) => p.trim()))), { maxWords: 10 })
    || 'Finished'
}

const MAX_SPEAKABLE = 20_000

/**
 * A reply as speech: paragraphs kept (they become pauses and chunk borders), markdown noise and hidden characters
 * dropped, code blocks replaced by a short note (reading code aloud is noise). Capped at 20,000 characters.
 */
export function speakable(value) {
  if (typeof value !== 'string') return ''
  let text = value.normalize('NFKC').replace(/\r\n|\r/g, '\n')
    .replace(/```[\s\S]*?(```|$)/g, '\n\n(code block omitted)\n\n')
  text = text.split('\n').map((line) => line
    .replace(/\t/g, ' ')
    .replace(UNSAFE, '')
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[ ]{2,}/g, ' ')
    .trim()).join('\n')
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  return text.length > MAX_SPEAKABLE ? text.slice(0, MAX_SPEAKABLE).trimEnd() + '...' : text
}

/**
 * Cuts speech into pieces for the speaker: paragraph borders first, then sentences, packed up to `max` characters; the
 * first piece is held to `first` so playback starts early. A single over-long sentence is split at spaces.
 */
export function chunkForSpeech(text, { first = 260, max = 420 } = {}) {
  const units = []
  for (const paragraph of String(text ?? '').split(/\n\s*\n/)) {
    const flat = paragraph.replace(/\s+/g, ' ').trim()
    if (!flat) continue
    units.push(...flat.split(/(?<=[.!?:;])\s+/).map((s, i, all) => ({ s, end: i === all.length - 1 })))
  }
  const chunks = []
  let cur = ''
  const limit = () => (chunks.length === 0 ? first : max)
  const flush = () => { if (cur) { chunks.push(cur); cur = '' } }
  for (const { s, end } of units) {
    let rest = s
    while (rest.length > limit()) {
      flush()
      const room = limit()
      let cut = rest.lastIndexOf(' ', room)
      if (cut <= 0) cut = room
      chunks.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (!rest) continue
    if (cur && cur.length + 1 + rest.length > limit()) flush()
    cur = cur ? cur + ' ' + rest : rest
    if (end) flush() // a paragraph never shares a piece with the next one
  }
  flush()
  return chunks
}

/** Everything a card says when its play button is pressed: the whole message, not the summary. */
export function fullTextFor(item, position) {
  const text = fullTextAt(item, position || 0)
  return position ? text : text.replace(/^Item \d+\. /, '')
}

function fullTextAt(item, position) {
  const who = name(item)
  const lead = 'Item ' + position + '. '
  if (item.type === 'permission') {
    const base = spokenFor(item, position).full
    const reason = cleanText(item.payload?.reason, { maxChars: 600 })
    return reason ? base.replace(/ Say approve or deny\.$/, '') + ' Reason: ' + sentence(reason) + ' Say approve or deny.' : base
  }
  if (item.type === 'question') return spokenFor(item, position).full
  const reply = speakable(item.payload?.reply) || cleanText(item.summary) || 'Finished.'
  return lead + 'Done in ' + who + '. ' + sentence(titleFor(item)) + '\n\n' + reply
}
