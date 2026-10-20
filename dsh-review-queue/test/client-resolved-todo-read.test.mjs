import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// A todo that was started ends in the Resolved list; its card can be read aloud (the whole todo text and where it started) like an open card.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')
const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) })
function load({ fetchImpl } = {}) {
  let registered
  const calls = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    fetch: fetchImpl ?? (async (url, init) => { calls.push([url, init && init.body ? JSON.parse(init.body) : undefined]); return { ok: true, status: 200, json: async () => ({ ok: true }) } }),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: el, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  const mod = registered.factory(() => stubReact)
  return { T: mod.__test, calls }
}
const findAll = (node, pred) => (node && typeof node === 'object' ? [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))] : [])
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''))
const play = (tree) => findAll(tree, (n) => n.type === 'button' && typeof n.props.className === 'string' && n.props.className.split(' ').includes('rq-play'))
const todo = (over = {}) => ({ id: 't1', type: 'todo', status: 'resolved', state: 'started', text: 'Fix the login redirect', workspaceTitle: 'dsh-plugins', sessionId: 's1', createdAt: 1, resolvedAt: 2, resolution: { kind: 'started' }, ...over })

test('a resolved todo card has a Read aloud button that asks the server to read that item', async () => {
  const { T, calls } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [todo()] }
  const buttons = play(T.ResolvedCard({ it: todo() }))
  assert.equal(buttons.length, 1)
  assert.match(text(buttons[0]), /Read aloud/)
  buttons[0].props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls, [['/review-queue/v1/read', { id: 't1' }]])
})

test('while that todo is read the button says Stop reading and a click stops it', async () => {
  const { T, calls } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [todo()], reading: 't1' }
  const button = play(T.ResolvedCard({ it: todo() }))[0]
  assert.match(text(button), /Stop reading/)
  assert.equal(button.props['aria-pressed'], true)
  button.props.onClick()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(calls.map(([u]) => u), ['/review-queue/v1/stop'])
})

test('other resolved cards keep no read button', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  for (const type of ['completed', 'question', 'permission', 'pr-merged', 'paused']) {
    assert.equal(play(T.ResolvedCard({ it: { id: 'x', type, status: 'resolved', resolution: { kind: 'reviewed' }, createdAt: 1 } })).length, 0, type)
  }
})
