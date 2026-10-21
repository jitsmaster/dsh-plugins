import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Voice show/hide of the overlay (snapshot.ui) and the "Task list" labels. Kept apart from client.test.mjs.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')

/** A fresh client module; fetchImpl answers the snapshot polls (the default never answers). */
function load({ stored = {}, fetchImpl } = {}) {
  let registered
  const store = { ...stored }
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v } } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchImpl ?? (() => new Promise(() => {})),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: () => null, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  const mod = registered.factory(() => stubReact)
  return { mod, T: mod.__test, store }
}
const OVERLAY = 'dsh-review-queue.overlay'

test('uiStep: the first snapshot only records the sequence, later newer ones act once', () => {
  const { T } = load()
  assert.deepEqual({ ...T.uiStep(undefined, { seq: 4, cmd: 'show' }) }, { seen: 4, action: undefined })
  assert.deepEqual({ ...T.uiStep(undefined, undefined) }, { seen: 0, action: undefined }, 'a server without ui: later commands still count')
  assert.deepEqual({ ...T.uiStep(4, { seq: 5, cmd: 'show' }) }, { seen: 5, action: 'show' })
  assert.deepEqual({ ...T.uiStep(5, { seq: 6, cmd: 'hide' }) }, { seen: 6, action: 'hide' })
  assert.deepEqual({ ...T.uiStep(6, { seq: 6, cmd: 'hide' }) }, { seen: 6, action: undefined }, 'same seq: never twice')
  assert.deepEqual({ ...T.uiStep(6, { seq: 5, cmd: 'show' }) }, { seen: 5, action: undefined }, 'the server restarted: resync without acting')
  assert.deepEqual({ ...T.uiStep(6, { seq: 7 }) }, { seen: 7, action: undefined }, 'no command: nothing to do')
  assert.deepEqual({ ...T.uiStep(6, { seq: 7, cmd: 'explode' }) }, { seen: 7, action: undefined })
  assert.deepEqual({ ...T.uiStep(6, undefined) }, { seen: 6, action: undefined })
  assert.deepEqual({ ...T.uiStep(6, { seq: 'x', cmd: 'show' }) }, { seen: 6, action: undefined })
})

test('sinceOf builds the long-poll token with snapshot id, focus, reading and the ui sequence', () => {
  const { T } = load()
  assert.equal(T.sinceOf({ snapshotId: 'e:3', focusId: 'f', reading: 'r', ui: { seq: 9, cmd: 'show' } }), 'e:3|f|r|9||')
  assert.equal(T.sinceOf({ snapshotId: 'e:3' }), 'e:3|||0||')
})

test('applyUi: the first snapshot does not act, a newer show opens the overlay and persists, hide closes it', () => {
  const { T, store } = load()
  T.applyUi({ seq: 3, cmd: 'show' })
  assert.equal(T.uiPeek().overlay, false, 'a tab that just loaded keeps its own saved state')
  assert.equal(store[OVERLAY], undefined)
  T.applyUi({ seq: 4, cmd: 'show' })
  assert.equal(T.uiPeek().overlay, true)
  assert.equal(store[OVERLAY], '1')
  T.applyUi({ seq: 5, cmd: 'hide' })
  assert.equal(T.uiPeek().overlay, false)
  assert.equal(store[OVERLAY], '0')
})

test('applyUi never acts twice for the same seq (reconnects, refetches)', () => {
  const { T, store } = load({ stored: { [OVERLAY]: '1' } })
  T.applyUi({ seq: 1, cmd: 'hide' }) // first: recorded only
  assert.equal(T.uiPeek().overlay, true)
  T.applyUi({ seq: 2, cmd: 'hide' })
  assert.equal(T.uiPeek().overlay, false)
  store[OVERLAY] = '1'
  T.setOverlay(true) // the user opens it again by hand
  T.applyUi({ seq: 2, cmd: 'hide' })
  T.applyUi({ seq: 2, cmd: 'hide' })
  assert.equal(T.uiPeek().overlay, true, 'the old hide is not applied again')
})

test('applyUi goes through setOverlay, so closing by voice stops reading like the header button does', () => {
  const calls = []
  const { T } = load({ fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({}) } } })
  T.applyUi({ seq: 1 })
  T.setOverlay(true)
  T.state.snap = { reading: 'x', open: [], resolved: [] }
  T.applyUi({ seq: 2, cmd: 'hide' })
  assert.ok(calls.some((u) => String(u).endsWith('/v1/stop')))
})

test('end to end: the poll loop sends the ui sequence back and applies a command that arrives later', async () => {
  const urls = []
  let n = 0
  const snap = (seq, cmd) => ({ snapshotId: 'e:' + seq, open: [{ id: 'a', type: 'completed', position: 1 }], resolved: [], ui: { seq, cmd } })
  const answers = [snap(7, 'hide'), snap(8, 'show')]
  const fetchImpl = (url) => {
    urls.push(String(url))
    const body = answers[n++]
    return body ? Promise.resolve({ ok: true, json: async () => body }) : new Promise(() => {})
  }
  const { mod, T } = load({ fetchImpl })
  const cleanups = []
  mod.apply({
    uiWorkspace: undefined,
    effect: (fn) => { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
    slots: { inject: () => () => {}, register: () => ({}) },
  })
  try {
    for (let i = 0; i < 50 && n < 3; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(n, 3)
    assert.ok(!urls[0].includes('since='))
    assert.ok(urls[1].includes(encodeURIComponent('e:7||' + '|7')), urls[1])
    assert.ok(urls[2].includes(encodeURIComponent('e:8|||8')), urls[2])
    assert.equal(T.uiPeek().overlay, true, 'the second snapshot carried a newer show')
  } finally { cleanups.forEach((f) => f()) }
})

test('user-visible labels say "Task list", identifiers keep the plugin name', () => {
  assert.match(source, /h\("h2", null, "Task list"\)/)
  assert.match(source, /"aria-label": "Task list"/)
  assert.match(source, /title: st\.overlay \? "Close the task list" : "Open the task list \("/)
  assert.match(source, /label: \(\) => "Task list"/)
  assert.match(source, /"Task list unreachable \("/)
  const strings = [...source.matchAll(/"([^"\n]*)"/g)].map((m) => m[1])
  const visible = strings.filter((s) => /\b(review queue|review)\b/i.test(s) && !/^(reviewed|review-queue|dsh-review-queue|\/review-queue|dsh-review-queue\..*|review-queue: .*)$/.test(s) && !/Is dsh-review-queue loaded/.test(s))
  assert.deepEqual(visible, [], 'no user-visible "Review queue"/"Review" label is left')
  assert.match(source, /const ANCHOR_ID = "review-queue"/)
  assert.match(source, /const API = "\/review-queue"/)
  assert.match(source, /"dsh-review-queue\.overlay"/)
})
