import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The Ctrl+Alt+L hotkey that toggles the task list overlay from anywhere in the page. Kept apart from client.test.mjs.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')

function load({ stored = {} } = {}) {
  let registered
  const store = { ...stored }
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => new Promise(() => {}),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  const mod = registered.factory(() => stubReact)
  return { mod, T: mod.__test, store }
}
const OVERLAY = 'dsh-review-queue.overlay'
const key = (o = {}) => ({ key: 'l', code: 'KeyL', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, isComposing: false, preventDefault() { this.prevented = true }, ...o })

test('hotkeyAction: Ctrl+Alt+L toggles, whatever the case or layout', () => {
  const { T } = load()
  assert.equal(T.hotkeyAction(key()), 'toggle')
  assert.equal(T.hotkeyAction(key({ key: 'L' })), 'toggle', 'caps lock')
  assert.equal(T.hotkeyAction(key({ key: 'ł' })), 'toggle', 'AltGr layouts: the physical key counts')
})

test('hotkeyAction: nothing else toggles', () => {
  const { T } = load()
  assert.equal(T.hotkeyAction(key({ ctrlKey: false })), undefined)
  assert.equal(T.hotkeyAction(key({ altKey: false })), undefined)
  assert.equal(T.hotkeyAction(key({ shiftKey: true })), undefined)
  assert.equal(T.hotkeyAction(key({ metaKey: true })), undefined)
  assert.equal(T.hotkeyAction(key({ key: 'm', code: 'KeyM' })), undefined, 'Ctrl+Alt+M is the TTS stop hotkey')
  assert.equal(T.hotkeyAction(key({ key: 'v', code: 'KeyV' })), undefined, 'Ctrl+Alt+V is the voice hotkey')
  assert.equal(T.hotkeyAction(key({ isComposing: true })), undefined)
  assert.equal(T.hotkeyAction(undefined), undefined)
})

test('installHotkey: toggles the overlay open and closed, remembers it, and swallows the key', () => {
  const { T, store } = load()
  let handler
  const target = { addEventListener: (t, fn) => { assert.equal(t, 'keydown'); handler = fn }, removeEventListener: () => {} }
  T.installHotkey(target)
  const e1 = key(); handler(e1)
  assert.equal(T.state.overlay, true)
  assert.equal(store[OVERLAY], '1')
  assert.equal(e1.prevented, true)
  const e2 = key(); handler(e2)
  assert.equal(T.state.overlay, false)
  assert.equal(store[OVERLAY], '0')
})

test('installHotkey: works while typing in a field, ignores other keys, and the disposer removes the listener', () => {
  const { T } = load()
  let handler; let removed
  const target = { addEventListener: (_t, fn) => { handler = fn }, removeEventListener: (t, fn) => { removed = [t, fn] } }
  const off = T.installHotkey(target)
  handler(key({ target: { tagName: 'TEXTAREA' } }))
  assert.equal(T.state.overlay, true, 'a modifier chord cannot be typing')
  const other = key({ key: 'j', code: 'KeyJ' }); handler(other)
  assert.equal(T.state.overlay, true)
  assert.equal(other.prevented, undefined)
  off()
  assert.deepEqual(removed, ['keydown', handler])
})
