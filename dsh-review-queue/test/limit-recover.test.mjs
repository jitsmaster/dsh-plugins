import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewQueuePlugin } from '../index.js'

// Cycle 2 security Medium: a run that died after the logout leaves the user signed out; the plugin undoes it at the next start.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout waiting'); await sleep(10) } }
const ctx = () => ({ on: () => {}, get: () => undefined, effect: () => {}, logger: { warn() {}, info() {} }, inject: () => {} })

test('starting the plugin restores the login of a limit sign-in run that died, and drops its backup', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rq-rec-'))
  try {
    const dshHome = join(tmp, 'dsh')
    const home = join(tmp, 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    const cred = join(home, '.claude', '.credentials.json')
    const settings = join(home, '.claude.json')
    const dir = join(dshHome, 'claude-code', 'limit-backup', '2026-01-01T00-00-00-000Z')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.credentials.json'), '{"email":"old@x.com"}')
    writeFileSync(join(dir, 'RUN.json'), JSON.stringify({ pid: 424242, startedAt: Date.now() - 60_000, mode: 'D', committed: false, saved: [[cred, '.credentials.json']], absent: [settings] }))
    writeFileSync(settings, '{"other":1}')
    createReviewQueuePlugin(ctx(), { hub: false, stateDir: join(tmp, 'state'), taskbarBadge: false, limitSignInDeps: { dshHome, defaultPaths: { credentials: cred, settings }, homeDir: home, pidAlive: () => false } })
    await until(() => !existsSync(dir))
    assert.equal(JSON.parse(readFileSync(cred, 'utf8')).email, 'old@x.com')
    assert.equal(existsSync(settings), false)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('a recovery that throws does not break the plugin start', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rq-rec-'))
  try {
    const plugin = createReviewQueuePlugin(ctx(), { hub: false, stateDir: join(tmp, 'state'), taskbarBadge: false, limitSignInDeps: { dshHome: join(tmp, 'dsh'), fs: { readdir: () => { throw new Error('boom') } } } })
    assert.ok(plugin.limitSignIn)
    await sleep(50)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})