// RED: static checks of scripts/rc-notify.ps1 (the RingCentral DM script). It is never executed here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const read = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rc-notify.ps1'), 'utf8')

test('rc-notify.ps1 reads the five env-file keys', () => {
  const ps1 = read()
  for (const key of ['RC_CLIENT_ID', 'RC_CLIENT_SECRET', 'RC_SERVER', 'RC_JWT', 'RC_PERSONAL_CHAT_ID']) assert.ok(ps1.includes(key), key)
})

test('rc-notify.ps1 uses the JWT bearer grant against /restapi/oauth/token and posts to the personal chat', () => {
  const ps1 = read()
  assert.match(ps1, /urn:ietf:params:oauth:grant-type:jwt-bearer/)
  assert.match(ps1, /\/restapi\/oauth\/token/)
  assert.match(ps1, /team-messaging\/v1\/chats\/.*posts/)
  assert.match(ps1, /Basic/)
  assert.match(ps1, /Bearer/)
})

test('rc-notify.ps1 reads the message from stdin and sends UTF-8 bytes', () => {
  const ps1 = read()
  assert.match(ps1, /\[Console\]::In|OpenStandardInput|\$input/)
  assert.match(ps1, /UTF8/)
})

test('rc-notify.ps1 never echoes secret values and fails with a non-zero exit', () => {
  const ps1 = read()
  const printed = ps1.split(/\r?\n/).filter((l) => /Write-(Host|Output|Error|Warning|Verbose)|\[Console\]::(Error|Out)|throw/.test(l))
  for (const l of printed) assert.doesNotMatch(l, /\$(RcJwt|jwt|secret|clientSecret|RC_JWT|RC_CLIENT_SECRET|token|accessToken|assertion|env:RC_)/i, l)
  assert.match(ps1, /exit 1/)
  assert.doesNotMatch(ps1, /Start-Sleep|retry/i)
  assert.match(ps1, /TimeoutSec/)
})




test('rc-notify.ps1 refuses a non-https RC_SERVER with a fixed message, before the token request', () => {
	const ps1 = read()
	const guard = ps1.search(/-notmatch\s+'\^https:\/\/'/i)
	assert.ok(guard > 0, 'https guard present')
	const line = ps1.slice(guard).split(/\r?\n/)[0]
	assert.match(line, /Fail\s+'RC_SERVER must be an https:\/\/ URL'/)
	assert.doesNotMatch(line.slice(line.indexOf('Fail')), /\$/, 'the message prints no variable')
	assert.ok(guard < ps1.indexOf('/restapi/oauth/token'), 'guard precedes the token request')
	assert.ok(guard < ps1.indexOf('Invoke-RestMethod'), 'guard precedes any request')
})

test('rc-notify.ps1 URL-escapes the chat id before it goes into the post URL', () => {
  const ps1 = read()
  assert.match(ps1, /\[Uri\]::EscapeDataString\(\$cfg\['RC_PERSONAL_CHAT_ID'\]\)/)
  assert.doesNotMatch(ps1, /'\/team-messaging\/v1\/chats\/' \+ \$cfg\['RC_PERSONAL_CHAT_ID'\]/)
})
