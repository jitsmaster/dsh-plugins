import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The desktop panel (lib/client.js): the two buttons under the tip of the day, "Go deeper" (a longer text, kept with the tip) and "Use in my code"
// (a workspace pick, then a drafted todo that lands in the New todo form; nothing is sent from here).
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')
const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
const TIP = { id: 't1', title: 'Bloom filters', body: 'A Bloom filter is a bit array. It never has false negatives.', category: 'algorithms', at: 1, source: 'model' }
const WS = [{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }]
const PARAS = ['A Bloom filter hashes each key k times and sets k bits.', 'With 10 bits per key and 7 hashes about 1 in 100 lookups is a false positive.', 'It cannot delete keys and it grows blurry when it fills up.']

/** routes: url -> (init) => [status, body]; every call is recorded as [url, parsed body]. */
function load({ routes = {}, stored = {} } = {}) {
  let registered
  const calls = []
  const store = { ...stored }
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v) } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    fetch: async (url, init) => {
      calls.push([url, init && init.body ? JSON.parse(init.body) : undefined])
      const route = routes[url]
      const [status, body] = route ? route(init) : url === '/review-queue/v1/workspaces' ? [200, { workspaces: WS }] : [200, { ok: true }]
      return { ok: status >= 200 && status < 300, status, json: async () => body }
    },
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: el, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  const mod = registered.factory(() => stubReact)
  return { mod, T: mod.__test, calls, store }
}
const find = (node, pred) => (node && typeof node === 'object' ? (pred(node) ? node : (node.children ?? []).map((c) => find(c, pred)).find(Boolean)) : undefined)
const findAll = (node, pred) => (node && typeof node === 'object' ? [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))] : [])
const text = (node) => (typeof node === 'string' ? node : typeof node === 'number' ? String(node) : (node?.children ?? []).map(text).join(''))
const expand = (node) => node.type(node.props)
const withClass = (tree, cls) => findAll(tree, (n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes(cls))
const tipCards = (tree) => findAll(tree, (n) => typeof n.type === 'function' && n.type.name === 'TipCard')
const snap = (over = {}) => ({ snapshotId: 'e:1', open: [], resolved: [], ...over })
const tick = () => new Promise((r) => setImmediate(r))
const card = (T) => expand(tipCards(T.Panel())[0])
const buttonText = (tree, re) => findAll(tree, (n) => n.type === 'button').find((b) => re.test(text(b)))
const RQ = '/review-queue'
const deeperOk = () => [200, { ok: true, deeper: { paragraphs: PARAS, source: 'model' } }]
const todoOk = (txt = 'In the Alpha workspace find one place where a Bloom filter would help, then add it with a test.') => () => [200, { ok: true, text: txt, workspaceId: 'w1', source: 'model' }]

test('the read-aloud button stays one button; Go deeper and Use in my code sit beside it, never inside it', () => {
  const { T } = load()
  T.state.snap = snap({ tip: TIP })
  const c = card(T)
  const read = withClass(c, 'rq-tip')[0]
  assert.equal(read.type, 'button')
  assert.equal(findAll(read, (n) => n.type === 'button').length, 1, 'no button inside the read-aloud button (only itself)')
  const actions = withClass(c, 'rq-tip-actions')[0]
  assert.ok(actions, 'an actions row')
  assert.equal(findAll(actions, (n) => n.type === 'button' && n === read).length, 0)
  assert.ok(buttonText(actions, /Go deeper/))
  assert.ok(buttonText(actions, /Use in my code/))
  assert.equal(buttonText(actions, /Go deeper/).props.type, 'button')
})

test('Go deeper asks the server for this tip, keeps the paragraphs in state and shows them as blocks in the card', async () => {
  const { T, calls } = load({ routes: { [RQ + '/v1/tip-deeper']: deeperOk } })
  T.state.snap = snap({ tip: TIP })
  buttonText(card(T), /Go deeper/).props.onClick()
  await tick()
  assert.deepEqual(calls.filter(([u]) => u.includes('tip-deeper')), [[RQ + '/v1/tip-deeper', { id: 't1' }]])
  assert.deepEqual(T.state.tipDeeper.t1, PARAS)
  const c = card(T)
  assert.deepEqual(withClass(c, 'rq-tip-d').map(text), PARAS)
  assert.equal(buttonText(c, /Go deeper/), undefined, 'the button is gone once the longer text is there')
  assert.ok(buttonText(c, /Use in my code/), 'the other button stays')
})

test('a tip that arrives with its longer text (a re-sent snapshot) shows it at once, without the Go deeper button', () => {
  const { T } = load()
  T.state.snap = snap({ tip: { ...TIP, deeper: { paragraphs: PARAS, source: 'model' } } })
  const c = card(T)
  assert.deepEqual(withClass(c, 'rq-tip-d').map(text), PARAS)
  assert.equal(buttonText(c, /Go deeper/), undefined)
})

test('the longer text of another tip is not shown on this one', () => {
  const { T } = load()
  T.state.tipDeeper = { other: PARAS }
  T.state.snap = snap({ tip: TIP })
  assert.equal(withClass(card(T), 'rq-tip-d').length, 0)
  assert.ok(buttonText(card(T), /Go deeper/))
})

test('Go deeper is disabled while it runs and a failure says why in words; the button stays', async () => {
  const { T } = load({ routes: { [RQ + '/v1/tip-deeper']: () => [409, { ok: false, error: 'no model available' }] } })
  T.state.snap = snap({ tip: TIP })
  const click = buttonText(card(T), /Go deeper/).props.onClick()
  assert.equal(buttonText(card(T), /Go deeper|Writing|…/).props.disabled, true, 'busy while the request is out')
  await click
  await tick()
  assert.match(text(card(T)), /no model/i)
  assert.doesNotMatch(text(card(T)), /Could not do that/)
  assert.equal(buttonText(card(T), /Go deeper/).props.disabled, false)
  assert.equal(T.state.tipDeeper.t1, undefined)
})

test('errorText knows the two new codes', () => {
  const { T } = load()
  assert.doesNotMatch(T.errorText(409, { error: 'no model available' }), /Could not do that/)
  assert.doesNotMatch(T.errorText(409, { error: 'LLM error' }), /Could not do that/)
})

test('Use in my code opens a workspace pick with a Draft todo button; pressing it again closes it', async () => {
  const { T } = load()
  T.state.snap = snap({ tip: TIP })
  assert.equal(withClass(card(T), 'rq-tip-use').length, 0, 'closed at first')
  await buttonText(card(T), /Use in my code/).props.onClick()
  assert.equal(T.state.tipUse.open, true)
  const use = withClass(card(T), 'rq-tip-use')[0]
  assert.ok(use)
  const select = find(use, (n) => n.type === 'select')
  assert.deepEqual(findAll(select, (n) => n.type === 'option').map(text), ['Alpha', 'Beta'])
  assert.ok(buttonText(use, /Draft todo/))
  await buttonText(card(T), /Use in my code/).props.onClick()
  assert.equal(T.state.tipUse.open, false)
  assert.equal(withClass(card(T), 'rq-tip-use').length, 0)
})

test('the workspace pick starts on the last one used for a tip todo, else on the first listed', async () => {
  const a = load({ stored: { 'dsh-review-queue.tipWorkspace': 'w2' } })
  a.T.state.snap = snap({ tip: TIP })
  await buttonText(card(a.T), /Use in my code/).props.onClick()
  assert.equal(find(withClass(card(a.T), 'rq-tip-use')[0], (n) => n.type === 'select').props.value, 'w2')
  const b = load({ stored: { 'dsh-review-queue.tipWorkspace': 'gone' } })
  b.T.state.snap = snap({ tip: TIP })
  await buttonText(card(b.T), /Use in my code/).props.onClick()
  assert.equal(find(withClass(card(b.T), 'rq-tip-use')[0], (n) => n.type === 'select').props.value, 'w1', 'a workspace that no longer exists is not used')
  const c = load()
  c.T.state.snap = snap({ tip: TIP })
  await buttonText(card(c.T), /Use in my code/).props.onClick()
  assert.equal(find(withClass(card(c.T), 'rq-tip-use')[0], (n) => n.type === 'select').props.value, 'w1')
})

test('changing the workspace in the pick is kept', async () => {
  const { T } = load()
  T.state.snap = snap({ tip: TIP })
  await buttonText(card(T), /Use in my code/).props.onClick()
  find(withClass(card(T), 'rq-tip-use')[0], (n) => n.type === 'select').props.onChange({ target: { value: 'w2' } })
  assert.equal(find(withClass(card(T), 'rq-tip-use')[0], (n) => n.type === 'select').props.value, 'w2')
})

test('Draft todo asks for the draft, puts it in the New todo form (open, not sent), remembers the workspace and closes the pick', async () => {
  const { T, calls, store } = load({ routes: { [RQ + '/v1/tip-todo']: todoOk() } })
  T.state.snap = snap({ tip: TIP })
  await buttonText(card(T), /Use in my code/).props.onClick()
  find(withClass(card(T), 'rq-tip-use')[0], (n) => n.type === 'select').props.onChange({ target: { value: 'w2' } })
  await buttonText(card(T), /Draft todo/).props.onClick()
  assert.deepEqual(calls.filter(([u]) => u.includes('tip-todo')), [[RQ + '/v1/tip-todo', { id: 't1', workspaceId: 'w2' }]])
  assert.equal(calls.some(([u]) => u === RQ + '/v1/todo'), false, 'nothing is added or sent')
  const f = T.state.todoForm
  assert.equal(f.open, true)
  assert.match(f.text, /Bloom filter/)
  assert.equal(f.workspaceId, 'w2')
  assert.equal(f.sparc, false)
  assert.equal(JSON.parse(store['dsh-review-queue.todoDraft']).text, f.text, 'the form draft is saved at once')
  assert.equal(store['dsh-review-queue.tipWorkspace'], 'w2')
  assert.equal(T.state.tipUse.open, false)
})

test('a draft does not overwrite text that is already typed in the form: it goes after it', async () => {
  const { T } = load({ routes: { [RQ + '/v1/tip-todo']: todoOk('Drafted text for the agent to follow, long enough.') } })
  T.state.snap = snap({ tip: TIP })
  T.patchForm({ open: true, text: 'my own words', workspaceId: '', sparc: true })
  await buttonText(card(T), /Use in my code/).props.onClick()
  await buttonText(card(T), /Draft todo/).props.onClick()
  assert.equal(T.state.todoForm.text, 'my own words\n\nDrafted text for the agent to follow, long enough.')
  assert.equal(T.state.todoForm.sparc, true, 'the form keeps its Use SPARC choice when it already had text')
  assert.equal(T.state.todoForm.workspaceId, 'w1', 'the workspace is the one the draft names, so Add todo starts it there')
})

test('a failed draft is said in words on the card and leaves the form alone', async () => {
  const { T } = load({ routes: { [RQ + '/v1/tip-todo']: () => [409, { ok: false, error: 'unknown-workspace' }] } })
  T.state.snap = snap({ tip: TIP })
  const before = JSON.stringify(T.state.todoForm)
  await buttonText(card(T), /Use in my code/).props.onClick()
  await buttonText(card(T), /Draft todo/).props.onClick()
  assert.match(text(card(T)), /no longer exists/)
  assert.equal(JSON.stringify(T.state.todoForm), before)
  assert.equal(T.state.tipUse.open, true, 'the pick stays so another workspace can be tried')
  assert.equal(buttonText(card(T), /Draft todo/).props.disabled, false)
})

test('a draft that is refused as busy says so in words that fit (not the session-message text)', async () => {
  const { T } = load({ routes: { [RQ + '/v1/tip-todo']: () => [409, { ok: false, error: 'busy' }] } })
  T.state.snap = snap({ tip: TIP })
  await buttonText(card(T), /Use in my code/).props.onClick()
  await buttonText(card(T), /Draft todo/).props.onClick()
  assert.match(text(card(T)), /already being drafted/)
  assert.doesNotMatch(text(card(T)), /session/)
})

test('with no workspace listed the pick says so without mentioning "Choose for me" (it has no such entry)', async () => {
  const { T } = load({ routes: { [RQ + '/v1/workspaces']: () => [200, { workspaces: [] }] } })
  T.state.snap = snap({ tip: TIP })
  await buttonText(card(T), /Use in my code/).props.onClick()
  assert.match(text(withClass(card(T), 'rq-tip-use')[0]), /No workspace is listed yet/)
  assert.doesNotMatch(text(withClass(card(T), 'rq-tip-use')[0]), /Choose for me/)
})

test('Draft todo waits while the New todo form is tuning or adding (a late tune or add would overwrite the draft)', async () => {
  for (const busy of [{ tuning: true }, { busy: true }]) {
    const { T, calls } = load({ routes: { [RQ + '/v1/tip-todo']: todoOk() } })
    T.state.snap = snap({ tip: TIP })
    await buttonText(card(T), /Use in my code/).props.onClick()
    T.patchForm({ open: true, text: 'typed', ...busy })
    assert.equal(buttonText(card(T), /Draft todo/).props.disabled, true, JSON.stringify(busy))
    assert.equal(await buttonText(card(T), /Draft todo/).props.onClick(), false)
    assert.equal(calls.some(([u]) => u.includes('tip-todo')), false, 'no request is made')
  }
})

test('Draft todo is disabled while it runs and with no workspace listed', async () => {
  const { T } = load({ routes: { [RQ + '/v1/workspaces']: () => [200, { workspaces: [] }] } })
  T.state.snap = snap({ tip: TIP })
  await buttonText(card(T), /Use in my code/).props.onClick()
  assert.equal(buttonText(card(T), /Draft todo/).props.disabled, true)
  const b = load({ routes: { [RQ + '/v1/tip-todo']: todoOk() } })
  b.T.state.snap = snap({ tip: TIP })
  await buttonText(card(b.T), /Use in my code/).props.onClick()
  const pending = buttonText(card(b.T), /Draft todo/).props.onClick()
  assert.equal(buttonText(card(b.T), /Draft|Drafting|…/).props.disabled, true)
  await pending
})

test('the new parts have styles and the script still has no lookbehind', () => {
  const { T } = load()
  assert.match(T.CSS, /\.rq-tip-actions\{/)
  assert.match(T.CSS, /\.rq-tip-d\{/)
  assert.match(T.CSS, /\.rq-tip-use\{/)
  assert.doesNotMatch(source, /\(\?<[=!]/)
})

test('a Tune that starts while the draft is being written is cancelled, so its late text cannot overwrite the draft', async () => {
  let T
  const loaded = load({ routes: { [RQ + '/v1/tip-todo']: () => { T.patchForm({ tuning: true }); return todoOk('Drafted text for the agent to follow, long enough.')() } } })
  T = loaded.T
  T.state.snap = snap({ tip: TIP })
  await buttonText(card(T), /Use in my code/).props.onClick()
  await buttonText(card(T), /Draft todo/).props.onClick()
  assert.equal(T.state.todoForm.tuning, false)
  assert.equal(T.state.todoForm.text, 'Drafted text for the agent to follow, long enough.')
})

test('the open state of Use in my code has a visible style', () => {
  const { T } = load()
  assert.match(T.CSS, /\.rq-btn\.on\{/)
})

test('an "Another tip" button sits in the actions row and asks the server for a new tip', async () => {
  const { T, calls } = load({ routes: { [RQ + '/v1/tip-next']: () => [200, { ok: true, tip: { ...TIP, id: 't2' } }] } })
  T.state.snap = snap({ tip: TIP })
  const actions = withClass(card(T), 'rq-tip-actions')[0]
  const b = buttonText(actions, /Another tip/)
  assert.ok(b)
  assert.equal(b.props.type, 'button')
  b.props.onClick()
  await tick()
  assert.deepEqual(calls.filter(([u]) => u.includes('tip-next')), [[RQ + '/v1/tip-next', {}]])
})
