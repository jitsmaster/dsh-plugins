import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { source, file, okJson, deferred, need, tick } from './client-todo-helpers.mjs'

// The Task list header: a "Pause all & quit" button, and Close as a split button whose menu has Close and Quit.
// A tiny React: elements are plain objects, useState keeps its value per call order and records the setter.
function load({ fetchImpl } = {}) {
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } },
    console, setInterval, clearInterval, setTimeout: () => 1, clearTimeout() {}, fetch: fetchImpl ?? (() => new Promise(() => {})),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const hooks = { states: [], i: 0, effects: [] }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
    Fragment: Symbol('Fragment'),
    useState: (v) => { const k = hooks.i++; if (!(k in hooks.states)) hooks.states[k] = v; return [hooks.states[k], (n) => { hooks.states[k] = n }] },
    useEffect: (fn, deps) => { hooks.effects.push({ fn, deps }) }, useRef: () => ({ current: null }), useSyncExternalStore: (sub, get) => get(),
  }
  const mod = registered.factory(() => React)
  const render = (fn) => { hooks.i = 0; hooks.effects = []; return fn() }
  return { T: mod.__test, hooks, render }
}
const walk = (n, out = []) => { if (n && typeof n === 'object') { out.push(n); (n.children || []).forEach((c) => walk(c, out)) } return out }
const find = (n, rq) => walk(n).find((x) => x.props && x.props['data-rq'] === rq)
const strings = (n) => (typeof n === 'string' ? [n] : n && typeof n === 'object' ? (n.children || []).flatMap(strings) : [])
const text = (n) => strings(n).join('')

test('CloseMenu: the default button is Close; the menu is closed until the caret is pressed, then offers Close and Quit', () => {
  const { T, hooks, render } = load()
  need(T, 'CloseMenu')
  const first = render(() => T.CloseMenu())
  assert.equal(find(first, 'close').children.join(''), '✕ Close')
  assert.equal(find(first, 'menu-quit'), undefined, 'closed')
  find(first, 'close-more').props.onClick()
  const open = render(() => T.CloseMenu())
  assert.equal(find(open, 'close-more').props['aria-expanded'], true)
  assert.deepEqual(['menu-close', 'menu-quit'].map((k) => find(open, k).children.join('')), ['Close', 'Quit'])
  assert.deepEqual(hooks.states[0], true)
})

test('Quit in the menu closes the menu and asks for a confirmation; nothing is sent yet', async () => {
  let sent = 0
  const { T, hooks, render } = load({ fetchImpl: async () => { sent++; return okJson({ ok: true }) } })
  need(T, 'askPower')
  find(render(() => T.CloseMenu()), 'close-more').props.onClick()
  find(render(() => T.CloseMenu()), 'menu-quit').props.onClick()
  assert.equal(hooks.states[0], false, 'menu closed')
  assert.deepEqual(JSON.parse(JSON.stringify(T.state.power)), { phase: 'confirm', kind: 'quit' })
  assert.equal(sent, 0)
})

test('runPower posts /v1/quit or /v1/pause-all only after the confirmation, shows the wait and then the outcome', async () => {
  for (const [kind, url, answer] of [['quit', '/review-queue/v1/quit', { ok: true, quitting: true }], ['pause', '/review-queue/v1/pause-all', { ok: true, paused: 3, quitting: true }]]) {
    const seen = []
    const gate = deferred()
    const { T } = load({ fetchImpl: async (u, init) => { seen.push([u, init.method]); await gate.promise; return okJson(answer) } })
    assert.equal(await T.runPower(), false, 'nothing to confirm yet')
    T.askPower(kind)
    const run = T.runPower()
    assert.equal(T.state.power.phase, 'working')
    assert.equal(await T.runPower(), false, 'a second click while working does nothing')
    gate.resolve()
    await run
    assert.deepEqual(seen, [[url, 'POST']])
    assert.deepEqual([T.state.power.phase, T.state.power.kind, T.state.power.paused], ['done', kind, answer.paused])
  }
})

test('a refusal shows its words and the bar stays until it is closed', async () => {
  const { T } = load({ fetchImpl: async () => okJson({ ok: false, error: 'no-desktop' }, 409) })
  T.askPower('pause')
  await T.runPower()
  assert.equal(T.state.power.phase, 'error')
  assert.match(T.state.power.text, /not the DSH desktop app/)
  T.closePower()
  assert.equal(T.state.power, null)
  const down = load({ fetchImpl: async () => { throw new Error('offline') } })
  down.T.askPower('quit')
  await down.T.runPower()
  assert.match(down.T.state.power.text, /Request failed: offline/)
})

test('PowerBar shows the question with the matching button, and nothing when idle', () => {
  const { T, render } = load()
  assert.equal(render(() => T.PowerBar()), null)
  T.askPower('pause')
  const bar = render(() => T.PowerBar())
  assert.match(text(bar), /Pause every running session/)
  assert.equal(find(bar, 'power-go').children.join(''), 'Pause all and quit')
  T.askPower('quit')
  const q = render(() => T.PowerBar())
  assert.match(text(q), /Quit DSH\?/)
  assert.equal(find(q, 'power-go').children.join(''), 'Quit')
})

test('the source: the Pause all & quit button is in the header, the overlay Close is the menu, and the old plain Close button is gone', () => {
  const s = readFileSync(file, 'utf8')
  assert.match(s, /"data-rq": "pause-all"/)
  assert.match(s, /const extra = h\(CloseMenu\)/)
  assert.ok(!/const extra = h\("button"/.test(s))
  assert.match(s, /h\(PowerBar\), h\(ResumeAllBar\)/)
})
