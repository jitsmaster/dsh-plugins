/**
 * hub.config.json (in the state dir, written by the user, never holds a secret): hubPort, publicUrl, allowedTailnetLogins,
 * staleGraceMs, android { packageName, sha256CertFingerprints }, pushSubject (the VAPID subject: an https URL or a mailto with a real
 * domain; when unset the hub uses its https publicUrl origin, else mailto:dsh-review-queue@localhost). Anything missing or invalid falls back to the
 * default, so a typo can never stop the hub from starting.
 */
import { join } from 'node:path'
import { readText } from './atomic-file.js'

export const CONFIG_FILE = 'hub.config.json'

const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : [])

function parseUrl(value) {
  try {
    const u = new URL(String(value))
    return u.protocol === 'https:' || u.protocol === 'http:' ? { host: u.host, origin: u.origin } : undefined
  } catch { return undefined }
}

export function loadHubConfig(stateDir, { log = () => {} } = {}) {
  let raw = {}
  const text = readText(join(stateDir, CONFIG_FILE))
  if (text !== undefined) {
    try {
      const value = JSON.parse(text)
      if (value && typeof value === 'object' && !Array.isArray(value)) raw = value
      else log(CONFIG_FILE + ' ignored: not an object')
    } catch { log(CONFIG_FILE + ' ignored: not valid JSON') }
  }
  const pub = raw.publicUrl === undefined ? undefined : parseUrl(raw.publicUrl)
  const android = raw.android && typeof raw.android === 'object' ? raw.android : {}
  return {
    hubPort: Number.isInteger(raw.hubPort) && raw.hubPort > 0 && raw.hubPort < 65536 ? raw.hubPort : undefined,
    publicUrl: pub ? pub.origin : undefined,
    publicHost: pub?.host,
    publicOrigin: pub?.origin,
    allowedTailnetLogins: strings(raw.allowedTailnetLogins),
    staleGraceMs: Number.isFinite(raw.staleGraceMs) && raw.staleGraceMs >= 0 ? raw.staleGraceMs : undefined,
    android: { packageName: typeof android.packageName === 'string' ? android.packageName : undefined, sha256CertFingerprints: strings(android.sha256CertFingerprints) },
    pushSubject: typeof raw.pushSubject === 'string' ? raw.pushSubject : undefined,
  }
}
