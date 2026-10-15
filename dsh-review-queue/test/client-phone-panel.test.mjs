import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPhoneController, createPhonePanel, deviceRows } from '../lib/phone-panel.js'
import * as phone from '../lib/phone-panel.js'

// The desktop "Phone" panel (lib/phone-panel.js, loaded by the overlay on first use): pair a phone, list phones, rename, revoke.
const API = '/review-queue'
const el = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
const stubReact = { createElement: el, useState: (i) => [i, () => {}], useEffect() {}, useSyncExternalStore: (_sub, get) => get() }
const find = (node, pred) => (node && typeof node === 'object' ? (pred(node) ? node : (node.children ?? []).map((c) => find(c, pred)).find(Boolean)) : undefined)
const findAll = (node, pred) => (node && typeof node === 'object' ? [...(pred(node) ? [node] : []), ...(node.children ?? []).flatMap((c) => findAll(c, pred))] : [])
const text = (node) => (typeof node === 'string' ? node : typeof node === 'number' ? String(node) : (node?.children ?? []).map(text).join(''))
const fmtAge = (ms) => Math.round(ms / 60000) + ' min ago'

const NOW = 1_000_000_000
const DEVICE = { id: 'dv_000000000001', name: 'Pixel 9', createdAt: NOW - 3600_000, lastSeenAt: NOW - 120_000, lastLogin: 'me@example.com', revokedAt: null, push: { state: 'on', types: {}, quiet: {}, lastSuccessAt: NOW - 60_000, lastError: null } }
const REVOKED = { ...DEVICE, id: 'dv_000000000002', name: 'Old', revokedAt: NOW - 1000, push: { state: 'off' } }

/** A fetch that records calls and answers from a table of "METHOD path" -> [status, json]. */
function fakeFetch(answers) {
  const calls = []
  const fn = async (url, init = {}) => {
    const key = (init.method ?? 'GET') + ' ' + url
    calls.push({ key, init, body: init.body ? JSON.parse(init.body) : undefined })
    const [status, json] = answers[key] ?? [200, { ok: true }]
    return { ok: status < 400, status, json: async () => json }
  }
  return { fn, calls }
}
const make = (answers = {}) => { const f = fakeFetch(answers); const c = createPhoneController({ API, fetch: f.fn, now: () => NOW }); return { c, calls: f.calls } }

test('refresh loads the devices, the legacy phones, the warnings and the public URL', async () => {
  const { c, calls } = make({ 'GET /review-queue/v1/devices': [200, { ok: true, devices: [DEVICE, REVOKED], legacy: [{ id: 'old1', name: 'Old phone' }], warnings: ['permissions could not be tightened'], publicUrl: 'https://x.ts.net' }] })
  await c.refresh()
  assert.deepEqual(calls.map((x) => x.key), ['GET /review-queue/v1/devices'])
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.equal(c.state.devices.length, 2)
  assert.equal(c.state.legacy[0].id, 'old1')
  assert.deepEqual(c.state.warnings, ['permissions could not be tightened'])
  assert.equal(c.state.error, null)
})

test('newCode asks the hub for a pairing code and keeps it for display', async () => {
  const { c, calls } = make({ 'POST /review-queue/v1/pairing-code': [200, { ok: true, code: 'ABCD-EFGH', expiresAt: NOW + 300_000, url: 'https://x.ts.net/review-queue/m/#/pair', link: 'https://x.ts.net/review-queue/m/#/pair/ABCD-EFGH' }] })
  await c.newCode()
  assert.deepEqual(calls[0].body, {})
  assert.match(calls[0].init.headers['content-type'], /application\/json/)
  assert.equal(c.state.code.code, 'ABCD-EFGH')
  assert.equal(c.state.code.link, 'https://x.ts.net/review-queue/m/#/pair/ABCD-EFGH')
})

test('revoke and rename call the hub and then reload the list', async () => {
  const { c, calls } = make({ 'GET /review-queue/v1/devices': [200, { ok: true, devices: [DEVICE], legacy: [], warnings: [] }] })
  await c.revoke(DEVICE.id)
  await c.rename(DEVICE.id, 'Tablet')
  assert.deepEqual(calls.map((x) => x.key), [
    'POST /review-queue/v1/devices/dv_000000000001/revoke', 'GET /review-queue/v1/devices',
    'PATCH /review-queue/v1/devices/dv_000000000001', 'GET /review-queue/v1/devices',
  ])
  assert.deepEqual(calls[2].body, { name: 'Tablet' })
})

test('a hub that is not running is explained, not shown as a raw code', async () => {
  const { c } = make({ 'GET /review-queue/v1/devices': [503, { error: 'hub-unavailable' }], 'POST /review-queue/v1/pairing-code': [503, { error: 'hub-unavailable' }] })
  await c.refresh()
  assert.match(c.state.error, /hub is not running/i)
  await c.newCode()
  assert.match(c.state.error, /hub is not running/i)
  assert.equal(c.state.code, null)
})

test('other failures say the code or status, and a thrown fetch says the request failed', async () => {
  const { c } = make({ 'POST /review-queue/v1/devices/dv_x/revoke': [404, { error: 'unknown-device' }] })
  await c.revoke('dv_x')
  assert.match(c.state.error, /unknown-device/)
  const bad = createPhoneController({ API, fetch: async () => { throw new Error('offline') }, now: () => NOW })
  await bad.refresh()
  assert.match(bad.state.error, /offline/)
})

test('subscribers are told about every change, and unsubscribing stops it', async () => {
  const { c } = make()
  let n = 0
  const off = c.subscribe(() => n++)
  await c.refresh()
  assert.ok(n >= 2, 'busy on and off')
  const seen = n
  off()
  await c.refresh()
  assert.equal(n, seen)
})

test('deviceRows: name, when it was paired, when it was last seen, the login, push on or off, and whether it can still be revoked', () => {
  const rows = deviceRows({ devices: [DEVICE, REVOKED, { ...DEVICE, id: 'dv_3', lastSeenAt: 0, lastLogin: null, push: { state: 'on', lastError: 'status 500' } }], legacy: [{ id: 'old1', name: 'Old phone', createdAt: NOW - 86400_000, lastSuccessAt: null }] }, NOW, fmtAge)
  assert.deepEqual(rows[0], { id: DEVICE.id, name: 'Pixel 9', created: '60 min ago', lastSeen: '2 min ago', lastLogin: 'me@example.com', push: 'on', revoked: false, legacy: false })
  assert.equal(rows[1].revoked, true)
  assert.equal(rows[1].push, 'off')
  assert.equal(rows[2].lastSeen, 'never')
  assert.equal(rows[2].lastLogin, '')
  assert.equal(rows[2].push, 'on (last send failed)')
  assert.deepEqual([rows[3].id, rows[3].legacy, rows[3].push, rows[3].lastSeen], ['old1', true, 'on', 'never'])
})

test('the panel offers Pair a phone; with a code it shows the code, the address and says the code is single use and expires', async () => {
  const { c } = make({ 'POST /review-queue/v1/pairing-code': [200, { ok: true, code: 'ABCD-EFGH', expiresAt: NOW + 300_000, url: 'https://x.ts.net/review-queue/m/#/pair', link: 'https://x.ts.net/review-queue/m/#/pair/ABCD-EFGH' }] })
  const Panel = createPhonePanel(stubReact, { API, fmtAge, controller: c })
  const before = Panel()
  assert.ok(find(before, (n) => n.type === 'button' && /Pair a phone/.test(text(n))))
  await c.newCode()
  const tree = Panel()
  const all = text(tree)
  assert.match(all, /ABCD-EFGH/)
  assert.match(all, /https:\/\/x\.ts\.net\/review-queue\/m\/#\/pair/)
  assert.match(all, /once/i)
  assert.match(all, /5 min|minutes/i)
  assert.ok(find(tree, (n) => n.type === 'input' && n.props.readOnly && n.props.value === 'https://x.ts.net/review-queue/m/#/pair/ABCD-EFGH'), 'the link is in a read-only box to copy')
})

test('without a public address the panel says to set publicUrl in hub.config.json', async () => {
  const { c } = make({ 'POST /review-queue/v1/pairing-code': [200, { ok: true, code: 'ABCD-EFGH', expiresAt: NOW + 300_000, url: null, link: null }] })
  const Panel = createPhonePanel(stubReact, { API, fmtAge, controller: c })
  await c.newCode()
  assert.match(text(Panel()), /publicUrl/)
})

test('the table lists every phone with a Revoke button for the active ones only, and shows the permission warning', async () => {
  const { c } = make({ 'GET /review-queue/v1/devices': [200, { ok: true, devices: [DEVICE, REVOKED], legacy: [{ id: 'old1', name: 'Old phone', createdAt: NOW }], warnings: ['permissions could not be tightened'] }] })
  const Panel = createPhonePanel(stubReact, { API, fmtAge, controller: c })
  await c.refresh()
  const tree = Panel()
  assert.equal(findAll(tree, (n) => n.type === 'tr').length, 1 + 3, 'header and three phones')
  const revokes = findAll(tree, (n) => n.type === 'button' && /^Revoke/.test(text(n)))
  assert.equal(revokes.length, 2, 'the paired one and the legacy one, not the revoked one')
  assert.match(text(tree), /permissions could not be tightened/)
  assert.match(text(tree), /Pixel 9/)
  assert.match(text(tree), /me@example\.com/)
  assert.match(text(tree), /revoked/i)
})

test('Revoke asks first: the first click arms it, the second one revokes', async () => {
  const { c, calls } = make({ 'GET /review-queue/v1/devices': [200, { ok: true, devices: [DEVICE], legacy: [], warnings: [] }] })
  const states = []
  const react = { ...stubReact, useState: (i) => { const cell = [i, (v) => { cell[0] = v; states.push(v) }]; return cell } }
  const Panel = createPhonePanel(react, { API, fmtAge, controller: c })
  await c.refresh()
  const tree = Panel()
  const button = find(tree, (n) => n.type === 'button' && /^Revoke/.test(text(n)))
  button.props.onClick()
  assert.equal(calls.filter((x) => /revoke/.test(x.key)).length, 0, 'the first click only arms')
  assert.deepEqual(states.at(-1), DEVICE.id)
})

// --- The open panel keeps itself current: a periodic quiet refresh, a Refresh button, and the pairing code going away once it was used.

const NEW_DEVICE = { ...DEVICE, id: 'dv_000000000003', name: 'Galaxy S25' }
const LIST = (...devices) => [200, { ok: true, devices, legacy: [], warnings: [] }]
const CODE = [200, { ok: true, code: 'ABCD-EFGH', expiresAt: NOW + 300_000, url: 'https://x.ts.net/review-queue/m/#/pair', link: 'https://x.ts.net/review-queue/m/#/pair/ABCD-EFGH' }]
const DEVICES = 'GET /review-queue/v1/devices'
const PAIRING = 'POST /review-queue/v1/pairing-code'
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

/** React whose useEffect runs its callback once per mount (an empty dependency list) and records the cleanups, like a real mount and unmount. */
function mountableReact() {
  const cleanups = []
  let mounted = false
  const useEffect = (fn, deps) => { if (Array.isArray(deps) && deps.length === 0 && mounted) return; mounted = true; const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) }
  return { react: { ...stubReact, useEffect }, unmount: () => cleanups.splice(0).forEach((c) => c()) }
}

test('the refresh interval is an exported constant of 3 seconds', () => {
  assert.equal(phone.PHONE_REFRESH_MS, 3000)
})

test('a mounted panel loads the phones at once and then every 3 seconds until it is unmounted', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { c, calls } = make({ [DEVICES]: LIST(DEVICE) })
  const { react, unmount } = mountableReact()
  const Panel = createPhonePanel(react, { API, fmtAge, controller: c })
  Panel()
  await flush()
  assert.equal(calls.length, 1, 'the first load on mount')
  t.mock.timers.tick(3000); await flush()
  t.mock.timers.tick(3000); await flush()
  assert.deepEqual(calls.map((x) => x.key), [DEVICES, DEVICES, DEVICES])
  unmount()
  t.mock.timers.tick(9000); await flush()
  assert.equal(calls.length, 3, 'the cleanup stopped the interval')
})

test('a tick is skipped while a request is still in flight', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const calls = []
  const slow = async (url) => { calls.push(url); await gate; return { ok: true, status: 200, json: async () => ({ ok: true, devices: [DEVICE], legacy: [], warnings: [] }) } }
  const c = createPhoneController({ API, fetch: slow, now: () => NOW })
  const { react, unmount } = mountableReact()
  createPhonePanel(react, { API, fmtAge, controller: c })()
  await flush()
  assert.equal(c.state.busy, true)
  t.mock.timers.tick(3000); await flush()
  assert.equal(calls.length, 1, 'no second request on top of the busy one')
  release(); await flush()
  t.mock.timers.tick(3000); await flush()
  assert.equal(calls.length, 2, 'the next tick after it finished refreshes again')
  unmount()
})

test('a quiet refresh never turns busy on and keeps an existing error when it succeeds', async () => {
  const { c } = make({ [DEVICES]: LIST(DEVICE), [PAIRING]: [503, { error: 'hub-unavailable' }] })
  await c.newCode()
  const before = c.state.error
  assert.ok(before)
  const busySeen = []
  c.subscribe(() => busySeen.push(c.state.busy))
  await c.refresh({ quiet: true })
  assert.equal(c.state.devices.length, 1, 'the list was still loaded')
  assert.equal(c.state.error, before, 'the error is left for the user to read')
  assert.ok(busySeen.length >= 1)
  assert.ok(busySeen.every((b) => b === false), 'busy never flipped: ' + busySeen)
})

test('a failed quiet refresh keeps the previous list and only sets an error when there was none', async () => {
  const answers = { [DEVICES]: LIST(DEVICE), [PAIRING]: [404, { error: 'something-else' }] }
  const { c } = make(answers)
  await c.refresh()
  answers[DEVICES] = [503, { error: 'hub-unavailable' }]
  await c.refresh({ quiet: true })
  assert.equal(c.state.devices.length, 1, 'the previous list stays')
  assert.match(c.state.error, /hub is not running/i, 'no error before, so this one is shown')
  assert.equal(c.state.busy, false)
  await c.newCode()
  const own = c.state.error
  assert.match(own, /something-else/)
  await c.refresh({ quiet: true })
  assert.equal(c.state.error, own, 'an existing error is not replaced')
})

test('the panel has a Refresh button next to Pair a phone that reloads the list', async () => {
  const { c, calls } = make({ [DEVICES]: LIST(DEVICE) })
  const seen = []
  const real = c.refresh
  c.refresh = (...args) => { seen.push(args); return real(...args) }
  const Panel = createPhonePanel(stubReact, { API, fmtAge, controller: c })
  const tree = Panel()
  const row = find(tree, (n) => n.props.className === 'rq-row')
  const button = find(row, (n) => n.type === 'button' && /^Refresh$/.test(text(n)))
  assert.ok(button, 'in the same row as Pair a phone')
  assert.ok(find(row, (n) => n.type === 'button' && /Pair a phone/.test(text(n))))
  button.props.onClick({ type: 'click' })
  await flush()
  assert.deepEqual(seen, [[]], 'a plain, non-quiet refresh without the click event as its options')
  assert.deepEqual(calls.map((x) => x.key), [DEVICES])
})

test('a new phone appearing while the pairing code shows clears the code and says who paired', async () => {
  const answers = { [DEVICES]: LIST(DEVICE), [PAIRING]: CODE }
  const { c } = make(answers)
  const Panel = createPhonePanel(stubReact, { API, fmtAge, controller: c })
  await c.refresh()
  await c.newCode()
  assert.ok(c.state.code)
  answers[DEVICES] = LIST(DEVICE, NEW_DEVICE)
  await c.refresh({ quiet: true })
  assert.equal(c.state.code, null)
  assert.equal(c.state.justPaired, 'Galaxy S25')
  const tree = Panel()
  const line = find(tree, (n) => n.props.className === 'rq-sub' && /^Paired: Galaxy S25$/.test(text(n)))
  assert.ok(line, 'a plain Paired line')
  assert.doesNotMatch(text(tree), /ABCD-EFGH/)
  assert.equal(find(tree, (n) => n.type === 'input'), undefined, 'the code box is gone')
})

test('the first load while a code is showing does not clear the code', async () => {
  const { c } = make({ [DEVICES]: LIST(DEVICE), [PAIRING]: CODE })
  await c.newCode()
  assert.equal(c.state.loaded, false)
  await c.refresh()
  assert.equal(c.state.loaded, true)
  assert.equal(c.state.code.code, 'ABCD-EFGH')
  assert.equal(c.state.justPaired, null)
})

test('a new phone without a code showing, or an unchanged list with one, changes nothing', async () => {
  const answers = { [DEVICES]: LIST(DEVICE), [PAIRING]: CODE }
  const { c } = make(answers)
  await c.refresh()
  answers[DEVICES] = LIST(DEVICE, NEW_DEVICE)
  await c.refresh({ quiet: true })
  assert.equal(c.state.justPaired, null, 'no code was showing')
  await c.newCode()
  await c.refresh({ quiet: true })
  assert.equal(c.state.code.code, 'ABCD-EFGH', 'no new phone, the code stays')
  assert.equal(c.state.justPaired, null)
})

test('pressing Pair a phone again resets the Paired line, even before the new code arrives', async () => {
  const answers = { [DEVICES]: LIST(DEVICE), [PAIRING]: CODE }
  const { c } = make(answers)
  await c.refresh()
  await c.newCode()
  answers[DEVICES] = LIST(DEVICE, NEW_DEVICE)
  await c.refresh({ quiet: true })
  assert.equal(c.state.justPaired, 'Galaxy S25')
  answers[PAIRING] = [503, { error: 'hub-unavailable' }]
  await c.newCode()
  assert.equal(c.state.justPaired, null)
})

test('revoke and rename from the mounted panel still work next to the periodic refresh', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { c, calls } = make({ [DEVICES]: LIST(DEVICE) })
  const { react: base, unmount } = mountableReact()
  const Panel = createPhonePanel(base, { API, fmtAge, controller: c })
  Panel()
  await flush()
  const revokeButton = (React) => find(createPhonePanel(React, { API, fmtAge, controller: c })(), (n) => n.type === 'button' && /^Revoke/.test(text(n)))
  const armed = []
  revokeButton({ ...stubReact, useState: (i) => [i, (v) => armed.push(v)] }).props.onClick()
  assert.equal(calls.filter((x) => /revoke/.test(x.key)).length, 0, 'the first click only arms')
  assert.deepEqual(armed, [DEVICE.id])
  revokeButton({ ...stubReact, useState: () => [DEVICE.id, () => {}] }).props.onClick()
  await flush()
  assert.deepEqual(calls.map((x) => x.key).slice(-2), ['POST /review-queue/v1/devices/dv_000000000001/revoke', DEVICES])
  const win = globalThis.window
  globalThis.window = { prompt: () => '  Tablet ' }
  try {
    find(Panel(), (n) => n.type === 'button' && /^Rename$/.test(text(n))).props.onClick()
    await flush()
  } finally { if (win === undefined) delete globalThis.window; else globalThis.window = win }
  assert.deepEqual(calls.map((x) => x.key).slice(-2), ['PATCH /review-queue/v1/devices/dv_000000000001', DEVICES])
  assert.deepEqual(calls.at(-2).body, { name: 'Tablet' })
  unmount()
})
