#!/usr/bin/env node
/** Sets the remote-access password (and optionally a TOTP secret). Usage: node setup.js [--totp] */
import { createInterface } from 'node:readline'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { makeAuthRecord, saveAuthRecord } from './auth.js'

const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'remote-access')
mkdirSync(dir, { recursive: true })
const rl = createInterface({ input: process.stdin, output: process.stdout })
rl.question('New remote password (min 14 chars; use a long passphrase): ', (pw) => {
  rl.close()
  if (pw.length < 14) { console.error('Too short.'); process.exit(1) }
  const rec = makeAuthRecord(pw, process.argv.includes('--totp'))
  saveAuthRecord(dir, rec)
  console.log(`Saved to ${dir}\\auth.json (restart DSH to apply the first time)`)
  if (rec.totpSecret) console.log(`Add to your authenticator app (manual entry, SHA1, 6 digits, 30s): ${rec.totpSecret}\notpauth://totp/DSH?secret=${rec.totpSecret}&issuer=dsh-remote-access`)
})
