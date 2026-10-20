import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { source, file } from './client-todo-helpers.mjs'

// Action items (<u>**...**</u>, the transport sessions and the summary model write) in the desktop Task list (lib/client.js):
// every place that shows item text renders them as emphasis (bold, bigger, NOT underlined) and never shows the tags themselves, whatever
// shape the model gave them (capitals, escaped, no bold markers, reversed, nested, unbalanced, a star inside). Everything else stays
// escaped text: elements are built with React children only, never as HTML.
function load() {
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } },
    console, setInterval, clearInterval, setTimeout: () => 1, clearTimeout() {}, fetch: () => new Promise(() => {}),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
    Fragment: Symbol('Fragment'),
    useState: (v) => [v, () => {}], useEffect() {}, useRef: () => ({ current: null }), useSyncExternalStore: (sub, get) => get(),
  }
  return registered.factory(() => React)
}
const mod = load()
const T = mod.__test
const plain = (v) => JSON.parse(JSON.stringify(v))

/** The element tree with every function component called, so what is returned is what the page would hold. */
function expand(n) {
  if (Array.isArray(n)) return n.map(expand)
  if (!n || typeof n !== 'object') return n
  if (typeof n.type === 'function') return expand(n.type({ ...n.props, children: n.children }))
  return { ...n, children: (n.children || []).map(expand) }
}
const walk = (n, out = []) => { if (Array.isArray(n)) n.forEach((c) => walk(c, out)); else if (n && typeof n === 'object') { out.push(n); (n.children || []).forEach((c) => walk(c, out)) } return out }
/** Every text the page shows (text children and title / aria attributes), tag by tag. */
const texts = (tree) => { const out = []; const visit = (n) => { if (typeof n === 'string') out.push(n); else if (Array.isArray(n)) n.forEach(visit); else if (n && typeof n === 'object') { if (typeof n.props?.title === 'string') out.push(n.props.title); (n.children || []).forEach(visit) } }; visit(tree); return out }
const everything = (tree) => texts(tree).join('\n')
const TAG = /<\/?u\b|&lt;\/?u|&gt;/i
const actions = (tree) => walk(tree).filter((n) => n.type === 'strong' && n.props.className === 'rq-action').map((n) => n.children.join(''))
const render = (node) => expand(node)

// A reply the way a session writes it after being told to put action items in <u>**...**</u> (the shapes that went wrong are all in here).
const REPLY = [
  'Fixed the list and rebuilt the bundle.',
  '',
  '<u>**Restart DSH, run `pnpm run dev:web` and refresh the page (the *.js files changed).**</u>',
  '',
  '<u>**Which of the two layouts do you want?**</u>',
  '',
  '- <u>**Approve the PR**</u>',
  '- a plain item',
  '',
  '**<u>Reply A or B.</u>**',
  '',
  '<U>**Capitals work too.**</U>',
  '',
  '&lt;u&gt;**Escaped tags.**&lt;/u&gt;',
  '',
  '<u>No bold markers here.</u>',
  '',
  '> <u>**Quoted action.**</u>',
  '',
  '## <u>**Next steps**</u>',
].join('\n')

// ---------- the tokenizer ----------

test('mdInline reads every spelling of an action item as one action token', () => {
  const cases = {
    '<u>**Restart it?**</u>': 'Restart it?',
    '<u>Restart it?</u>': 'Restart it?',
    '<U>**Restart it?**</U>': 'Restart it?',
    '< u >**Restart it?**< / u >': 'Restart it?',
    '&lt;u&gt;**Restart it?**&lt;/u&gt;': 'Restart it?',
    '**<u>Restart it?</u>**': 'Restart it?',
    '<u>**Restart *.js and `x` too**</u>': 'Restart *.js and x too',
    '<u>**Do *this* now**</u>': 'Do this now',
    '<u>**Do **this** now**</u>': 'Do this now',
    '<u>**Restart [the docs](https://example.com) it?**</u>': 'Restart the docs it?',
  }
  for (const [src, want] of Object.entries(cases)) {
    const toks = plain(T.mdInline('Ready. ' + src + ' ok'))
    assert.deepEqual(toks, [{ t: 'text', text: 'Ready. ' }, { t: 'bu', text: want }, { t: 'text', text: ' ok' }], src)
  }
})

test('mdInline: tags on their own lines around the words still give one action token', () => {
  const toks = plain(T.mdInline('<u>\n**Restart it?**\n</u>'))
  assert.deepEqual(toks.filter((x) => x.t === 'bu'), [{ t: 'bu', text: 'Restart it?' }])
  assert.equal(toks.map((x) => x.text).join('').trim(), 'Restart it?')
})

test('mdInline: nested, doubled, unbalanced and empty action tags never leak', () => {
  const bu = (text) => ({ t: 'bu', text })
  assert.deepEqual(plain(T.mdInline('<u><u>**x**</u></u>')), [bu('x')], 'nested')
  assert.deepEqual(plain(T.mdInline('a <u>x</u></u> b')), [{ t: 'text', text: 'a ' }, bu('x'), { t: 'text', text: ' b' }], 'a stray close is dropped')
  assert.deepEqual(plain(T.mdInline('a </u> b')), [{ t: 'text', text: 'a  b' }], 'a close alone is dropped')
  assert.deepEqual(plain(T.mdInline('Ready. <u>**Cut off in the mid')), [{ t: 'text', text: 'Ready. ' }, bu('Cut off in the mid')], 'an open tag runs to the end of its text')
  const empty = plain(T.mdInline('a <u></u> b <u>**  **</u> c'))
  assert.equal(empty.length, 1, 'empty spans vanish')
  assert.equal(empty[0].text.replace(/\s+/g, ' '), 'a b c')
  assert.deepEqual(plain(T.mdInline('x<u> spaced </u>y')), [{ t: 'text', text: 'x ' }, bu('spaced'), { t: 'text', text: ' y' }], 'inner blanks stay between the words')
})

test('mdInline leaves the tags alone inside inline code, and every other tag stays plain text', () => {
  assert.deepEqual(plain(T.mdInline('Write `<u>**x**</u>` around it')), [{ t: 'text', text: 'Write ' }, { t: 'code', text: '<u>**x**</u>' }, { t: 'text', text: ' around it' }])
  assert.deepEqual(plain(T.mdInline('<b>x</b> <ul><li>y</li></ul> <script>alert(1)</script>')), [{ t: 'text', text: '<b>x</b> <ul><li>y</li></ul> <script>alert(1)</script>' }])
})

test('the plain readers: actionTokens keeps other markdown as text, plainAction drops the tags', () => {
  need('actionTokens'); need('plainAction')
  assert.deepEqual(plain(T.actionTokens('use *.js: <u>**now**</u>!')), [{ t: 'text', text: 'use *.js: ' }, { t: 'bu', text: 'now' }, { t: 'text', text: '!' }])
  assert.equal(T.plainAction('Done <U>**Reply A**</U> or <u>B</u>'), 'Done Reply A or B')
  assert.equal(T.plainAction(undefined), '')
  assert.equal(T.plainAction('no tags'), 'no tags')
})
function need(name) { assert.equal(typeof T[name], 'function', 'lib/client.js must export ' + name + ' in __test') }

// ---------- what the page shows ----------

test('the full reply (Md) shows each action item as emphasis and no tag, everywhere in the text', () => {
  const tree = render(T.Md({ text: REPLY }))
  assert.doesNotMatch(everything(tree), TAG, everything(tree))
  assert.deepEqual(actions(tree), ['Restart DSH, run pnpm run dev:web and refresh the page (the *.js files changed).', 'Which of the two layouts do you want?', 'Approve the PR', 'Reply A or B.', 'Capitals work too.', 'Escaped tags.', 'No bold markers here.', 'Quoted action.', 'Next steps'])
})

test('a done card (summary and full reply) shows no tags and no underline', () => {
  const item = { id: 'c1', type: 'completed', summary: 'Fixed it.\n\n<u>**Restart the service *now*.**</u>', payload: { reply: REPLY } }
  const tree = render(T.CompletedBody({ item, full: true }))
  assert.doesNotMatch(everything(tree), TAG)
  assert.ok(actions(tree).includes('Restart the service now.'))
  assert.ok(walk(tree).filter((n) => n.type === 'strong' && n.props.className === 'rq-action').every((n) => !n.props.style), 'no inline underline style')
  assert.doesNotMatch(JSON.stringify(plain(tree)), /underline/)
})

test('the compact card summary (clamped) renders the action too', () => {
  const item = { id: 'c2', type: 'completed', summary: 'Fixed it.\n\n<U>**Pick A or B?**</U>', payload: {} }
  const tree = render(T.CompletedBody({ item, full: false }))
  assert.doesNotMatch(everything(tree), TAG)
  assert.deepEqual(actions(tree), ['Pick A or B?'])
})

test('question text, header and option text render the action and show no tag, full and compact', () => {
  const q = { id: 'q', header: '<u>**Heads up**</u>', question: 'Deploy now? <u>**Say yes only after the backup.**</u>', options: [{ label: 'Yes', description: 'Run <u>**the backup first**</u>' }, { label: 'No' }] }
  const item = { id: 'q1', type: 'question', payload: { questions: [q] } }
  for (const full of [true, false]) {
    const tree = render(T.QuestionBody({ item, full }))
    assert.doesNotMatch(everything(tree), TAG, 'full=' + full)
    assert.ok(actions(tree).includes('Say yes only after the backup.'), 'full=' + full)
  }
  assert.ok(actions(render(T.QuestionBody({ item, full: true }))).includes('the backup first'))
})

test('a permission request shows its reason with the action rendered; the command stays literal', () => {
  const item = { id: 'p1', type: 'permission', payload: { toolName: 'bash', summary: 'echo "<u>x</u>"', detail: 'echo "<u>x</u>"', reason: 'Needs it. <u>**Check the path first.**</u>' } }
  const tree = render(T.PermissionBody({ item, full: true }))
  assert.ok(actions(tree).includes('Check the path first.'))
  assert.match(everything(tree), /echo "<u>x<\/u>"/, 'a command is shown exactly as it is')
  assert.doesNotMatch(texts(tree).filter((s) => /Needs it/.test(s)).join(''), TAG)
})

test('card titles and the resolved card show no tags (title, tooltip)', () => {
  assert.equal(T.cardTitle({ title: 'Ask <u>**now**</u>' }), 'Ask now')
  assert.equal(T.cardTitle({ sessionTitle: '<U>x</U>' }), 'x')
  assert.equal(T.cardTitle({}), 'Untitled')
  const it = { id: 'r1', type: 'completed', title: 'T', summary: 'Done.\n\n<u>**Open it.**</u>', resolution: { kind: 'no-action' }, resolvedAt: 1, payload: {} }
  const tree = render(T.ResolvedCard({ it }))
  assert.doesNotMatch(everything(tree), TAG)
})

test('the search filter looks at the words, not at the tags', () => {
  const items = [{ id: 'a', type: 'completed', title: 'x', summary: 'Done. <u>**restart**</u>', payload: {} }, { id: 'b', type: 'completed', title: 'y', summary: 'Done.', payload: {} }]
  assert.equal(T.filterItems(items, { type: 'all', query: 'restart' }).length, 1)
  assert.equal(T.filterItems(items, { type: 'all', query: '<u>' }).length, 0)
})

test('an action token is a bold element with the rq-action class and no inline style', () => {
  const tree = render(T.mdNodes('x <u>**Do it**</u> y'))
  const el = walk(tree).find((n) => n.type === 'strong')
  assert.equal(el.props.className, 'rq-action')
  assert.equal(el.props.style, undefined)
  assert.deepEqual(el.children, ['Do it'])
})

test('scripts and other tags in a message are plain text children, never HTML', () => {
  const tree = render(T.Md({ text: '<script>alert(1)</script> <img src=x onerror=alert(1)> <u>**ok**</u>' }))
  assert.match(everything(tree), /<script>alert\(1\)<\/script> <img src=x onerror=alert\(1\)>/)
  assert.ok(!walk(tree).some((n) => n.type === 'script' || n.type === 'img'))
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML\s*=/)
})

// ---------- the look ----------

const cssRule = (selector) => { const m = new RegExp('(?:^|})' + selector.replace(/[.]/g, '\\.') + '\\{([^}]*)\\}').exec(T.CSS); return m ? m[1] : undefined }

test('the action text is bold, one step bigger and not underlined (desktop CSS)', () => {
  const rule = cssRule('.rq-action')
  assert.ok(rule, '.rq-action has a rule in the style string')
  assert.match(rule, /font-weight:700/)
  assert.match(rule, /font-size:1\.15em/)
  assert.match(rule, /text-decoration:none/)
  assert.match(rule, /line-height:1\.\d+/)
  assert.doesNotMatch(T.CSS, /underline/)
})
