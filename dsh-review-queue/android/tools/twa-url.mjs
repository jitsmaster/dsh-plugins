/**
 * URL -> pieces for the Android shell: the start URL the TWA opens, its origin (the Digital Asset Links site), host and path prefix
 * (the optional VIEW intent filter). Pure; the only place the phone page path is spelled out for the Android side.
 */

/** Where the hub serves the phone PWA (hub/http.js static route). */
export const MOBILE_PATH = '/review-queue/m/'
const DEFAULT_HUB_PORT = 47615

/**
 * @param {unknown} input an absolute URL
 * @param {{ allowHttp?: boolean }} [opts] http is only for the loopback debug variant: a TWA needs https
 */
export function deriveTwaUrl(input, { allowHttp = false } = {}) {
  if (typeof input !== 'string' || !input) throw new Error('start URL must be a non-empty string')
  let u
  try { u = new URL(input) } catch { throw new Error('start URL is not a valid absolute URL: ' + input) }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new Error('start URL must be https (a TWA cannot verify http): ' + input)
  if (u.username || u.password) throw new Error('start URL must not embed credentials')
  // new URL() already lower-cases the host and drops a default port; query and fragment are not part of the app identity.
  const pathPrefix = u.pathname || '/'
  return {
    startUrl: u.origin + pathPrefix,
    origin: u.origin,
    scheme: u.protocol.slice(0, -1),
    host: u.hostname,
    port: u.port,
    pathPrefix,
  }
}

/** The release start URL: an explicit one, else the hub's public origin plus the phone path. @param {{ publicUrl?: unknown } | undefined} hubConfig */
export function startUrlFromConfig(hubConfig, explicit) {
  if (explicit !== undefined) return deriveTwaUrl(explicit).startUrl
  const pub = hubConfig?.publicUrl
  if (typeof pub !== 'string' || !pub) throw new Error('hub.config.json has no publicUrl (the https origin of the hub, e.g. https://<node>.<tailnet>.ts.net)')
  return deriveTwaUrl(deriveTwaUrl(pub).origin + MOBILE_PATH).startUrl
}

/** The loopback URL of the localDebug variant (reach it with adb reverse). @param {{ hubPort?: unknown } | undefined} hubConfig */
export function localDebugUrl(hubConfig) {
  const p = hubConfig?.hubPort
  const port = Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_HUB_PORT
  return 'http://127.0.0.1:' + port + MOBILE_PATH
}
