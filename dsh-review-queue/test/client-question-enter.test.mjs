import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { source, file, okJson, deferred, need, tick } from './client-todo-helpers.mjs'

// Task list (lib/client.js), QUESTION card: Enter in a question's free-text box ("Other answer…") sends the card's answers
// exactly like the Send answer button, but only when the answers are complete (this box has text, every OTHER question already has
// an answer, or there is no other question). Plain Enter only: no Shift/Ctrl/Alt/Meta, no IME composition (isComposing / keyCode 229).
// While a send is in flight nothing is sent twice. The expired question's late-answer form behaves the same.
// Pure helper: exports.__test.enterAnswers(event, questions, drafts, qid) -> the answers to send, or undefined.
// Wiring: exports.__test.QuestionBody rendered with a tiny React (elements are plain objects).
function load({ fetchImpl } = {}) {
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } },
    console, setInterval, clearInterval, setTimeout: () => 1, clearTimeout() {}, fetch: fetchImpl ?? (() => new Promise(() => {})),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
    Fragment: Symbol('Fragment'),
    useState: (v) => [v, () => {}], useEffect() {}, useRef: () => ({ current: null }), useSyncExternalStore: (sub, get) => get(),
  }
  const mod = registered.factory(() => React)
  return { T: mod.__test }
}
const walk = (n, out = []) => { if (n && typeof n === 'object') { out.push(n); (n.children || []).forEach((c) => walk(c, out)) } return out }
const boxes = (tree) => walk(tree).filter((n) => n.type === 'input' && n.props.className === 'rq-input')
const sendButton = (tree) => walk(tree).find((n) => n.type === 'button' && n.props.className === 'rq-btn pri')
const plain = (v) => JSON.parse(JSON.stringify(v))

const Q = (id, over = {}) => ({ id, question: 'Question ' + id, options: [{ label: 'Yes' }, { label: 'No' }], ...over })
const draft = (custom = '', selected = []) => ({ selected, custom })
const ENTER = (over = {}) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 13, ...over })
const keyEvent = (over = {}) => { const e = ENTER(over); e.prevented = 0; e.preventDefault = () => { e.prevented++ }; return e }

// ---------- the pure rule ----------

test("plain Enter in the only question's box, with text typed, yields the answers", () => {
  const { T } = load()
  need(T, 'enterAnswers')
  const qs = [Q('a')]
  assert.deepEqual(plain(T.enterAnswers(ENTER(), qs, { a: draft('  my own  ') }, 'a')), [{ id: 'a', selected: [], custom: 'my own' }])
})

test('Enter yields the answers when every other question is answered, by an option or by typed text', () => {
  const { T } = load()
  need(T, 'enterAnswers')
  const qs = [Q('a'), Q('b'), Q('c')]
  const drafts = { a: draft('typed here'), b: draft('', ['Yes']), c: draft('also typed') }
  assert.deepEqual(plain(T.enterAnswers(ENTER(), qs, drafts, 'a')), [
    { id: 'a', selected: [], custom: 'typed here' }, { id: 'b', selected: ['Yes'] }, { id: 'c', selected: [], custom: 'also typed' }])
})

test('Enter does nothing while another question is still unanswered', () => {
  const { T } = load()
  need(T, 'enterAnswers')
  const qs = [Q('a'), Q('b')]
  assert.equal(T.enterAnswers(ENTER(), qs, { a: draft('typed') }, 'a'), undefined)
  assert.equal(T.enterAnswers(ENTER(), qs, { a: draft('typed'), b: draft('   ') }, 'a'), undefined, 'a blank box is not an answer')
})

test('Enter in an empty or blank box does nothing, even when an option of that question is picked', () => {
  const { T } = load()
  need(T, 'enterAnswers')
  const qs = [Q('a'), Q('b')]
  assert.equal(T.enterAnswers(ENTER(), qs, { a: draft(''), b: draft('', ['Yes']) }, 'a'), undefined)
  assert.equal(T.enterAnswers(ENTER(), qs, { a: draft('   '), b: draft('', ['Yes']) }, 'a'), undefined)
  assert.equal(T.enterAnswers(ENTER(), [Q('a')], { a: draft('', ['Yes']) }, 'a'), undefined)
  assert.equal(T.enterAnswers(ENTER(), [Q('a')], {}, 'a'), undefined, 'no draft at all')
})

test('Shift+Enter, Ctrl/Alt/Meta+Enter, IME composition (isComposing or keyCode 229) and other keys do nothing', () => {
  const { T } = load()
  need(T, 'enterAnswers')
  const qs = [Q('a')]
  const drafts = { a: draft('typed') }
  assert.ok(T.enterAnswers(ENTER(), qs, drafts, 'a'), 'control: plain Enter works')
  for (const over of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }, { key: 'a' }, { key: 'Tab' }]) {
    assert.equal(T.enterAnswers(ENTER(over), qs, drafts, 'a'), undefined, JSON.stringify(over))
  }
  assert.equal(T.enterAnswers(undefined, qs, drafts, 'a'), undefined)
})

// ---------- the wiring of the card ----------

const item = (over = {}) => ({ id: 'q1', type: 'question', payload: { questions: [Q('a'), Q('b')] }, ...over })
const setup = ({ fetchImpl, drafts, busy, it = item(), path } = {}) => {
  const calls = []
  const env = load({ fetchImpl: fetchImpl ?? (async (url, init) => { calls.push([url, JSON.parse(init.body)]); return okJson({ ok: true }) }) })
  env.calls = calls
  env.T.set({ drafts: { [it.id]: drafts }, busy: busy ? { [it.id]: true } : {} })
  env.it = it
  env.render = () => env.T.QuestionBody({ item: it, full: true, ...(path ? { path, sendLabel: 'Send late answer' } : {}) })
  return env
}

test('Enter in the box with complete answers posts the answers once, like Send answer, and stops the key', async () => {
  const env = setup({ drafts: { a: draft('typed'), b: draft('', ['No']) } })
  need(env.T, 'QuestionBody')
  const e = keyEvent()
  boxes(env.render())[0].props.onKeyDown(e)
  await tick()
  assert.deepEqual(plain(env.calls), [['/review-queue/v1/answer', { id: 'q1', answers: [{ id: 'a', selected: [], custom: 'typed' }, { id: 'b', selected: ['No'] }] }]])
  assert.equal(e.prevented, 1)
  assert.equal(env.T.state.drafts.q1, undefined, 'a sent card forgets its draft, as after the button')
})

test('the button and Enter send the same body', async () => {
  const drafts = { a: draft('typed'), b: draft('', ['Yes']) }
  const viaKey = setup({ drafts })
  need(viaKey.T, 'QuestionBody')
  boxes(viaKey.render())[0].props.onKeyDown(keyEvent())
  await tick()
  const viaButton = setup({ drafts })
  sendButton(viaButton.render()).props.onClick()
  await tick()
  assert.equal(viaKey.calls.length, 1)
  assert.deepEqual(plain(viaKey.calls), plain(viaButton.calls))
})

test('a single-question card sends on Enter', async () => {
  const it = item({ payload: { questions: [Q('a')] } })
  const env = setup({ it, drafts: { a: draft('only one') } })
  need(env.T, 'QuestionBody')
  boxes(env.render())[0].props.onKeyDown(keyEvent())
  await tick()
  assert.deepEqual(plain(env.calls), [['/review-queue/v1/answer', { id: 'q1', answers: [{ id: 'a', selected: [], custom: 'only one' }] }]])
})

test('Enter in either box of a two-question card sends when both are answered', async () => {
  const env = setup({ drafts: { a: draft('first'), b: draft('second') } })
  need(env.T, 'QuestionBody')
  boxes(env.render())[1].props.onKeyDown(keyEvent())
  await tick()
  assert.equal(env.calls.length, 1)
  assert.deepEqual(plain(env.calls[0][1].answers.map((a) => a.custom)), ['first', 'second'])
})

test('Enter with another question unanswered sends nothing and leaves the key alone', async () => {
  const env = setup({ drafts: { a: draft('typed') } })
  need(env.T, 'QuestionBody')
  const e = keyEvent()
  boxes(env.render())[0].props.onKeyDown(e)
  await tick()
  assert.equal(env.calls.length, 0)
  assert.equal(e.prevented, 0)
  assert.deepEqual(plain(env.T.state.drafts.q1), { a: draft('typed') }, 'the draft is untouched')
})

test('Shift+Enter, IME composition and an empty box send nothing', async () => {
  const it = item({ payload: { questions: [Q('a')] } })
  const env = setup({ it, drafts: { a: draft('typed') } })
  need(env.T, 'QuestionBody')
  for (const over of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }]) {
    const e = keyEvent(over)
    boxes(env.render())[0].props.onKeyDown(e)
    assert.equal(e.prevented, 0, JSON.stringify(over))
  }
  env.T.set({ drafts: { q1: { a: draft('') } } })
  boxes(env.render())[0].props.onKeyDown(keyEvent())
  await tick()
  assert.equal(env.calls.length, 0)
})

test('the native event behind a React synthetic event is the one that counts', async () => {
  const it = item({ payload: { questions: [Q('a')] } })
  const env = setup({ it, drafts: { a: draft('typed') } })
  need(env.T, 'QuestionBody')
  const ime = { ...keyEvent(), nativeEvent: ENTER({ isComposing: true }) }
  boxes(env.render())[0].props.onKeyDown(ime)
  await tick()
  assert.equal(env.calls.length, 0, 'composition on the native event')
  const ok = { ...keyEvent(), nativeEvent: ENTER() }
  boxes(env.render())[0].props.onKeyDown(ok)
  await tick()
  assert.equal(env.calls.length, 1)
})

test('while a send is in flight, Enter sends nothing more (no double submit)', async () => {
  const gate = deferred()
  const calls = []
  const it = item({ payload: { questions: [Q('a')] } })
  const env = setup({ it, drafts: { a: draft('typed') }, fetchImpl: async (url) => { calls.push(url); await gate.promise; return okJson({ ok: true }) } })
  need(env.T, 'QuestionBody')
  const input = boxes(env.render())[0]
  input.props.onKeyDown(keyEvent())
  input.props.onKeyDown(keyEvent())
  input.props.onKeyDown(keyEvent())
  assert.equal(calls.length, 1, 'three Enters on the same rendered box, one request')
  gate.resolve()
  await tick()
})

test('a card that is already busy ignores Enter', async () => {
  const it = item({ payload: { questions: [Q('a')] } })
  const env = setup({ it, drafts: { a: draft('typed') }, busy: true })
  need(env.T, 'QuestionBody')
  const e = keyEvent()
  boxes(env.render())[0].props.onKeyDown(e)
  await tick()
  assert.equal(env.calls.length, 0)
  assert.equal(e.prevented, 0)
})

test('a failed send keeps the draft, so Enter can try again', async () => {
  const it = item({ payload: { questions: [Q('a')] } })
  let fail = true
  const calls = []
  const env = setup({ it, drafts: { a: draft('typed') }, fetchImpl: async (url) => { calls.push(url); return fail ? okJson({ ok: false, error: 'not-open' }, 409) : okJson({ ok: true }) } })
  need(env.T, 'QuestionBody')
  boxes(env.render())[0].props.onKeyDown(keyEvent())
  await tick(); await tick()
  assert.deepEqual(plain(env.T.state.drafts.q1), { a: draft('typed') })
  fail = false
  boxes(env.render())[0].props.onKeyDown(keyEvent())
  await tick(); await tick()
  assert.equal(calls.length, 2)
  assert.equal(env.T.state.drafts.q1, undefined)
})

test('the late-answer form of an expired question sends to the late-answer route on Enter, under the same rules', async () => {
  const it = item({ id: 'q2', type: 'question', payload: { questions: [Q('a'), Q('b')] } })
  const env = setup({ it, path: '/v1/late-answer', drafts: { a: draft('typed') } })
  need(env.T, 'QuestionBody')
  const e = keyEvent()
  boxes(env.render())[0].props.onKeyDown(e)
  await tick()
  assert.equal(env.calls.length, 0, 'the other question is unanswered')
  assert.equal(e.prevented, 0)
  env.T.set({ drafts: { q2: { a: draft('typed'), b: draft('', ['Yes']) } } })
  boxes(env.render())[0].props.onKeyDown(keyEvent())
  await tick()
  assert.deepEqual(plain(env.calls), [['/review-queue/v1/late-answer', { id: 'q2', answers: [{ id: 'a', selected: [], custom: 'typed' }, { id: 'b', selected: ['Yes'] }] }]])
})

test('Enter in the box is not an overlay hotkey: the overlay key map has no Enter, and typing in a box never maps', () => {
  const { T } = load()
  assert.equal(T.keyAction({ key: 'Enter', target: { tagName: 'INPUT' } }), undefined)
  assert.equal(T.keyAction({ key: 'Enter', target: { tagName: 'DIV' } }), undefined)
  for (const k of ['e', 'r', 'j', 'k', 'A', 'D']) assert.equal(T.keyAction({ key: k, shiftKey: k === 'A' || k === 'D', target: { tagName: 'INPUT' } }), undefined, k + ' typed in a box')
})

// ---------- the hint ----------

test('the key legend of the Task list says Enter sends when every question is answered', () => {
  const legend = source.match(/rq-hint"[^\n]*/)
  assert.ok(legend, 'the legend exists')
  assert.match(legend[0], /Enter sends when all questions are answered/)
})
