/**
 * /.well-known/assetlinks.json for the Android app (Trusted Web Activity): Chrome reads it from the site to verify the app.
 * Built from hub.config.json android.packageName + sha256CertFingerprints; an empty list when not configured. The file is public
 * by design and holds a package name and certificate fingerprints only.
 */
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/

/** "ab:cd:..." or 64 bare hex digits, any case -> "AB:CD:..."; undefined when it is not a SHA-256 fingerprint. */
function fingerprint(value) {
  if (typeof value !== 'string') return undefined
  const hex = value.replaceAll(':', '').toUpperCase()
  return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g).join(':') : undefined
}

/** @param {{ packageName?: unknown, sha256CertFingerprints?: unknown }} [android] */
export function buildAssetLinks(android) {
  const name = android?.packageName
  const list = Array.isArray(android?.sha256CertFingerprints) ? android.sha256CertFingerprints : []
  const prints = [...new Set(list.map(fingerprint).filter(Boolean))]
  if (typeof name !== 'string' || !PACKAGE.test(name) || !prints.length) return []
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: name, sha256_cert_fingerprints: prints },
  }]
}
