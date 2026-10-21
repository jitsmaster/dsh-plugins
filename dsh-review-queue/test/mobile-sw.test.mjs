import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../lib/mobile/sw.js', import.meta.url)), 'utf8')
const SCOPE = 'https://pc.tail1234.ts.net/review-queue/m/'

/** Runs sw.js against a stub ServiceWorkerGlobalScope and gives back its event listeners and the recorded calls. */
function boot({ windows = [] } = {}) {
  const listeners = {}
  const log = { shown: [], opened: [], skipped: 0, claimed: 0 }
  const self = {
    registration: { scope: SCOPE, showNotification: async (title, options) => { log.shown.push({ title, options }) } },
    clients: { matchAll: async () => windows, openWindow: async (url) => { log.opened.push(url) }, claim: async () => { log.claimed++ } },
    skipWaiting: async () => { log.skipped++ },
    addEventListener: (type, fn) => { listeners[type] = fn },
  }
  const context = { self, URL, JSON, Promise, Object, String, Array }
  vm.createContext(context)
  vm.runInContext(source, context)
  return { listeners, log }
}

/** Fires an event and waits for what it handed to waitUntil. */
async function fire(listeners, type, event) {
  const waits = []
  listeners[type]({ ...event, waitUntil: (p) => { waits.push(p) } })
  await Promise.all(waits)
  return waits.length
}
const pushEvent = (data) => ({ data: data === undefined ? null : { json: () => (typeof data === 'string' ? JSON.parse(data) : data) } })

test('install and activate take control at once, and there is no fetch handler (API calls are never cached)', async () => {
  const { listeners, log } = boot()
  await fire(listeners, 'install', {})
  await fire(listeners, 'activate', {})
  assert.equal(log.skipped, 1)
  assert.equal(log.claimed, 1)
  assert.deepEqual(Object.keys(listeners).sort(), ['activate', 'install', 'notificationclick', 'push'])
})

test('a push shows a notification with the server text, replaced by tag, and the deep link as data', async () => {
  const { listeners, log } = boot()
  const waited = await fire(listeners, 'push', pushEvent({ title: 'Permission waiting - 3 items', body: 'Tap to review', tag: 'permission', url: '#/item/abc' }))
  assert.equal(waited, 1)
  assert.equal(log.shown.length, 1)
  const { title, options } = log.shown[0]
  assert.equal(title, 'Permission waiting - 3 items')
  assert.equal(options.body, 'Tap to review')
  assert.equal(options.tag, 'permission')
  assert.equal(options.renotify, true)
  assert.equal(options.data.url, SCOPE + '#/item/abc')
  assert.match(options.icon, /icon-192\.png$/)
})

test('a push with no usable data still shows something (Android requires it) and opens the list', async () => {
  for (const ev of [pushEvent(undefined), pushEvent('not json{')]) {
    const { listeners, log } = boot()
    await fire(listeners, 'push', ev)
    assert.equal(log.shown.length, 1)
    assert.equal(log.shown[0].title, 'Coding Boss Review Queue')
    assert.equal(log.shown[0].options.tag, 'task-list')
    assert.equal(log.shown[0].options.data.url, SCOPE)
  }
})

test('a deep link that leaves the app origin falls back to the app', async () => {
  for (const url of ['https://evil.test/x', '//evil.test/x', 'javascript:alert(1)']) {
    const { listeners, log } = boot()
    await fire(listeners, 'push', pushEvent({ title: 't', url }))
    assert.equal(log.shown[0].options.data.url, SCOPE, url)
  }
})

test('tapping the notification closes it and focuses an open task list window, telling it where to go', async () => {
  const calls = []
  const win = { url: SCOPE + '#/', focus: async () => { calls.push('focus') }, postMessage: (m) => { calls.push(m) } }
  const other = { url: 'https://pc.tail1234.ts.net/other/', focus: async () => { calls.push('other-focus') }, postMessage() {} }
  const { listeners, log } = boot({ windows: [other, win] })
  let closed = 0
  await fire(listeners, 'notificationclick', { notification: { close: () => { closed++ }, data: { url: SCOPE + '#/item/abc' } } })
  assert.equal(closed, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), ['focus', { type: 'open', hash: '#/item/abc' }]) // JSON: the message was made inside the vm realm
  assert.deepEqual(log.opened, [])
})

test('tapping the notification opens the item when no window is open', async () => {
  const { listeners, log } = boot({ windows: [] })
  await fire(listeners, 'notificationclick', { notification: { close() {}, data: { url: SCOPE + '#/item/xyz' } } })
  assert.deepEqual(log.opened, [SCOPE + '#/item/xyz'])
})

test('a notification without data opens the app root', async () => {
  const { listeners, log } = boot()
  await fire(listeners, 'notificationclick', { notification: { close() {}, data: undefined } })
  assert.deepEqual(log.opened, [SCOPE])
})
