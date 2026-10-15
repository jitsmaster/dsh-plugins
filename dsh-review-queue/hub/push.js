/**
 * The phones that get push notifications: one record per browser push subscription, kept in push.json, plus the
 * VAPID key pair (vapid.json, same dir). In the hub a record belongs to a paired device (deviceId) or is a legacy record without one
 * (an old push.json: it keeps receiving pushes; a paired device that subscribes with the same endpoint absorbs it, docs/hub.md 12.2). Validates what the phone sends, saves after every change, and removes a device the push
 * service reports as gone (404/410). The phone's own rules for quiet hours are reused (lib/mobile/push-client.js), so both sides agree.
 * Secrets (endpoint, keys) never leave through list(); the notifier reads them through devices() / send().
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PUSH_TYPES, validateQuietHours } from '../lib/mobile/push-client.js'
import { fromB64u, generateVapidKeys, publicKeyOf, sendPush as realSendPush } from './webpush.js'

const VERSION = 1
const MAX_DEVICES = 20
const NAME_MAX = 40
const ENDPOINT_MAX = 2048
const ERROR_MAX = 200
export const DEFAULT_SUBJECT = 'mailto:dsh-review-queue@localhost'

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const typeIds = PUSH_TYPES.map((t) => t.id)
const defaultTypes = () => Object.fromEntries(typeIds.map((id) => [id, true]))

/** Atomic JSON file: write a temp file (private mode where the OS has one), then rename over the target; prepare(tmp) runs before the rename. */
export function jsonFileIo(file, { mode, prepare } = {}) {
  return {
    read: () => { try { return readFileSync(file, 'utf8') } catch { return undefined } },
    write: (text) => {
      const tmp = file + '.tmp'
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(tmp, text, mode === undefined ? undefined : { mode })
      prepare?.(tmp) // a rename keeps the rights of the temp file: a private file is tightened here
      renameSync(tmp, file)
    },
  }
}

// ---- validation ------------------------------------------------------------------------------------------------------------

/** Loopback, private and link-local hosts: the server must not be turned into a request forwarder for the local network. */
function isLocalHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  return h.includes(':') && (h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:'))
}

function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > ENDPOINT_MAX) return false
  try {
    const u = new URL(endpoint)
    return u.protocol === 'https:' && !u.username && !u.password && !isLocalHost(u.hostname)
  } catch { return false }
}

function validKeys(keys) {
  if (!isObject(keys)) return false
  try {
    const p = fromB64u(keys.p256dh)
    return p.length === 65 && p[0] === 4 && fromB64u(keys.auth).length === 16
  } catch { return false }
}

/** Validates the settings that are present; { ok, patch } with only those fields (types merged later onto the device's own). */
function settingsPatch({ name, types, quiet }) {
  const patch = {}
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length > NAME_MAX) return { ok: false, error: 'bad-name' }
    patch.name = name.trim()
  }
  if (types !== undefined) {
    if (!isObject(types)) return { ok: false, error: 'bad-types' }
    patch.types = {}
    for (const id of typeIds) {
      if (!(id in types)) continue
      if (typeof types[id] !== 'boolean') return { ok: false, error: 'bad-types' }
      patch.types[id] = types[id]
    }
  }
  if (quiet !== undefined) {
    const q = validateQuietHours(quiet)
    if (!q.ok) return { ok: false, error: 'bad-quiet', detail: q.error }
    patch.quiet = q.value
  }
  return { ok: true, patch }
}

const publicDevice = (d) => ({ id: d.id, deviceId: d.deviceId ?? null, name: d.name, types: { ...d.types }, quiet: { ...d.quiet }, createdAt: d.createdAt, lastSuccessAt: d.lastSuccessAt ?? null, lastError: d.lastError ?? null })

/**
 * @param {{ io?: { read: () => string | undefined, write: (text: string) => void }, now?: () => number, uuid?: () => string,
 *   sendPush?: typeof realSendPush, vapid?: { publicKey: string, privateKey: string, subject: string } | (() => { publicKey: string, privateKey: string, subject: string }) }} [opts]
 *   vapid may be a function, called when a push is sent (the hub creates its key pair on first use).
 */
export function createPushStore({ io, now = Date.now, uuid = () => randomUUID().slice(0, 12), sendPush = realSendPush, vapid } = {}) {
  /** @type {Map<string, any>} */
  const records = new Map()

  const save = () => {
    if (!io) return
    try { io.write(JSON.stringify({ v: VERSION, devices: [...records.values()] })) } catch { /* persistence is best effort */ }
  }

  function load() {
    try {
      const data = JSON.parse(io?.read() ?? 'null')
      if (!data || data.v !== VERSION || !Array.isArray(data.devices)) return
      for (const d of data.devices) {
        if (!isObject(d) || typeof d.id !== 'string' || !validEndpoint(d.endpoint) || !validKeys(d.keys)) continue
        records.set(d.id, { ...d, deviceId: typeof d.deviceId === 'string' ? d.deviceId : null, types: { ...defaultTypes(), ...(isObject(d.types) ? d.types : {}) }, quiet: validateQuietHours(d.quiet).value ?? validateQuietHours({}).value })
      }
    } catch { records.clear() }
  }
  load()

  const byEndpoint = (endpoint) => [...records.values()].find((d) => d.endpoint === endpoint)
  const locate = ({ id, endpoint } = {}) => (typeof id === 'string' ? records.get(id) : typeof endpoint === 'string' ? byEndpoint(endpoint) : undefined)
  const apply = (device, patch) => {
    if (patch.name !== undefined) device.name = patch.name
    if (patch.types) device.types = { ...device.types, ...patch.types }
    if (patch.quiet) device.quiet = patch.quiet
  }

  return {
    /** Registers a device, or updates the one with this endpoint. Settings that are not sent keep their value (defaults for a new device). */
    upsert(input) {
      const sub = isObject(input?.subscription) ? input.subscription : {}
      if (!validEndpoint(sub.endpoint)) return { ok: false, error: 'bad-endpoint' }
      if (!validKeys(sub.keys)) return { ok: false, error: 'bad-keys' }
      const parsed = settingsPatch(input)
      if (!parsed.ok) return parsed
      let device = byEndpoint(sub.endpoint)
      const owner = typeof input?.deviceId === 'string' && input.deviceId ? input.deviceId : undefined
      // A paired device has one subscription: a new endpoint replaces its old one.
      if (owner) for (const other of [...records.values()]) if (other.deviceId === owner && other.endpoint !== sub.endpoint) records.delete(other.id)
      if (!device) {
        if (records.size >= MAX_DEVICES) return { ok: false, error: 'too-many-devices' }
        device = { id: uuid(), deviceId: null, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, name: '', types: defaultTypes(), quiet: validateQuietHours({}).value, createdAt: now(), lastSuccessAt: null, lastError: null }
        records.set(device.id, device)
      }
      device.keys = { p256dh: sub.keys.p256dh, auth: sub.keys.auth }
      if (owner) device.deviceId = owner // absorbs a legacy record, or moves the endpoint to the device that holds it now
      apply(device, parsed.patch)
      save()
      return { ok: true, device: publicDevice(device) }
    },
    /** Changes the name, type switches and/or quiet hours of the device with this endpoint. */
    update(endpoint, settings) {
      const device = byEndpoint(endpoint)
      if (!device) return { ok: false, error: 'unknown-device' }
      const parsed = settingsPatch(isObject(settings) ? settings : {})
      if (!parsed.ok) return parsed
      apply(device, parsed.patch)
      save()
      return { ok: true, device: publicDevice(device) }
    },
    /** @param {{ id?: string, endpoint?: string }} target */
    remove(target) {
      const device = locate(target)
      if (!device) return false
      records.delete(device.id)
      save()
      return true
    },
    /** Drops every subscription of a paired device (revoke); how many were dropped. */
    removeByDevice(deviceId) {
      const mine = [...records.values()].filter((d) => d.deviceId === deviceId)
      for (const d of mine) records.delete(d.id)
      if (mine.length) save()
      return mine.length
    },
    /** The full record (with endpoint and keys) for the notifier and the routes; a copy. */
    find: (target) => { const d = locate(target); return d ? structuredClone(d) : undefined },
    devices: () => [...records.values()].map((d) => structuredClone(d)),
    /** Devices as the API shows them: no endpoint, no keys; { deviceId } cuts the list to one paired device. */
    list: ({ deviceId } = {}) => [...records.values()].filter((d) => deviceId === undefined || d.deviceId === deviceId).sort((a, b) => a.createdAt - b.createdAt).map(publicDevice),
    /**
     * Sends to one device (an id, or a record from devices()) and keeps the books: a gone subscription is deleted, success and
     * failure are recorded. Never throws.
     * @returns {Promise<{ ok: boolean, status: number, gone: boolean, removed: boolean, error?: string }>}
     */
    async send(target, payload, opts = {}) {
      const device = records.get(typeof target === 'string' ? target : target?.id)
      if (!device) return { ok: false, status: 0, gone: false, removed: false, error: 'unknown-device' }
      const result = await sendPush({ endpoint: device.endpoint, keys: device.keys }, payload, { ...opts, vapid: typeof vapid === 'function' ? vapid() : vapid })
      const current = records.get(device.id)
      if (!current) return { ...result, removed: false }
      if (result.gone) { records.delete(device.id); save(); return { ...result, removed: true } }
      if (result.ok) { current.lastSuccessAt = now(); current.lastError = null } else current.lastError = String(result.error ?? 'failed').slice(0, ERROR_MAX)
      save()
      return { ...result, removed: false }
    },
  }
}

// ---- VAPID key pair --------------------------------------------------------------------------------------------------------

/**
 * The server's VAPID key pair: read from the file, or created and saved once. A damaged file, or one whose public key does not
 * belong to its private key, is replaced (existing subscriptions then fail with 403 and the phone resubscribes). Without a file
 * the pair lives for this run only.
 * @param {{ io?: { read: () => string | undefined, write: (text: string) => void }, subject?: string }} [opts]
 */
export function loadOrCreateVapid({ io, subject = DEFAULT_SUBJECT } = {}) {
  try {
    const data = JSON.parse(io?.read() ?? 'null')
    if (data && data.v === VERSION && typeof data.publicKey === 'string' && typeof data.privateKey === 'string' && publicKeyOf(data.privateKey) === data.publicKey) return { publicKey: data.publicKey, privateKey: data.privateKey, subject }
  } catch { /* fall through: create a new pair */ }
  const keys = generateVapidKeys()
  try { io?.write(JSON.stringify({ v: VERSION, ...keys })) } catch { /* keep the pair in memory */ }
  return { ...keys, subject }
}
