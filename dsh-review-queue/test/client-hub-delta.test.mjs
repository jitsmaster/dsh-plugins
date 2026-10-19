import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Overlay delta of the hub (docs/hub.md 6.6): the notice banner, the visible flag of the long poll, the new error texts.
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const source = readFileSync(file, 'utf8')
const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })

function load({ visibility, fetchImpl } = {}) {
  let registered
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchImpl ?? (() => new Promise(() => {})),
    ...(visibility === undefined ? {} : { document: { visibilityState: visibility } }),
  }
  vm.runInNewContext(source, sandbox, { filename: file })
  const stubReact = { createElement: el, Fragment: Symbol('Fragment'), useState() {}, useEffect() {}, useRef() {}, useSyncExternalStore() {} }
  const mod = registered.factory(() => stubReact)
  return { mod, T: mod.__test }
}

/** Runs the poll loop until the first request and answers with the URL it asked for. */
async function firstPollUrl(visibility) {
  const urls = []
  const { mod } = load({ visibility, fetchImpl: (url) => { urls.push(String(url)); return new Promise(() => {}) } })
  const cleanups = []
  mod.apply({ uiWorkspace: undefined, effect: (fn) => { const off = fn(); if (typeof off === 'function') cleanups.push(off) }, slots: { inject: () => () => {}, register: () => ({}) } })
  try { for (let i = 0; i < 50 && !urls.length; i++) await new Promise((r) => setTimeout(r, 10)) } finally { cleanups.forEach((f) => f()) }
  return urls[0]
}

const find = (node, pred) => (node && typeof node === 'object' ? (pred(node) ? node : (node.children ?? []).map((c) => find(c, pred)).find(Boolean)) : undefined)
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''))

test('a snapshot notice shows as a one-line warning banner in the panel', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [], notice: { level: 'warn', text: 'Phone sync is off: hub not running (ENOENT). This app shows only its own items.' } }
  const banner = find(T.Panel(), (n) => /rq-notice/.test(n.props?.className ?? ''))
  assert.ok(banner, 'the panel has a notice banner')
  assert.match(banner.props.className, /rq-notice-warn/)
  assert.equal(text(banner), 'Phone sync is off: hub not running (ENOENT). This app shows only its own items.')
})

test('no notice, no banner; a notice without text is ignored; long text is cut to one line', () => {
  const { T } = load()
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [] }
  assert.equal(find(T.Panel(), (n) => /rq-notice/.test(n.props?.className ?? '')), undefined)
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [], notice: { level: 'warn', text: '' } }
  assert.equal(find(T.Panel(), (n) => /rq-notice/.test(n.props?.className ?? '')), undefined)
  T.state.snap = { snapshotId: 'e:1', open: [], resolved: [], notice: { level: 'warn', text: 'x'.repeat(500) } }
  assert.equal(text(find(T.Panel(), (n) => /rq-notice/.test(n.props?.className ?? ''))).length, 200)
})

test('the long poll says visible=1 while the page is visible, and not while it is hidden or unknown', async () => {
  assert.match(await firstPollUrl('visible'), /[?&]visible=1(?:&|$)/)
  assert.doesNotMatch(await firstPollUrl('hidden'), /visible=/)
  assert.doesNotMatch(await firstPollUrl(undefined), /visible=/, 'no document at all (tests, workers)')
})

test('an item whose session is not available in this app has its own words, apart from an app that is not running', () => {
  const { T } = load()
  assert.equal(T.errorText(409, { ok: false, error: 'session-unavailable' }), 'That session is not available in this app, so this cannot be sent.')
  assert.notEqual(T.errorText(409, { ok: false, error: 'session-unavailable' }), T.errorText(409, { ok: false, error: 'owner-offline' }))
})

test('the hub errors have their own words', () => {
  const { T } = load()
  assert.equal(T.errorText(409, { ok: false, error: 'owner-offline' }), 'That app is not running, so this cannot be sent.')
  assert.match(T.errorText(409, { ok: false, error: 'owner-away' }), /^That app is not answering/)
  assert.match(T.errorText(504, { ok: false, error: 'owner-timeout' }), /^That app did not answer in time/)
  assert.equal(T.errorText(504, { ok: false, error: 'unknown-outcome' }), 'Sent, but no confirmation: refresh to check.')
  assert.match(T.errorText(403, { ok: false, error: 'local-only' }), /only .* on the computer/)
})

test('the codes of a follow-up to a session (post and reply) have their own words, not "Could not do that (code)"', () => {
  const { T } = load()
  assert.equal(T.errorText(409, { ok: false, error: 'post-failed' }), 'The message could not be sent to the session.')
  assert.match(T.errorText(409, { ok: false, error: 'not-a-session' }), /not a session/i)
  assert.match(T.errorText(409, { ok: false, error: 'paused' }), /Resume it at the PC first\./)
  assert.match(T.errorText(409, { ok: false, error: 'busy' }), /already on its way|try again/i)
})
