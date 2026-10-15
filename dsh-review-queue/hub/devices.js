/**
 * The paired phones (docs/hub.md 9.3, 9.4, 7): one record per device with its name, the SHA-256 of its token (the token itself exists
 * only in the answer to the pairing and never again), when it was created, last seen and which Tailscale login paired it, and whether it
 * was revoked. A request is authenticated by hashing the Bearer token and looking the hash up; a revoked device and one idle for more than
 * 180 days get the same answer as an unknown token. hub/devices.json is written atomically (the io pair of atomic-file.js, which
 * also keeps the last good copy); a device whose record cannot be written is not created, a revoke takes effect in memory even when
 * the file cannot be written. lastSeenAt moves at most once a minute and is written a moment later, off the request path.
 */
import { createHash, randomBytes } from 'node:crypto'

export const DEVICE_IDLE_MS = 180 * 86400_000
export const TOKEN_PATTERN = /^rqd_[A-Za-z0-9_-]{43}$/
export const MAX_ACTIVE_DEVICES = 20
const VERSION = 1
const NAME_MAX = 40
const LOGIN_MAX = 200
const SEEN_EVERY_MS = 60_000
const SEEN_WRITE_DELAY_MS = 2000
const HASH = /^[0-9a-f]{64}$/

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const view = ({ tokenHash, ...rest }) => ({ ...rest })

/** Control characters out, trimmed, at most 40 characters; '' when it is not text. */
export function cleanName(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, '').trim().slice(0, NAME_MAX).trim() : ''
}

/**
 * @param {{ io: { read: (which: 'main' | 'bak') => string | undefined, write: (text: string, opts: { rotate: boolean }) => void }, now?: () => number,
 *   random?: (n: number) => Buffer, timers?: { setTimeout: Function, clearTimeout: Function }, log?: (line: string) => void, onRevoke?: (deviceId: string) => void }} opts
 */
export function createDevices({ io, now = Date.now, random = randomBytes, timers = globalThis, log = () => {}, onRevoke = () => {} }) {
  /** @type {Map<string, any>} id -> record (with tokenHash) */
  const records = new Map()
  let seenTimer

  const record = (d) => d && typeof d === 'object' && typeof d.id === 'string' && /^dv_[0-9a-f]{12}$/.test(d.id) && typeof d.tokenHash === 'string' && HASH.test(d.tokenHash)
  function load() {
    for (const which of ['main', 'bak']) {
      let data
      try { data = JSON.parse(io.read(which) ?? 'null') } catch { data = null }
      if (!data || data.v !== VERSION || !Array.isArray(data.devices)) continue
      for (const d of data.devices.filter(record)) {
        records.set(d.id, { id: d.id, name: cleanName(d.name) || 'Phone', tokenHash: d.tokenHash, createdAt: Number(d.createdAt) || 0, lastSeenAt: Number(d.lastSeenAt) || 0, lastLogin: typeof d.lastLogin === 'string' ? d.lastLogin : null, revokedAt: Number.isFinite(d.revokedAt) ? d.revokedAt : null })
      }
      if (which === 'bak') log('devices file unreadable, recovered from the last good copy (' + records.size + ' devices)')
      return
    }
    if (io.read('main') !== undefined) log('devices file unreadable, starting without devices')
  }
  load()

  /** @returns {boolean} whether the file was written */
  function persist() {
    timers.clearTimeout(seenTimer)
    seenTimer = undefined
    try { io.write(JSON.stringify({ v: VERSION, devices: [...records.values()] }), { rotate: true }); return true } catch (error) {
      log('devices file not written: ' + String(error?.code ?? error?.name ?? 'error'))
      return false
    }
  }
  const active = (d) => d.revokedAt === null

  return {
    /** @returns {{ ok: true, device: object, token: string } | { ok: false, error: 'too-many-devices' | 'persist-failed' }} */
    create({ name, login } = {}) {
      if ([...records.values()].filter(active).length >= MAX_ACTIVE_DEVICES) return { ok: false, error: 'too-many-devices' }
      const token = 'rqd_' + random(32).toString('base64url')
      const t = now()
      const device = { id: 'dv_' + random(6).toString('hex'), name: cleanName(name) || 'Phone', tokenHash: sha256(token), createdAt: t, lastSeenAt: t, lastLogin: typeof login === 'string' && login ? login.slice(0, LOGIN_MAX) : null, revokedAt: null }
      records.set(device.id, device)
      if (!persist()) { records.delete(device.id); return { ok: false, error: 'persist-failed' } }
      return { ok: true, device: view(device), token }
    },

    /** @returns {{ ok: true, device: { id: string, name: string } } | { ok: false, error: 'auth-required' }} one answer for unknown, revoked and idle */
    authenticate(token) {
      const refused = { ok: false, error: 'auth-required' }
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return refused
      const hash = sha256(token)
      const device = [...records.values()].find((d) => d.tokenHash === hash)
      const t = now()
      if (!device || !active(device) || t - device.lastSeenAt > DEVICE_IDLE_MS) return refused
      if (t - device.lastSeenAt >= SEEN_EVERY_MS) {
        device.lastSeenAt = t
        timers.clearTimeout(seenTimer)
        seenTimer = timers.setTimeout(persist, SEEN_WRITE_DELAY_MS)
        seenTimer.unref?.()
      }
      return { ok: true, device: { id: device.id, name: device.name } }
    },

    get: (id) => { const d = records.get(id); return d ? view(d) : undefined },
    list: () => [...records.values()].sort((a, b) => a.createdAt - b.createdAt).map(view),
    isActive: (id) => { const d = records.get(id); return !!d && active(d) && now() - d.lastSeenAt <= DEVICE_IDLE_MS },

    rename(id, name) {
      const device = records.get(id)
      if (!device) return { ok: false, error: 'unknown-device' }
      const clean = cleanName(name)
      if (!clean) return { ok: false, error: 'bad-name' }
      device.name = clean
      persist()
      return { ok: true, device: view(device) }
    },

    /** Takes effect in memory first; onRevoke (drop the push subscription, abort the long polls) runs once. */
    revoke(id) {
      const device = records.get(id)
      if (!device) return { ok: false, error: 'unknown-device' }
      if (active(device)) {
        device.revokedAt = now()
        persist()
        try { onRevoke(id) } catch (error) { log('revoke cleanup failed: ' + String(error?.name ?? 'error')) }
      }
      return { ok: true, device: view(device) }
    },

    /** Write a pending lastSeenAt now (shutdown). */
    flush() { if (seenTimer) persist() },
  }
}
