import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeFingerprint, parseKeytoolSha256, parseApksignerSha256, mergeAndroidConfig } from '../android/tools/fingerprints.mjs'
import { parseProperties } from '../android/tools/project-props.mjs'
import { updateHubConfigFile } from '../android/tools/update-hub-config.mjs'

const FP = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89'
const FP2 = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00'
const SHA1 = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD'

const KEYTOOL = [
  'Alias name: rq', 'Creation date: Oct 15, 2026', 'Entry type: PrivateKeyEntry', 'Certificate chain length: 1', 'Certificate[1]:',
  'Owner: CN=DSH Review Queue', 'Certificate fingerprints:', '\t SHA1: ' + SHA1, '\t SHA256: ' + FP,
  'Signature algorithm name: SHA256withRSA', 'Subject Public Key Algorithm: 2048-bit RSA key',
].join('\r\n')

const APKSIGNER = [
  'Signer #1 certificate DN: CN=DSH Review Queue',
  'Signer #1 certificate SHA-256 digest: ' + FP2.replaceAll(':', '').toLowerCase(),
  'Signer #1 certificate SHA-1 digest: 00112233445566778899aabbccddeeff00112233',
  'Signer #1 certificate MD5 digest: 00112233445566778899aabbccddeeff',
  'Signer #1 public key SHA-256 digest: ' + FP.replaceAll(':', '').toLowerCase(),
].join('\n')

test('normalizeFingerprint: colon or bare hex in any case becomes upper-case with colons; anything else undefined', () => {
  assert.equal(normalizeFingerprint(FP.toLowerCase()), FP)
  assert.equal(normalizeFingerprint(FP.replaceAll(':', '')), FP)
  assert.equal(normalizeFingerprint(SHA1), undefined)
  assert.equal(normalizeFingerprint('zz'), undefined)
  assert.equal(normalizeFingerprint(undefined), undefined)
})

test('parseKeytoolSha256 reads the SHA256 line of keytool -list -v and ignores SHA1 and the algorithm name', () => {
  assert.deepEqual(parseKeytoolSha256(KEYTOOL), [FP])
  assert.deepEqual(parseKeytoolSha256('SHA-256: ' + FP), [FP])
  assert.deepEqual(parseKeytoolSha256('nothing here'), [])
  assert.deepEqual(parseKeytoolSha256(undefined), [])
})

test('parseApksignerSha256 reads the certificate digest and not the public key digest', () => {
  assert.deepEqual(parseApksignerSha256(APKSIGNER), [FP2])
  assert.deepEqual(parseApksignerSha256('Verifies'), [])
})

test('mergeAndroidConfig sets package and fingerprints and keeps every other key, without mutating the input', () => {
  const input = { publicUrl: 'https://h.ts.net', android: { other: 1, sha256CertFingerprints: [FP2] } }
  const copy = JSON.stringify(input)
  const out = mergeAndroidConfig(input, { packageName: 'com.dsh.reviewqueue', fingerprints: [FP.toLowerCase(), FP, 'bad'] })
  assert.equal(JSON.stringify(input), copy)
  assert.deepEqual(out, { publicUrl: 'https://h.ts.net', android: { other: 1, packageName: 'com.dsh.reviewqueue', sha256CertFingerprints: [FP] } })
})

test('mergeAndroidConfig with union keeps the fingerprints already listed', () => {
  const out = mergeAndroidConfig({ android: { sha256CertFingerprints: [FP2] } }, { packageName: 'a.b', fingerprints: [FP], union: true })
  assert.deepEqual(out.android.sha256CertFingerprints, [FP2, FP])
})

test('mergeAndroidConfig refuses an invalid package name or an empty fingerprint set', () => {
  assert.throws(() => mergeAndroidConfig({}, { packageName: 'nodots', fingerprints: [FP] }), /package/i)
  assert.throws(() => mergeAndroidConfig({}, { packageName: 'a.b', fingerprints: [] }), /fingerprint/i)
})

test('parseProperties reads key=value lines, comments, whitespace and Windows line endings', () => {
  assert.deepEqual(parseProperties('# c\r\nrq.applicationId = com.x.y\r\n\r\nfoo=a=b\n! bang\nbar:2'), { 'rq.applicationId': 'com.x.y', foo: 'a=b', bar: '2' })
})

test('updateHubConfigFile writes the merged config atomically and keeps the other keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-hubcfg-'))
  const file = join(dir, 'hub.config.json')
  writeFileSync(file, JSON.stringify({ publicUrl: 'https://h.ts.net', allowedTailnetLogins: ['me@example.com'] }))
  const out = updateHubConfigFile(file, { packageName: 'com.dsh.reviewqueue', fingerprints: [FP, FP2] })
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(disk, out)
  assert.deepEqual(disk.allowedTailnetLogins, ['me@example.com'])
  assert.deepEqual(disk.android.sha256CertFingerprints, [FP, FP2])
})

test('updateHubConfigFile creates the file when missing and refuses to overwrite an unparseable one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-hubcfg-'))
  const fresh = join(dir, 'new.json')
  updateHubConfigFile(fresh, { packageName: 'a.b', fingerprints: [FP] })
  assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).android.packageName, 'a.b')
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ not json')
  assert.throws(() => updateHubConfigFile(broken, { packageName: 'a.b', fingerprints: [FP] }), /JSON/)
  assert.equal(readFileSync(broken, 'utf8'), '{ not json')
})
