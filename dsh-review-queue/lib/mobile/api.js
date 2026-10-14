/**
 * Phone page state: the snapshot (long-poll, same API as the desktop overlay), unsent drafts, and the actions. A tiny observable
 * store: views subscribe through useStore (views.js).
 */
import { loadCore } from './core.js'
import { normalizeSettings } from './push-client.js'

/** The plugin prefix on this host ("/review-queue", or behind a public URL prefix). */
export const API = location.pathname.replace(/\/m\/.*$/, '')
const WAIT_MS = 20000
const LS_SAVED = 'rq-m.saved'
const LS_FILTER = 'rq-m.filter'
const LS_PUSH = 'rq-m.push'
const LS_DEVICE = 'rq-m.device'

let core
export const getCore = () => core

const storage = {
  get(k) { try { return localStorage.getItem(k) } catch { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}

export const state = {
  ready: false, snap: null, error: null, auth: false, skew: 0,
  drafts: {}, replies: {}, busy: {}, errors: {}, filter: { type: 'all', query: '' }, version: 0,
}
const listeners = new Set()
export const subscribe = (l) => { listeners.add(l); return () => { listeners.delete(l) } }
let saveTimer
export function set(patch) {
  Object.assign(state, patch)
  state.version++
  if ('drafts' in patch || 'replies' in patch) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300) }
  if ('filter' in patch) storage.set(LS_FILTER, JSON.stringify(state.filter))
  for (const l of [...listeners]) l()
}
function save() {
  const keep = core.pruneSaved({ drafts: state.drafts, replies: state.replies }, { open: Object.keys({ ...state.drafts, ...state.replies }).map((id) => ({ id })), resolved: [] })
  storage.set(LS_SAVED, JSON.stringify(keep))
}
function load() {
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  try { const j = JSON.parse(storage.get(LS_SAVED) || 'null'); state.drafts = obj(j && j.drafts); state.replies = obj(j && j.replies) } catch { /* none */ }
  try { const f = JSON.parse(storage.get(LS_FILTER) || 'null'); if (f && typeof f.type === 'string') state.filter = { type: f.type, query: typeof f.query === 'string' ? f.query : '' } } catch { /* none */ }
}

let current
let stopped = false
let polling = false
async function pollLoop() {
  if (polling) return
  polling = true
  let since
  let fails = 0
  while (!stopped) {
    const ac = new AbortController()
    current = ac
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; ac.abort() }, WAIT_MS + 15000)
    try {
      const url = API + '/v1/snapshot?wait=' + WAIT_MS + '&client=phone' + (since ? '&since=' + encodeURIComponent(since) : '')
      const res = await fetch(url, { credentials: 'same-origin', signal: ac.signal })
      if (res.status === 401 || res.status === 403) { set({ auth: true, error: 'Not signed in (HTTP ' + res.status + '). Sign in to DSH in this browser, then reload.' }); await new Promise((r) => setTimeout(r, 5000)); continue }
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = await res.json()
      fails = 0
      if (body.unchanged) { if (state.error || state.auth) set({ error: null, auth: false }); continue }
      since = core.sinceOf(body)
      const kept = core.pruneSaved({ drafts: state.drafts, replies: state.replies }, body)
      const gone = Object.keys(state.drafts).some((k) => !(k in kept.drafts)) || Object.keys(state.replies).some((k) => !(k in kept.replies))
      set({ snap: body, error: null, auth: false, ready: true, skew: (body.serverNow || Date.now()) - Date.now(), ...(gone ? kept : {}) })
    } catch (e) {
      if (e && e.name === 'AbortError' && !timedOut) continue // the page woke up or came back online: ask again at once
      fails++
      if (!stopped) set({ error: 'Task list unreachable (' + String((e && e.message) || e) + '). Retrying…' })
      await new Promise((r) => setTimeout(r, Math.min(10000, 1000 * fails)))
    } finally { clearTimeout(timeout) }
  }
  polling = false
}

/** Posts an action; true on success, else the card shows the error text. */
export async function act(path, body, id) {
  set({ busy: { ...state.busy, [id]: true }, errors: { ...state.errors, [id]: undefined } })
  let error
  try {
    const res = await fetch(API + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) { const j = await res.json().catch(() => ({})); error = core.errorText(res.status, j) }
  } catch (e) { error = 'Request failed: ' + String((e && e.message) || e) }
  set({ busy: { ...state.busy, [id]: false }, errors: { ...state.errors, [id]: error } })
  return !error
}

export async function init() {
  core = await loadCore()
  load()
  set({ ready: false })
  document.addEventListener('visibilitychange', () => { if (!document.hidden && current) current.abort() }) // a phone that slept has a dead connection
  window.addEventListener('online', () => { if (current) current.abort() })
  pollLoop()
}

// ---- web push (routes of the push slice: docs/mobile.md "Server") ------------------------------------------------------

async function pushRequest(method, path, body) {
  const init = { method, credentials: 'same-origin' }
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body) }
  const res = await fetch(API + '/v1/push' + path, init)
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(((json && json.error) || 'request failed') + ' (HTTP ' + res.status + ')')
  return json || {}
}

/** The server's VAPID public key, base64url. */
export async function pushKey() {
  const { key } = await pushRequest('GET', '/key')
  if (typeof key !== 'string' || !key) throw new Error('The server sent no push key.')
  return key
}
/** Registers (or updates) this phone's push subscription; payload from buildSubscribePayload. Answers { device }. */
export const pushSubscribe = (payload) => pushRequest('POST', '/subscribe', payload)
/** Forgets a device: { endpoint } for this phone, { id } for one from the device list. */
export const pushUnsubscribe = (target) => pushRequest('POST', '/unsubscribe', target)
/** Sends a test notification to the device with this endpoint. */
export const pushTest = (endpoint) => pushRequest('POST', '/test', { endpoint })
/** Saves the device name, the per-type switches and the quiet hours of the device with this endpoint. */
export const pushSettings = (settings) => pushRequest('POST', '/settings', settings)
export async function pushDevices() {
  const { devices } = await pushRequest('GET', '/devices')
  return Array.isArray(devices) ? devices : []
}

/** This phone's push settings (kept locally; the server holds the copy it needs to decide what to send). */
export function getPushPrefs(tz) {
  let raw
  try { raw = JSON.parse(storage.get(LS_PUSH) || 'null') } catch { raw = null }
  return normalizeSettings(raw, tz)
}
export const setPushPrefs = (prefs) => storage.set(LS_PUSH, JSON.stringify(prefs))
/** The id the server gave this phone, to mark it in the device list. */
export const getDeviceId = () => storage.get(LS_DEVICE)
export function setDeviceId(id) { if (id) storage.set(LS_DEVICE, id); else try { localStorage.removeItem(LS_DEVICE) } catch { /* private mode */ } }
