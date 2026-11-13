// Slice 4 client: a done card with a decision payload shows the question and its options; an option fills the reply draft, Send reply goes through /v1/reply (follow-up path, never /v1/answer).
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el, okJson, findAll, textOf } from './client-todo-helpers.mjs'

const item = (decision) => ({ id: 'd1', type: 'completed', status: 'open', sessionId: 's1', summary: 'Built it.', payload: { reply: 'Built it.' }, ...(decision ? { decision } : {}) })
const setup = () => loadClient({ fetchImpl: async () => okJson({ ok: true }), react: { createElement: el } }).T
const opts = (tree) => findAll(tree, (n) => n.props && n.props['data-decision-opt'] !== undefined)
const blocks = (tree) => findAll(tree, (n) => n.props && n.props['data-decision'] !== undefined)

test('a decision shows its text and one button per option (full card)', () => {
  const T = setup()
  const tree = T.CompletedBody({ item: item({ text: 'Ship A or B?', options: ['A', 'B'], free: true }), full: true })
  assert.equal(blocks(tree).length, 1)
  assert.match(textOf(blocks(tree)[0]), /Ship A or B\?/)
  assert.deepEqual(opts(tree).map((n) => n.props['data-decision-opt']), ['A', 'B'])
})

test('clicking an option fills the reply draft; the reply textarea stays (free answer)', () => {
  const T = setup()
  const it = item({ text: 'Q?', options: ['A', 'B'], free: true })
  opts(T.CompletedBody({ item: it, full: true }))[1].props.onClick()
  assert.equal(T.state.replies.d1, 'B')
  assert.equal(findAll(T.CompletedBody({ item: it, full: true }), (n) => n.type === 'textarea').length, 1)
})

test('no decision, or a compact card: no decision block', () => {
  const T = setup()
  assert.equal(blocks(T.CompletedBody({ item: item(), full: true })).length, 0)
  assert.equal(opts(T.CompletedBody({ item: item({ text: 'Q?', options: ['A'], free: true }), full: false })).length, 0)
})

test('Send reply posts the chosen option to /v1/reply, never /v1/answer', async () => {
  const urls = []
  const { T } = loadClient({ fetchImpl: async (u, o) => { urls.push([String(u), o && o.body]); return okJson({ ok: true }) }, react: { createElement: el } })
  const it = item({ text: 'Q?', options: ['A', 'B'], free: true })
  opts(T.CompletedBody({ item: it, full: true }))[0].props.onClick()
  const send = findAll(T.CompletedBody({ item: it, full: true }), (n) => n.type === 'button' && textOf(n) === 'Send reply')[0]
  await send.props.onClick()
  assert.ok(urls.some(([u, b]) => /\/v1\/reply$/.test(u) && /"text":"A"/.test(b)), JSON.stringify(urls))
  assert.equal(urls.some(([u]) => /\/v1\/answer/.test(u)), false)
})

test('a decision with no options shows only its text and the reply box', () => {
  const T = setup()
  const tree = T.CompletedBody({ item: item({ text: 'Why?', options: [], free: true }), full: true })
  assert.equal(blocks(tree).length, 1)
  assert.equal(opts(tree).length, 0)
  assert.equal(findAll(tree, (n) => n.type === 'textarea').length, 1)
})

test('a compact card shows the decision text (clamped) but no option buttons', () => {
  const T = setup()
  const tree = T.CompletedBody({ item: item({ text: 'Ship A or B?', options: ['A', 'B'], free: true }), full: false })
  const c = findAll(tree, (n) => n.props && n.props['data-decision-compact'] !== undefined)
  assert.equal(c.length, 1)
  assert.match(textOf(c[0]), /Ship A or B\?/)
  assert.equal(opts(tree).length, 0)
  assert.equal(findAll(T.CompletedBody({ item: item(), full: false }), (n) => n.props && n.props['data-decision-compact'] !== undefined).length, 0)
})

test('decision text renders as plain text, not markup nodes; the full card labels the options as AI-suggested', () => {
  const T = setup()
  const tree = T.CompletedBody({ item: item({ text: 'Ship <u>**A**</u>?', options: ['A', 'B'], free: true }), full: true })
  assert.equal(findAll(tree, (n) => n.type === 'u' || n.type === 'strong').length, 0)
  assert.match(textOf(blocks(tree)[0]), /Ship <u>\*\*A\*\*<\/u>\?/)
  assert.equal(findAll(tree, (n) => n.props && n.props['data-decision-label'] !== undefined).length, 1)
  assert.match(textOf(findAll(tree, (n) => n.props && n.props['data-decision-label'] !== undefined)[0]), /AI-suggested/)
})

test('compact decision text is plain too; the full card labels a no-options decision as AI-suggested as well', () => {
  const T = setup()
  const c = findAll(T.CompletedBody({ item: item({ text: 'Ship <u>A</u>?', options: ['A', 'B'], free: true }), full: false }), (n) => n.props && n.props['data-decision-compact'] !== undefined)
  assert.equal(findAll(c[0], (n) => n.type === 'u').length, 0)
  assert.match(textOf(c[0]), /<u>A<\/u>/)
  const tree = T.CompletedBody({ item: item({ text: 'Why?', options: [], free: true }), full: true })
  assert.equal(findAll(tree, (n) => n.props && n.props['data-decision-label'] !== undefined).length, 1)
})

test('the compact card carries the AI-suggested label before the decision text (rq-opt-label, not rq-hint)', () => {
  const T = setup()
  const tree = T.CompletedBody({ item: item({ text: 'Ship A or B?', options: [], free: true }), full: false })
  const c = findAll(tree, (n) => n.props && n.props['data-decision-compact'] !== undefined)[0]
  assert.match(textOf(c), /^AI-suggested: Ship A or B\?/)
  const label = findAll(c, (n) => n.props && n.props['data-decision-label'] !== undefined)
  assert.equal(label.length, 1)
  assert.equal(label[0].props.className, 'rq-opt-label')
  assert.equal(findAll(tree, (n) => n.props && /rq-hint/.test(n.props.className || '')).length, 0)
})
