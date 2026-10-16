/**
 * CLI + function: writes android.packageName and the signing fingerprints into hub.config.json (state dir ~/.dsh/review-queue by default).
 * Usage: node update-hub-config.mjs --config <file> --package <id> --fingerprint <sha256> [--fingerprint <sha256> ...] [--union]
 * The hub only reads this file at start, so the hub must be restarted for assetlinks.json to change (POST /hub/v1/shutdown).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeAndroidConfig } from './fingerprints.mjs'

export function updateHubConfigFile(file, { packageName, fingerprints, union = false }) {
  let current = {}
  if (existsSync(file)) {
    try { current = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error(file + ' is not valid JSON; fix or delete it (not overwritten)') }
  }
  const next = mergeAndroidConfig(current, { packageName, fingerprints, union })
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, file) // atomic replace: the hub never reads a half-written config
  return next
}

function main(argv) {
  const opts = { fingerprints: [], union: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') opts.config = argv[++i]
    else if (a === '--package') opts.packageName = argv[++i]
    else if (a === '--fingerprint') opts.fingerprints.push(argv[++i])
    else if (a === '--union') opts.union = true
    else throw new Error('unknown argument ' + a)
  }
  if (!opts.config) throw new Error('--config <hub.config.json> is required')
  const out = updateHubConfigFile(opts.config, opts)
  console.log('hub.config.json android: ' + out.android.packageName + ', ' + out.android.sha256CertFingerprints.length + ' fingerprint(s)')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exit(1) }
}
