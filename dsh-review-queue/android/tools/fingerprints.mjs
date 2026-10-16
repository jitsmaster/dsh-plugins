/**
 * Signing-certificate fingerprints for hub.config.json android.sha256CertFingerprints (what /.well-known/assetlinks.json lists):
 * parsing keytool and apksigner output and merging into the hub config object. Pure; update-hub-config.mjs does the file I/O.
 */
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/

/** "ab:cd:..." or 64 bare hex digits, any case -> "AB:CD:..."; undefined for anything else (a SHA-1 is 40 digits and is rejected). */
export function normalizeFingerprint(value) {
  if (typeof value !== 'string') return undefined
  const hex = value.replaceAll(':', '').trim().toUpperCase()
  return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g).join(':') : undefined
}

/** SHA-256 fingerprints printed by `keytool -list -v` ("SHA256: AB:CD:..."); the "SHA256withRSA" algorithm line has no colon after SHA256. */
export function parseKeytoolSha256(text) {
  const found = [...String(text ?? '').matchAll(/SHA-?256:\s*((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})/g)]
  return found.map((m) => normalizeFingerprint(m[1])).filter(Boolean)
}

/** SHA-256 certificate digests from `apksigner verify --print-certs`; the "public key SHA-256 digest" line is a different hash and is skipped. */
export function parseApksignerSha256(text) {
  const found = [...String(text ?? '').matchAll(/certificate SHA-256 digest:\s*([0-9a-fA-F]{64})/g)]
  return found.map((m) => normalizeFingerprint(m[1])).filter(Boolean)
}

/**
 * Returns a copy of the hub config with android.packageName and android.sha256CertFingerprints set; every other key is kept.
 * By default the fingerprints are replaced by the given set (the caller passes the full current list); union keeps the old ones too.
 */
export function mergeAndroidConfig(config, { packageName, fingerprints, union = false }) {
  if (typeof packageName !== 'string' || !PACKAGE.test(packageName)) throw new Error('invalid Android package name: ' + String(packageName))
  const given = (Array.isArray(fingerprints) ? fingerprints : []).map(normalizeFingerprint).filter(Boolean)
  const base = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const android = base.android && typeof base.android === 'object' && !Array.isArray(base.android) ? base.android : {}
  const old = union && Array.isArray(android.sha256CertFingerprints) ? android.sha256CertFingerprints.map(normalizeFingerprint).filter(Boolean) : []
  const list = [...new Set([...old, ...given])]
  if (!list.length) throw new Error('no valid SHA-256 fingerprint given (need 64 hex digits)')
  return { ...base, android: { ...android, packageName, sha256CertFingerprints: list } }
}
