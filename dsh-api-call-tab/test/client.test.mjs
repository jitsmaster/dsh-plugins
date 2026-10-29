import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// dsh-api-call-tab browser bundle: registration shape + the ApiCallTab element tree, with a tiny hook runner.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')

// Function components (hook-free sub-components) are expanded eagerly so the tree is plain elements.
const el = (type, props, ...children) => {
  const kids = children.flat(Infinity)
  if (typeof type === 'function') return type({ ...(props || {}), children: kids.length === 1 ? kids[0] : kids })
  return { type, props: props || {}, children: kids }
}

// Minimal hooks: state slots + effects with deps and cleanup, re-render on setState.
function mount(Component, initialProps) {
  let props = initialProps
  const slots = []
  let tree
  let cursor = 0
  let pending = []
  const cleanups = []
  function render() {
    cursor = 0; pending = []
    tree = Component(props)
    for (const run of pending) run()
  }
  const React = {
    createElement: el, Fragment: 'Fragment',
    useState(init) {
      const i = cursor++
      if (!(i in slots)) slots[i] = { v: typeof init === 'function' ? init() : init }
      const s = slots[i]
      return [s.v, (v) => { s.v = typeof v === 'function' ? v(s.v) : v; render() }]
    },
    useEffect(fn, deps) {
      const i = cursor++
      const prev = slots[i]
      if (prev && deps && prev.deps && deps.every((d, k) => Object.is(d, prev.deps[k]))) return
      pending.push(() => {
        if (prev && prev.cleanup) prev.cleanup()
        const entry = { deps }
        slots[i] = entry
        entry.cleanup = fn()
      })
    },
    useMemo: (fn) => fn(), useCallback: (fn) => fn, useRef: (v) => ({ current: v }),
  }
  const api = { React, render, get tree() { return tree },
    rerender(p) { props = p; render() },
    unmount() { slots.forEach((s) => s && s.cleanup && s.cleanup()) } }
  return api
}

function load() {
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } } }, console, setTimeout, clearTimeout, navigator: {} }
  vm.runInNewContext(source, sandbox, { filename: file })
  return registered
}
const registered = load()
assert.equal(registered.id, 'dsh-api-call-tab')

// The factory is called once per mount; hooks are proxied to that mount.
function start(props) {
  const holder = {}
  const proxy = { createElement: el, Fragment: 'Fragment',
    useState: (...a) => holder.m.React.useState(...a), useEffect: (...a) => holder.m.React.useEffect(...a),
    useMemo: (fn) => fn(), useCallback: (fn) => fn, useRef: (v) => ({ current: v }) }
  const mod = registered.factory(() => proxy)
  holder.m = mount(mod.__test.ApiCallTab, props)
  holder.m.render()
  return holder.m
}

const walk = (n, out = []) => { if (n && typeof n === 'object') { out.push(n); n.children.forEach((c) => walk(c, out)) } return out }
const text = (n) => (n && typeof n === 'object' ? n.children.map(text).join(' ') : n === null || n === undefined ? '' : String(n))
const tick = () => new Promise((r) => setTimeout(r, 0))

const payload = (over = {}) => ({
  argv: ['claude', '-p', '--model', 'sonnet'], envKeys: ['PATH', 'HOME'], system: 'You are SYSTEM_PROMPT_TEXT',
  tools: [{ name: 'Read', description: 'Reads files', inputSchema: { type: 'object', properties: { p: { type: 'string' } } } }],
  stdin: 'hello STDIN_TEXT', ...over,
})
const ok = (value) => async () => ({ ok: true, value })
const record = (over = {}) => ({ kind: 'message', index: 1, turn: 1, payloadBlob: 'blob1', ...over })

test('apply registers the tab in the trajectory detail slot', () => {
  const mod = registered.factory(() => ({ createElement: el }))
  const calls = { inject: [], register: [], effects: [] }
  const ctx = {
    effect: (fn, label) => { calls.effects.push(label); fn() },
    slots: {
      inject: (key, fn) => { calls.inject.push(key); fn() },
      register: (opts, comp) => { calls.register.push({ opts, comp }) },
    },
  }
  mod.apply(ctx)
  assert.deepEqual(calls.inject, ['conversation.trajectory.detail.tabs'])
  const { opts, comp } = calls.register[0]
  assert.equal(opts.name, 'conversation.trajectory.detail.tabs')
  assert.equal(opts.id, 'api-call')
  assert.equal(opts.label(), 'API Call')
  assert.equal(opts.order, 10)
  assert.equal(typeof comp, 'function')
  assert.equal(calls.effects.length, 1)
  assert.equal(opts.when({ kind: 'message', index: 1, turn: 1, payloadBlob: 'x' }), true)
  assert.equal(opts.when({ kind: 'message', index: 1, turn: 1 }), true)
  assert.equal(opts.when({ kind: 'user', index: 1, turn: 1 }), false)
  assert.equal(opts.when({ kind: 'tool', index: 1, turn: 1, payloadBlob: 'x' }), false)
})

test('apply swallows a registration failure inside the effect and keeps the effect', () => {
  const mod = registered.factory(() => ({ createElement: el }))
  let effectCalls = 0
  const ctx = { effect: (fn) => { effectCalls++; return fn() }, slots: { inject: () => { throw new Error('slot not declared') }, register() {} } }
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(effectCalls, 1)
  let deferred
  mod.apply({ effect: (fn) => { deferred = fn }, slots: { inject: () => { throw new Error('late') }, register() {} } })
  assert.doesNotThrow(() => deferred(), 'a failure when the host runs the effect later is swallowed too')
  const noSlots = { effect: (fn) => fn(), slots: undefined }
  assert.doesNotThrow(() => mod.apply(noSlots))
})

test('apply returns the slot disposer from the effect so unload cleans up', () => {
  const mod = registered.factory(() => ({ createElement: el }))
  const dispose = () => {}
  let result
  const ctx = { effect: (fn) => { result = fn() }, slots: { inject: (key, fn) => { fn(); return dispose }, register() {} } }
  mod.apply(ctx)
  assert.equal(result, dispose)
})

test('exports inject the slots service', () => {
  const mod = registered.factory(() => ({ createElement: el }))
  assert.deepEqual([...mod.inject], ['slots'])
})

test('shows Loading... while the read is pending', () => {
  const m = start({ record: record(), readRequestPayload: () => new Promise(() => {}) })
  assert.match(text(m.tree), /Loading\.\.\./)
})

test('renders all sections from a full payload', async () => {
  const m = start({ record: record(), readRequestPayload: ok(payload()) })
  await tick()
  const t = text(m.tree)
  for (const s of ['Command line', 'Environment variable names', 'System prompt', 'Tools', 'Stdin']) assert.ok(t.includes(s), s)
  const section = (title) => walk(m.tree).find((n) => n.props['data-api-call-section'] === title)
  assert.equal(text(section('Command line').children[1]), 'claude\n-p\n--model\nsonnet', 'argv, one per line')
  assert.equal(text(section('Environment variable names').children[1]), 'PATH\nHOME')
  assert.equal(text(section('System prompt').children[1]), 'You are SYSTEM_PROMPT_TEXT')
  assert.equal(text(section('Stdin').children[1]), 'hello STDIN_TEXT')
  assert.ok(t.includes('PATH') && t.includes('HOME'))
  assert.ok(t.includes('You are SYSTEM_PROMPT_TEXT'))
  assert.ok(t.includes('Read') && t.includes('Reads files'))
  assert.ok(!t.includes('"properties"'), 'inputSchema stays unrendered while the tool is closed')
  const details = walk(m.tree).find((n) => n.type === 'details')
  details.props.onToggle({ currentTarget: { open: true } })
  assert.ok(text(m.tree).includes('"properties"'), 'inputSchema JSON once the tool is opened')
  assert.ok(t.includes('hello STDIN_TEXT'))
  assert.ok(!/not captured/.test(t))
})

test('text is rendered as children, never as HTML', async () => {
  const evil = '<img src=x onerror=alert(1)>'
  const m = start({ record: record(), readRequestPayload: ok(payload({ system: evil })) })
  await tick()
  const nodes = walk(m.tree)
  assert.ok(nodes.every((n) => !('dangerouslySetInnerHTML' in n.props)))
  assert.ok(text(m.tree).includes(evil))
})

test('not captured states', async () => {
  const cases = {
    'no blob': { record: record({ payloadBlob: undefined }), readRequestPayload: ok(payload()) },
    'no reader': { record: record() },
    'ok false': { record: record(), readRequestPayload: async () => ({ ok: false }) },
    'undefined value': { record: record(), readRequestPayload: ok(undefined) },
    'rejected': { record: record(), readRequestPayload: async () => { throw new Error('nope') } },
    'sync throw': { record: record(), readRequestPayload: () => { throw new Error('nope') } },
  }
  for (const [name, props] of Object.entries(cases)) {
    const m = start(props)
    await tick()
    assert.match(text(m.tree), /API call not captured for this request/, name)
  }
})

test('no blob does not call the reader', async () => {
  let called = 0
  start({ record: record({ payloadBlob: undefined }), readRequestPayload: async () => { called++; return { ok: true, value: payload() } } })
  await tick()
  assert.equal(called, 0)
})

test('truncated payload shows a note with original sizes', async () => {
  const m = start({ record: record(), readRequestPayload: ok(payload({ truncated: true, stdinBytes: 1234, systemBytes: 5678, toolsBytes: 91011 })) })
  await tick()
  const t = text(m.tree)
  assert.match(t, /truncated/i)
  for (const n of ['1234', '5678', '91011']) assert.ok(t.includes(n), n)
  const m2 = start({ record: record(), readRequestPayload: ok(payload({ truncated: true })) })
  await tick()
  assert.match(text(m2.tree), /truncated/i)
})

test('a stale result is ignored after the blob changes or on unmount', async () => {
  let resolveA
  const reader = (blob) => blob === 'A' ? new Promise((r) => { resolveA = r }) : Promise.resolve({ ok: true, value: payload({ system: 'SYS_B' }) })
  const m = start({ record: record({ payloadBlob: 'A' }), readRequestPayload: reader })
  m.rerender({ record: record({ payloadBlob: 'B' }), readRequestPayload: reader })
  await tick()
  assert.ok(text(m.tree).includes('SYS_B'))
  resolveA({ ok: true, value: payload({ system: 'SYS_A' }) })
  await tick()
  assert.ok(text(m.tree).includes('SYS_B') && !text(m.tree).includes('SYS_A'))

  let resolveC
  const m2 = start({ record: record({ payloadBlob: 'C' }), readRequestPayload: () => new Promise((r) => { resolveC = r }) })
  m2.unmount()
  const before = m2.tree
  resolveC({ ok: true, value: payload() })
  await tick()
  assert.equal(m2.tree, before)
})

test('no blob with a reader shows not captured at once, never Loading...', () => {
  const m = start({ record: record({ payloadBlob: undefined }), readRequestPayload: ok(payload()) })
  assert.doesNotMatch(text(m.tree), /Loading\.\.\./)
  assert.match(text(m.tree), /API call not captured for this request/)
})

test('a reader that appears after the blob is known triggers the read', async () => {
  const m = start({ record: record() })
  await tick()
  assert.match(text(m.tree), /API call not captured for this request/)
  m.rerender({ record: record(), readRequestPayload: ok(payload({ system: 'SYS_LATE' })) })
  await tick()
  assert.ok(text(m.tree).includes('SYS_LATE'))
})

test('tool schemas and the Copy text are built on demand, not on every render', async () => {
  let calls = 0
  const schema = { toJSON() { calls++; return { type: 'object' } } }
  const m = start({ record: record(), readRequestPayload: ok(payload({ tools: [{ name: 'T', description: 'd', inputSchema: schema }] })) })
  await tick()
  assert.equal(calls, 0, 'nothing stringified while rendering with the tool closed')
  const toolsSection = walk(m.tree).find((n) => n.props['data-api-call-section'] === 'Tools (1)')
  const copy = walk(toolsSection).find((n) => n.type === 'button')
  copy.props.onClick()
  assert.ok(calls > 0, 'Copy stringifies the tools on click')
})

test('malformed payload fields never throw', async () => {
  const m = start({ record: record(), readRequestPayload: ok({ argv: 'x', tools: [null, { name: 5 }], envKeys: null }) })
  await tick()
  const t = text(m.tree)
  assert.ok(t.includes('Tools (2)'))
  assert.ok(!/not captured/.test(t))
})

