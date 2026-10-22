/**
 * Speakable text for queue items. Item text comes from other programs (session titles, model replies, tool arguments)
 * and is untrusted: control and invisible characters are removed, markdown noise is dropped and length is capped, so what
 * the user hears is what is on screen. Also feeds the card summary fallback.
 */

const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u{E0000}-\u{E007F}\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F]/gu

// An action item is written <u>**text**</u> (shown bold and larger by the screens). Plain text drops the tags; keepAction carries them through as
// \u0001 text \u0002 (control characters, removed from the input first, so a reply cannot forge them) and writes them back at the end.
const ACTION_SPAN = /<u>\s*(?:\*\*([^*]*?)\*\*|([^<*]*?))\s*<\/u>/gi
const ACTION_OPEN = '\u0001'
const ACTION_CLOSE = '\u0002'

/**
 * Plain, single-line text: no markdown, no hidden characters, optionally capped by words or characters.
 * keepAction: leave `<u>**...**</u>` action items in (for text a screen shows, never for speech); a span the cap cuts is closed.
 */
export function cleanText(value, { maxWords, maxChars, keepAction = false } = {}) {
  if (typeof value !== 'string') return ''
  let text = value.normalize('NFKC')
    .replace(/\r\n|\r|\n|\t/g, ' ')
    .replace(UNSAFE, '')
    .replace(ACTION_SPAN, (_, bold, bare) => {
      const inner = (bold ?? bare ?? '').trim()
      return inner ? (keepAction ? ACTION_OPEN + inner + ACTION_CLOSE : inner) : ''
    })
    .replace(/<\/?u>/gi, '')
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
  if (cut) text += '...'
  if (keepAction) {
    const opened = text.split(ACTION_OPEN).length - text.split(ACTION_CLOSE).length
    if (opened > 0) text += ACTION_CLOSE.repeat(opened)
    text = text.replaceAll(ACTION_OPEN, '<u>**').replaceAll(ACTION_CLOSE, '**</u>')
  }
  return text
}

const ACTION_ITEM = /<u>\*\*[^*]*?\*\*<\/u>/g

/**
 * A summary (already cleaned with keepAction) with its `<u>**...**</u>` action items moved out of the sentence flow into their own
 * last paragraph, so what the user must do is never buried in the text: "what was done\n\n<action items>". No action item: unchanged.
 */
export function actionParagraph(text) {
  if (typeof text !== 'string') return ''
  const items = text.match(ACTION_ITEM)
  if (!items) return text
  const rest = text.replace(ACTION_ITEM, ' ').replace(/(^|\s)[.,;:!?]+(?=\s|$)/g, '$1').replace(/\s+/g, ' ').trim()
  return rest ? rest + '\n\n' + items.join(' ') : items.join(' ')
}

/** The last non-empty paragraph of a reply, markdown removed; '' for nothing. */
export function lastParagraph(text, { keepAction = false } = {}) {
  if (typeof text !== 'string') return ''
  const paragraphs = text.split(/\r?\n\s*\r?\n/).map((p) => cleanText(p, { keepAction })).filter(Boolean)
  return paragraphs.at(-1) ?? ''
}

/** The option label a question marks "(Recommended)", or undefined. */
export function recommendedOf(question) {
  return (question?.options ?? []).map((o) => o?.label).find((l) => typeof l === 'string' && /\(recommended\)/i.test(l))
}

const name = (item) => cleanText(item.sessionTitle, { maxWords: 8 }) || 'a session'
const sentence = (text) => (/[.!?]$/.test(text) ? text : text + '.')

/** "Item 3." for a queue position; '' for none. The lead is spoken as a chunk of its own (see chunkForSpeech). */
export const leadFor = (position) => (position ? 'Item ' + position + '.' : '')
const withLead = (position, text, glue) => (position ? leadFor(position) + glue + text : text)

/** A follow-up todo (kind 'followup': the text goes to an existing session): "Follow up: <text>, send to <session title>?" while it waits for the confirmation, and a line per other state. */
function followUpParts(item) {
  const say = (max) => cleanText(item.text, { maxWords: 25, maxChars: max }).replace(/[.!?:;,]+$/, '')
  const where = cleanText(item.state === 'awaiting-confirm' ? item.suggested?.title : item.sessionTitle ?? item.suggested?.title, { maxWords: 8 })
  const line = (text) => {
    switch (item.state) {
      case 'awaiting-confirm': return where ? 'Follow up: ' + text + ', send to ' + where + '?' : 'Follow up: ' + text + '. Which session?'
      case 'failed': return 'Follow up: ' + text + '. Failed to send: ' + (cleanText(item.error, { maxChars: 200 }) || 'unknown error') + '.'
      case 'starting': return 'Follow up: ' + text + ', sending' + (where ? ' to ' + where : '') + '.'
      case 'started': return 'Follow up: ' + text + ', sent' + (where ? ' to ' + where : '') + '.'
      default: return 'Follow up: ' + text + '.'
    }
  }
  return { headline: line(say(300)), full: line(say(600)) }
}

/** A todo: "Todo: <text>, start in <workspace>?" while it waits for the confirmation, and a line per other state. */
function todoParts(item) {
  if (item.kind === 'followup') return followUpParts(item)
  const say = (max) => cleanText(item.text, { maxWords: 25, maxChars: max }).replace(/[.!?:;,]+$/, '')
  const where = cleanText(item.state === 'awaiting-confirm' ? item.suggested?.title : item.workspaceTitle ?? item.suggested?.title, { maxWords: 6 })
  const line = (text) => {
    switch (item.state) {
      case 'awaiting-confirm': return where ? 'Todo: ' + text + ', start in ' + where + '?' : 'Todo: ' + text + '. Which workspace?'
      case 'failed': return 'Todo: ' + text + '. Failed to start: ' + (cleanText(item.error, { maxChars: 200 }) || 'unknown error') + '.'
      case 'starting': return 'Todo: ' + text + ', starting' + (where ? ' in ' + where : '') + '.'
      case 'started': return 'Todo: ' + text + ', started' + (where ? ' in ' + where : '') + '.'
      default: return 'Todo: ' + text + '.'
    }
  }
  return { headline: line(say(300)), full: line(say(600)) }
}

/** The part of an item's speech that does not depend on its queue position: { headline, full } without the lead. */
function bodyParts(item) {
  const who = name(item)
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
    return { headline: 'Question from ' + who + ': ' + head + count, full }
  }
  if (item.type === 'permission') {
    const what = cleanText(item.payload?.summary, { maxWords: 20 }) || cleanText(item.payload?.toolName, { maxWords: 4 }) || 'a tool'
    return { headline: 'Permission from ' + who + ': ' + what, full: 'Permission request from ' + who + ': ' + what + '. Say approve or deny.' }
  }
  if (item.type === 'archive') {
    const why = cleanText(item.payload?.reason, { maxChars: 200 })
    return { headline: 'Archive ' + who + '?', full: who + ' asks to be archived.' + (why ? ' Reason: ' + sentence(why) : '') + ' You can archive this session.' }
  }
  if (item.type === 'pr-merged') {
    const pr = 'Pull request ' + cleanText(String(item.payload?.prId ?? ''), { maxChars: 12 })
    const followUps = (item.payload?.followUps ?? []).length
    const told = followUps ? ' The follow-up session' + (followUps === 1 ? ' was' : 's were') + ' told to start.' : ''
    return { headline: pr + ' merged in ' + who + '.', full: pr + ' is merged in ' + who + '.' + told + ' You can archive this session.' }
  }
  if (item.type === 'todo') return todoParts(item)
  if (item.type === 'onhold') {
    const session = cleanText(item.sessionTitle, { maxWords: 8, maxChars: 80 })
    const reason = cleanText(item.payload?.reason, { maxChars: 200 })
    const ticket = item.payload?.ticket?.id ? ' Ticket ' + cleanText(String(item.payload.ticket.id), { maxChars: 12 }) + ' is checked every few minutes; the session continues when it changes.' : ' It has no ticket, so continue or release it yourself.'
    return {
      headline: 'Session' + (session ? ' ' + session : '') + ' is on hold.',
      full: 'Session' + (session ? ' ' + session : '') + ' is on hold.' + (reason ? ' ' + sentence(reason) : '') + ticket,
    }
  }
  if (item.type === 'paused') {
    const session = cleanText(item.sessionTitle, { maxWords: 8, maxChars: 80 })
    const reason = cleanText(item.payload?.reason, { maxChars: 200 })
    return {
      headline: 'Paused session' + (session ? ' ' + session : '') + ': cut off.',
      full: 'Paused session' + (session ? ' ' + session : '') + ' was cut off.' + (reason ? ' ' + sentence(reason) : '')
        + ' Resume or dismiss it at the desktop.',
    }
  }
  const summary = cleanText(item.summary) || lastParagraph(item.payload?.reply)
  const firstSentence = cleanText(summary.split(/(?<=[.!?])\s/)[0] ?? '', { maxWords: 20 })
  return { headline: 'Done in ' + who + ': ' + (firstSentence || 'finished.'), full: 'Done in ' + who + '. ' + cleanText(summary, { maxChars: 600 }) }
}

/**
 * What the user hears for an item at a queue position: a short headline and the full text. Position is the item's
 * current place in the queue (oldest = 1); without one there is no lead. `full` is the lead, a paragraph break and the
 * `body`, so the lead is its own chunk and the body (and its chunks) is the same at every position.
 */
export function spokenFor(item, position) {
  const { headline, full } = bodyParts(item)
  return { lead: leadFor(position), body: full, headline: withLead(position, headline, ' '), full: withLead(position, full, '\n\n') }
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
  if (item.type === 'archive') return cleanText(item.sessionTitle, { maxWords: 10 }) || 'Archive this session?'
  if (item.type === 'pr-merged') return 'PR ' + cleanText(String(item.payload?.prId ?? ''), { maxChars: 12 }) + ' merged'
  if (item.type === 'paused') return cleanText(item.sessionTitle, { maxWords: 10 }) || 'Paused session'
  if (item.type === 'onhold') return cleanText(item.sessionTitle, { maxWords: 10 }) || 'Session on hold'
  if (item.type === 'todo') {
    const first = cleanText(String(item.text ?? '').split(/\r?\n/).find((l) => l.trim()), { maxWords: 10 })
    return item.kind === 'followup' ? (first ? 'Follow up: ' + first : 'Follow up') : first || 'Todo'
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
    .replace(/<\/?u>/gi, '')
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
 * A leading "Item N." paragraph (the queue position) is a chunk of its own and the rest is chunked as if it were not
 * there, so the body chunks are identical at every position (the speech cache then hits for them).
 */
const LEAD_PARAGRAPH = /^\s*(Item \d+\.)[ \t]*\r?\n[ \t]*\r?\n/
export function chunkForSpeech(text, opts = {}) {
  const lead = LEAD_PARAGRAPH.exec(String(text ?? ''))
  if (lead) return [lead[1], ...chunkForSpeech(String(text).slice(lead[0].length), opts)]
  const { first = 260, max = 420 } = opts
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

/**
 * A tip body as sentences, one per entry (the screen shows one paragraph each and the speaker gets one chunk each). A sentence ends at a word that ends
 * in . ! or ? when the next word starts with a capital letter, a digit, a quote or a bracket, unless that word is a common abbreviation (e.g., i.e., vs.,
 * Dr. ...): "e.g. a map", "0.75" and "e.g. Redis" stay whole. No regex lookbehind: lib/client.js keeps a copy of this (it is one self-contained script
 * that old iOS Safari must still parse); a test checks that the two agree.
 */
const TIP_ABBREVIATION = /^[("'\[]*(?:e\.g|i\.e|vs|cf|approx|fig|dr|mr|mrs|ms|prof)\.$/i
export function tipSentences(text) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const out = []
  let cur = []
  words.forEach((w, i) => {
    cur.push(w)
    const next = words[i + 1]
    if (next !== undefined && /[.!?]$/.test(w) && /^[A-Z0-9"'(\[`]/.test(next) && !TIP_ABBREVIATION.test(w)) { out.push(cur.join(' ')); cur = [] }
  })
  if (cur.length) out.push(cur.join(' '))
  return out
}

/**
 * Everything a card says when its play button is pressed: the whole message, not the summary. With a position it starts
 * with the "Item N." lead as a paragraph of its own; the rest does not depend on the position.
 */
export function fullTextFor(item, position) {
  if (item.type === 'permission') {
    const base = bodyParts(item).full
    const reason = cleanText(item.payload?.reason, { maxChars: 600 })
    return withLead(position, reason ? base.replace(/ Say approve or deny\.$/, '') + ' Reason: ' + sentence(reason) + ' Say approve or deny.' : base, '\n\n')
  }
  if (item.type === 'question' || item.type === 'pr-merged' || item.type === 'archive' || item.type === 'todo' || item.type === 'paused' || item.type === 'onhold') {
    return spokenFor(item, position).full
  }
  const reply = speakable(item.payload?.reply) || cleanText(item.summary) || 'Finished.'
  return withLead(position, 'Done in ' + name(item) + '. ' + sentence(titleFor(item)) + '\n\n' + reply, '\n\n')
}
