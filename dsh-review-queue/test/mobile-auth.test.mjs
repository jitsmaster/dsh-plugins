import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOKEN_KEY, authFailureText, hubBase, isAuthFailure, pairBody, pairErrorText, parsePairHash, withAuth } from '../lib/mobile/auth.js'

// The pure parts of the phone's sign-in (docs/mobile.md "Sign-in"): where the hub's own routes are, the Bearer header, what a 401 means, the
// pairing fragment, the request body and the words for every way pairing can fail.

test('the hub routes sit next to the plugin prefix: /hub/v1/... on the same origin, also behind a path prefix', () => {
  assert.equal(hubBase('/review-queue'), '')
  assert.equal(hubBase('/proxy/review-queue'), '/proxy')
  assert.equal(hubBase(''), '')
})

test('withAuth adds the Bearer header when there is a token and changes nothing else; the caller\'s init is not touched', () => {
  const init = { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }
  const authed = withAuth(init, 'rqd_abc')
  assert.deepEqual(authed.headers, { 'content-type': 'application/json', authorization: 'Bearer rqd_abc' })
  assert.deepEqual([authed.method, authed.credentials, authed.body], ['POST', 'same-origin', '{}'])
  assert.equal(init.headers.authorization, undefined)
  assert.deepEqual(withAuth({ credentials: 'same-origin' }, 'rqd_abc').headers, { authorization: 'Bearer rqd_abc' })
  assert.deepEqual(withAuth(init, null), init, 'no token, no header')
  assert.equal(withAuth({}, '').headers, undefined)
})

test('only the hub saying auth-required means "pair again"; the DSH login page, a 403 and other errors do not', () => {
  assert.equal(isAuthFailure(401, { error: 'auth-required' }), true)
  assert.equal(isAuthFailure(401, null), false)
  assert.equal(isAuthFailure(401, { error: 'other' }), false)
  assert.equal(isAuthFailure(403, { error: 'auth-required' }), false)
  assert.equal(isAuthFailure(200, { error: 'auth-required' }), false)
})

test('the message for being signed out says why: never paired, or removed / unused', () => {
  assert.match(authFailureText(false), /pair/i)
  assert.match(authFailureText(true), /removed|signed out/i)
  assert.notEqual(authFailureText(true), authFailureText(false))
})

test('the pairing link carries the code only in the fragment, and the code is read from it', () => {
  assert.deepEqual(parsePairHash('#/pair/ABCD-EFGH'), { isPair: true, code: 'ABCD-EFGH' })
  assert.deepEqual(parsePairHash('#/pair/abcd%20efgh'), { isPair: true, code: 'abcd efgh' })
  assert.deepEqual(parsePairHash('#/pair'), { isPair: true, code: '' })
  assert.deepEqual(parsePairHash('#/pair/'), { isPair: true, code: '' })
  assert.deepEqual(parsePairHash('#/item/x'), { isPair: false, code: '' })
  assert.deepEqual(parsePairHash(''), { isPair: false, code: '' })
  assert.deepEqual(parsePairHash('#/pair/%E0%A4%A'), { isPair: true, code: '' }, 'a broken escape is no code, not an exception')
})

test('the pair body is the trimmed code and a name of at most 40 characters', () => {
  assert.deepEqual(pairBody('  abcd-efgh ', ' Pixel 9 '), { code: 'abcd-efgh', name: 'Pixel 9' })
  assert.equal(pairBody('x', 'n'.repeat(80)).name.length, 40)
  assert.deepEqual(pairBody(undefined, undefined), { code: '', name: '' })
})

test('every way pairing fails has its own words', () => {
  assert.match(pairErrorText(400, { error: 'bad-code' }), /wrong, expired or already used/i)
  assert.match(pairErrorText(429, { error: 'rate-limited' }, '30'), /30 seconds/)
  assert.match(pairErrorText(429, { error: 'rate-limited' }), /wait a moment/i)
  assert.match(pairErrorText(403, { error: 'login-not-allowed' }), /tailscale account/i)
  assert.match(pairErrorText(409, { error: 'too-many-devices' }), /too many phones/i)
  assert.match(pairErrorText(404, null), /not the hub|does not answer/i)
  assert.match(pairErrorText(500, { error: 'persist-failed' }), /persist-failed/)
  assert.match(pairErrorText(0, null), /could not reach/i)
})

test('the token lives under one storage key', () => {
  assert.equal(TOKEN_KEY, 'rq-m.token')
})
