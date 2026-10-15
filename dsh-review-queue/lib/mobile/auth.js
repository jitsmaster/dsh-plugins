/**
 * The pure parts of the phone's sign-in (docs/mobile.md "Sign-in", docs/hub.md 9.4): where the hub's own routes are, the Bearer header, what a
 * 401 means, the pairing fragment, the pair request body and the words for each way pairing can fail. No DOM, no network: unit-tested
 * (test/mobile-auth.test.mjs).
 */

/** localStorage key of the device token (the Chrome origin is shared by the TWA and the tab). */
export const TOKEN_KEY = 'rq-m.token'
const NAME_MAX = 40

/** The hub's own routes (/hub/v1/...) sit at the root of the origin, next to the plugin prefix ("/review-queue", maybe behind a path prefix). */
export const hubBase = (api) => String(api).replace(/\/review-queue$/, '')

/** The fetch init with the Bearer header added when there is a token; the caller's init is not changed. */
export function withAuth(init, token) {
  if (!token) return init
  return { ...init, headers: { ...(init.headers || {}), authorization: 'Bearer ' + token } }
}

/** Only the hub saying auth-required sends the phone back to pairing (a DSH login page or a 403 is another problem). */
export const isAuthFailure = (status, body) => status === 401 && !!body && body.error === 'auth-required'

export const authFailureText = (hadToken) => (hadToken
  ? 'This phone was signed out: it was removed on the desktop, or not used for 180 days. Pair it again with a new code.'
  : 'Pair this phone first: on the desktop open the task list, press Phone, then Pair a phone, and enter the code here.')

/** "#/pair/ABCD-EFGH" -> { isPair: true, code }; the code travels only in the fragment, so it never reaches a server log. */
export function parsePairHash(hash) {
  const m = /^#\/pair(?:\/(.*))?$/.exec(String(hash || ''))
  if (!m) return { isPair: false, code: '' }
  try { return { isPair: true, code: decodeURIComponent(m[1] || '') } } catch { return { isPair: true, code: '' } }
}

export const pairBody = (code, name) => ({ code: String(code || '').trim(), name: String(name || '').trim().slice(0, NAME_MAX) })

/** The words for a failed pairing; retryAfter is the Retry-After header (seconds). */
export function pairErrorText(status, body, retryAfter) {
  const code = body && body.error
  if (status === 0) return 'Could not reach the hub. Is Tailscale on and the address right?'
  if (code === 'bad-code') return 'That code is wrong, expired or already used. Ask for a new one on the desktop (Phone, then Pair a phone).'
  if (code === 'rate-limited') return 'Too many tries. ' + (Number(retryAfter) > 0 ? 'Wait ' + Number(retryAfter) + ' seconds and try again.' : 'Wait a moment and try again.')
  if (code === 'login-not-allowed') return 'This Tailscale account is not allowed to use the task list.'
  if (code === 'too-many-devices') return 'Too many phones are paired. Remove one on the desktop first.'
  if (!body && status >= 400 && status < 500) return 'This address does not answer like the hub (HTTP ' + status + '). Open the address of the hub, not the DSH page.'
  return 'Pairing failed (' + (code || 'HTTP ' + status) + ').'
}
