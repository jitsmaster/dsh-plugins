/**
 * Answer the first task-list question item by voice (slice 6): "option two" / "recommended" / free text for each sub-question in
 * turn, then ONE read-back of every answer and a strict yes that sends through the card's own call (answer).
 *
 * The item is frozen as a list of { id, short, prompt, labels, say, recommended }: what the voice walks through. The walk's state is
 * { answers: [{ kind: 'option', n } | { kind: 'recommended', n } | { kind: 'text', text }] }, one per question answered so far.
 * Moves (consumed by flow-reply.js): ask { state, line? } · confirm { state, line } · again · reject { error } · cancel · end.
 */
import { speakableUtterance, spokenName } from './sanitize.js'
import { parseOptionAnswer } from './queue-commands.js'
import { need, say } from './reply-common.js'

export const UNSUPPORTED_QUESTION = 'That question cannot be answered by voice. Answer it on screen.'
const MAX_QUESTIONS = 10
const SHORT_WORDS = 5
const MARK = /\s*\(recommended\)\s*/i
const TAIL = ' Say yes to send, or say it again to start over.'

const spoken = (text, max) => spokenName(typeof text === 'string' ? text : '', max).text
const sentence = (text) => (/[.!?]$/.test(text) ? text : text + '.')

/** The first words of the header (else the question), no trailing punctuation: "Colour", "Which size should the button". */
const shortOf = (q, i) => spoken(q.header || q.question, 80).split(' ').slice(0, SHORT_WORDS).join(' ').replace(/[\s.!?:;,]+$/, '') || 'question ' + (i + 1)

/** One question as the voice walks it, or undefined when it cannot be walked (no id, no readable text, an option without a label). */
function describe(q, i) {
  if (!q || typeof q.id !== 'string' || !q.id || !spoken(q.question, 300)) return undefined
  const options = Array.isArray(q.options) ? q.options : []
  const labels = options.map((o) => o?.label)
  if (labels.some((l) => typeof l !== 'string' || !l.trim())) return undefined
  const marked = labels.findIndex((l) => MARK.test(l))
  return Object.freeze({
    id: q.id, short: shortOf(q, i), prompt: spoken(q.question, 300), labels: Object.freeze(labels),
    say: Object.freeze(labels.map((l) => spoken(l.replace(MARK, ' '), 120) || 'unreadable')),
    recommended: marked >= 0 ? marked + 1 : undefined,
  })
}

/** The frozen questions of an item, or undefined when voice cannot answer it. */
export function questionsOf(item) {
  const list = item.payload?.questions
  if (!Array.isArray(list) || !list.length || list.length > MAX_QUESTIONS) return undefined
  const described = list.map(describe)
  return described.some((q) => q === undefined) ? undefined : Object.freeze(described)
}

/** The next question, read in full: "Question 2 of 3: Which size? Option 1: Small. Option 2: Large, recommended. Say an option, ..." */
function askLine(q, i, total) {
  const options = q.say.map((label, n) => 'Option ' + (n + 1) + ': ' + label + (q.recommended === n + 1 ? ', recommended' : '') + '.')
  const how = q.labels.length ? ' Say an option, ' + (q.recommended ? 'recommended, ' : '') + 'or your answer.' : ' Say your answer.'
  return ['Question ' + (i + 1) + ' of ' + total + ': ' + sentence(q.prompt), ...options].join(' ') + how
}

const ask = (state, line) => ({ kind: 'ask', state, ...(line ? { line } : {}) })

/** "Answer to <title>: <q1 short> option two, <q2 short> recommended. Say yes to send, or say it again to start over." */
function readBack(frozen, state) {
  const parts = state.answers.map((a, i) => frozen.questions[i].short + ' ' + (a.kind === 'option' ? 'option ' + say(a.n) : a.kind === 'recommended' ? 'recommended' : a.text))
  return sentence('Answer to ' + frozen.title + ': ' + parts.join(', ')) + TAIL
}

/** One answer to the question at hand: the next move (more questions, the read-back, or asking this one again). */
function take(frozen, state, input) {
  const total = frozen.questions.length, i = state.answers.length, q = frozen.questions[i]
  let answer
  if (input.kind === 'option') {
    if (!q.labels.length) return ask(state, 'That question has no options. Say your answer.')
    if (!(input.n >= 1 && input.n <= q.labels.length)) return ask(state, 'There is no option ' + input.n + '. Say an option from one to ' + say(q.labels.length) + ', or your answer.')
    answer = { kind: 'option', n: input.n }
  } else if (input.kind === 'recommended') {
    if (!q.recommended) return ask(state, 'That question has no recommended option. Say an option, or your answer.')
    answer = { kind: 'recommended', n: q.recommended }
  } else {
    // Free text: the same limits and sanitising as a dictated reply (1500 characters, nothing the speaker would alter).
    const said = speakableUtterance(input.text)
    if (!said.ok || !said.text) return { kind: 'reject', error: said.ok ? 'invalid' : said.error }
    answer = { kind: 'text', text: said.text }
  }
  const next = { answers: [...state.answers, answer] }
  return next.answers.length < total ? ask(next, askLine(frozen.questions[next.answers.length], next.answers.length, total)) : { kind: 'confirm', state: next, line: readBack(frozen, next) }
}

const parse = (text) => parseOptionAnswer(text) ?? { kind: 'text', text }
const START = Object.freeze({ answers: [] })

export const questionHandler = {
  kinds: new Set(['option', 'recommended', 'answer', 'reply']),
  changed: ['not-open', 'not-pending'],
  begin(item, intent, base) {
    const questions = questionsOf(item)
    if (!questions) return { refuse: { outcome: 'unsupported', line: UNSUPPORTED_QUESTION } }
    const frozen = { ...base, questions }
    const move = intent.kind === 'reply' ? ask({ answers: [] }) : take(frozen, START, intent.kind === 'answer' ? { kind: 'text', text: intent.text } : intent)
    return { extra: { questions }, move }
  },
  step(frozen, state, input) {
    if (input.step === 'ask') return take(frozen, state ?? START, parse(input.text))
    // At the read-back a bare "no" asks again; anything else is the answer again: start over with it as the first answer.
    return input.kind === 'no' ? { kind: 'again' } : take(frozen, START, parse(input.text))
  },
  send(service, frozen, text, state) {
    const given = state?.answers ?? []
    if (given.length !== frozen.questions.length) throw new Error('the answer is incomplete')
    const answers = frozen.questions.map((q, i) => {
      const a = given[i]
      if (a.kind === 'text') return { id: q.id, selected: [], custom: a.text }
      const label = q.labels[a.n - 1]
      if (label === undefined) throw new Error('the answer is incomplete')
      return { id: q.id, selected: [label] }
    })
    return need(service, 'answer').answer(frozen.id, answers)
  },
  word: () => 'answered',
}
