import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { copyFile, readdir as readdirAsync, rename as renameAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { accountId, activeAccountSetter, createLimitSignIn, locateClaude, spawnProcess } from '../limit-signin.js'

// A fake `claude` (node script). Behaviour comes from env the spawn wrapper adds (the module's own child env stays minimal).
const FAKE = `
const fs = require('fs'), path = require('path')
const args = process.argv.slice(2)
const dir = process.env.CLAUDE_CONFIG_DIR || process.env.FAKE_DEFAULT_DIR
const cred = path.join(dir, '.credentials.json')
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, dir: process.env.CLAUDE_CONFIG_DIR || null }) + '\\n')
if (args[0] === 'auth' && args[1] === 'logout') { try { const root = process.env.FAKE_BACKUP_ROOT; fs.appendFileSync(process.env.FAKE_MARKER_LOG, String(fs.readdirSync(root).some((d) => fs.existsSync(path.join(root, d, 'RUN.json')))) + '\\n') } catch (e) { fs.appendFileSync(process.env.FAKE_MARKER_LOG, 'error\\n') } if (!process.env.FAKE_LOGOUT_NOOP) fs.rmSync(cred, { force: true }); process.exit(0) }
if (args[0] === 'auth' && args[1] === 'status') {
  if (process.env.FAKE_STATUS_ALWAYS_IN) { console.log(JSON.stringify({ loggedIn: true, email: 'keychain@x.com' })); process.exit(0) }
  console.log(JSON.stringify(fs.existsSync(cred) ? { loggedIn: true, email: JSON.parse(fs.readFileSync(cred, 'utf8')).email } : { loggedIn: false }))
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'login') {
  const email = (args.find((a) => a.startsWith('--email=')) || '').slice(8)
  console.log('Opening browser to sign in\\nhttps://claude.com/cai/oauth/authorize?code=true&state=ST&login_hint=' + email + '\\n')
  let buf = ''
  process.stdin.on('data', (d) => {
    buf += d
    if (!buf.includes('\\n')) return
    const line = buf.split('\\n')[0]
    if (line.startsWith('GOOD')) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(cred, JSON.stringify({ email: process.env.FAKE_LOGIN_EMAIL || email }))
      console.log('Login successful')
      process.exit(0)
    }
    console.error('Invalid code: ' + (process.env.FAKE_ECHO_HALF ? line.split('#')[0] : line))
    process.exit(1)
  })
} else process.exit(2)
`

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() > end) throw new Error('timeout waiting'); await new Promise((r) => setTimeout(r, 10)) }
}

const OLD = 'old@x.com'
const NEW = 'New@X.com'
const OLD_FOLDER = 'old-at-x.com-1234abcd'

function make(opts = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'rq-limit-'))
  const script = join(tmp, 'fake-claude.js')
  writeFileSync(script, FAKE)
  const home = join(tmp, 'home')
  const defaultDir = join(home, '.claude')
  const dshHome = opts.shareWith?.dshHome ?? join(tmp, 'dsh') // shareWith: a second instance on the same DSH home (app and hub in one process, or two processes)
  const accountsDir = join(dshHome, 'claude-code', 'accounts')
  const oldFolder = join(accountsDir, OLD_FOLDER)
  mkdirSync(defaultDir, { recursive: true })
  mkdirSync(oldFolder, { recursive: true })
  for (const dir of [defaultDir, oldFolder]) writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ email: OLD }))
  writeFileSync(join(home, '.claude.json'), '{"default":1}')
  writeFileSync(join(oldFolder, '.claude.json'), '{"folder":1}')
  const fakeLog = join(tmp, 'calls.log')
  writeFileSync(fakeLog, '')
  const specs = []
  const handles = []
  const launchers = []
  const pins = []
  const logs = []
  const calls = { makeDefault: [], setActive: [] }
  const extraEnv = opts.fakeEnv ?? {}
  const spawn = (spec) => {
    specs.push(spec)
    if (spec.env.BROWSER && existsSync(spec.env.BROWSER)) launchers.push({ path: spec.env.BROWSER, text: readFileSync(spec.env.BROWSER, 'utf8') })
    const handle = spawnProcess({ ...spec, file: process.execPath, args: [script, ...spec.args], env: { ...spec.env, FAKE_LOG: fakeLog, FAKE_DEFAULT_DIR: defaultDir, FAKE_BACKUP_ROOT: join(dshHome, 'claude-code', 'limit-backup'), FAKE_MARKER_LOG: join(tmp, 'marker.log'), ...extraEnv } })
    handles.push(handle)
    return handle
  }
  const modeA = opts.modeA === true
  const accounts = opts.noAccounts ? undefined : {
    status: async () => (modeA
      ? { accounts: [{ email: OLD, id: OLD_FOLDER, signedIn: true, active: true }], defaultAccount: { email: OLD }, activeAccount: OLD }
      : { accounts: [], defaultAccount: { email: OLD } }),
    makeDefault: async (email) => { calls.makeDefault.push(email); return opts.makeDefaultResult ?? { ok: true } },
  }
  const sut = createLimitSignIn({
    spawn, accounts, ...(opts.fs ? { fs: opts.fs } : {}),
    ...(opts.locate ? { homeDir: home } : { claudeExecutable: 'claude' }), pidAlive: opts.pidAlive ?? (() => false),
    ...(opts.noSetActive ? {} : { setActiveAccount: async (email) => { calls.setActive.push(email); return opts.setActiveImpl ? opts.setActiveImpl(email) : opts.setActiveResult } }),
    pinned: { set: (p) => { pins.push(p); return true } },
    log: (line) => logs.push(String(line)),
    dshHome, defaultPaths: { credentials: join(defaultDir, '.credentials.json'), settings: join(home, '.claude.json') },
    baseEnv: opts.baseEnv ?? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ANTHROPIC_API_KEY: 'sk-secret', CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret', CLAUDE_CONFIG_DIR: 'C:\\should\\not\\leak' },
    platform: 'win32', launcherEnv: { ProgramFiles: 'C:\\Program Files' },
    browserExists: opts.browserExists ?? ((p) => p.endsWith('chrome.exe')),
    ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}),
    ...(opts.commitStepMs ? { commitStepMs: opts.commitStepMs } : {}),
    codeReplyMs: 3000,
  })
  const read = (p) => readFileSync(p, 'utf8')
  const calledArgs = () => read(fakeLog).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const states = () => pins.map((p) => p.state).filter(Boolean).filter((s, i, a) => s !== a[i - 1])
  const cleanup = () => { handles.forEach((h) => h.kill()); rmSync(tmp, { recursive: true, force: true }) }
  return { tmp, sut, specs, handles, launchers, pins, logs, calls, defaultDir, home, dshHome, accountsDir, oldFolder, read, calledArgs, states, cleanup }
}

const awaitCode = (t) => until(() => t.sut.state().state === 'awaiting-code')
const everything = (t) => JSON.stringify([t.pins, t.logs, t.sut.state()])

test('limit-signin 1: email is checked, normalized, run is single and has a budget', async () => {
  const t = make()
  try {
    for (const bad of [undefined, {}, { email: 5 }, { email: 'nope' }, { email: 'a@b' }, { email: '-a@b.co' }, { email: `${'a'.repeat(250)}@b.co` }]) {
      assert.deepEqual(await t.sut.start(bad), { ok: false, error: 'bad-email' })
    }
    assert.equal(t.specs.length, 0)
    assert.equal(t.sut.state().state, 'idle')
    assert.equal((await t.sut.start({ email: NEW })).ok, true)
    assert.deepEqual(await t.sut.start({ email: 'other@x.com' }), { ok: false, error: 'busy' })
    await awaitCode(t)
    assert.equal(t.sut.state().email, 'new@x.com')
    assert.deepEqual(await t.sut.start({ email: 'other@x.com' }), { ok: false, error: 'busy' })
    await t.sut.cancel()
    assert.equal((await t.sut.start({ email: NEW })).ok, true) // idle again after the run ended
    await t.sut.cancel()
  } finally { t.cleanup() }
})

test('limit-signin 1b: the 10 minute budget (injectable) ends the run as failed and restores', async () => {
  const t = make({ budgetMs: 400 })
  try {
    await t.sut.start({ email: NEW })
    await t.sut.whenDone() // the fake never gets a code, so only the budget can end it
    assert.equal(t.sut.state().state, 'failed')
    assert.match(t.pins.at(-1).note, /timed out/i)
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
    assert.ok(t.handles.every((h) => h.exited))
  } finally { t.cleanup() }
})

test('limit-signin 2/3/4/5/7 Mode D: backup, logout then status, login in private window, verify, signed-in', async () => {
  const t = make()
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    { // while the run is open the backup exists (it is what a failure restores)
      const root = join(t.dshHome, 'claude-code', 'limit-backup')
      const [stamp] = readdirSync(root)
      assert.equal(t.read(join(root, stamp, '.claude.json')), '{"default":1}')
      assert.equal(JSON.parse(t.read(join(root, stamp, '.credentials.json'))).email, OLD)
    }
    assert.equal('url' in t.sut.state(), false, 'the live authorize link (OAuth state) is not exposed by state()')
    assert.deepEqual((await t.sut.code(' GOOD-code \n')), { ok: true })
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'signed-in', t.pins.at(-1)?.note)
    assert.deepEqual(t.states(), ['opening', 'awaiting-code', 'verifying', 'signed-in'])
    const verbs = t.calledArgs().map((c) => c.args.slice(0, 2).join(' ') + (c.args[1] === 'login' ? ' ' + c.args.slice(2).join(' ') : ''))
    assert.deepEqual(verbs, ['auth logout', 'auth status', 'auth login --claudeai --email=new@x.com', 'auth status'])
    assert.ok(t.specs.every((s) => !('CLAUDE_CONFIG_DIR' in s.env)), 'Mode D never sets CLAUDE_CONFIG_DIR')
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, 'new@x.com')
    // the backup holds the old token: it is removed once the sign-in succeeded
    assert.deepEqual(readdirSync(join(t.dshHome, 'claude-code', 'limit-backup')), [])
    // launcher: private Chrome, removed afterwards
    const login = t.specs.find((s) => s.args.includes('login'))
    assert.equal(basename(login.env.BROWSER), 'open-private.cmd')
    assert.match(t.launchers[0].text, /--incognito/)
    assert.equal(existsSync(login.env.BROWSER), false)
    assert.equal(existsSync(dirname(login.env.BROWSER)), false)
    assert.equal(t.specs.filter((s) => s.env.BROWSER).length, 1, 'only the login gets BROWSER')
    assert.match(t.pins.find((p) => p.state === 'awaiting-code').note, /private Chrome window/)
  } finally { t.cleanup() }
})

test('limit-signin 5b: without a private-capable browser the note says to use a private window or clear cookies', async () => {
  const t = make({ browserExists: () => false })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    assert.match(t.pins.find((p) => p.state === 'awaiting-code').note, /private window.*cookies|cookies.*private window/i)
    assert.match(t.launchers[0].text, /^@echo off\r\nstart "" "%~1"\r\n$/)
    await t.sut.cancel()
  } finally { t.cleanup() }
})

test('limit-signin 6: code validation, only in awaiting-code, never logged or stored', async () => {
  const t = make()
  try {
    assert.deepEqual(await t.sut.code('GOOD'), { ok: false, error: 'no-run' })
    await t.sut.start({ email: NEW })
    for (const bad of [undefined, 5, '', '   ', 'x'.repeat(2001)]) assert.deepEqual(await t.sut.code(bad), { ok: false, error: 'bad-code' })
    await awaitCode(t)
    assert.deepEqual(await t.sut.code('GOOD-s3cr3tvalue'), { ok: true })
    assert.deepEqual(await t.sut.code('GOOD-s3cr3tvalue'), { ok: false, error: 'no-run' }) // verifying now
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'signed-in')
    assert.ok(!everything(t).includes('s3cr3tvalue'))
  } finally { t.cleanup() }
})

test('limit-signin 6b: a rejected code fails the run without leaking it, and restores', async () => {
  const t = make()
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('BAD-s3cr3tvalue')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'failed')
    assert.ok(!everything(t).includes('s3cr3tvalue'))
    assert.ok(!everything(t).includes('https://'), 'no link in a note')
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
    assert.match(t.pins.at(-1).note, /sign in again|revoke/i)
  } finally { t.cleanup() }
})

test('limit-signin 4b: logout that does not log out fails before any login and restores', async () => {
  const t = make({ fakeEnv: { FAKE_LOGOUT_NOOP: '1' } })
  try {
    // Status after the no-op logout still says loggedIn:true.
    await t.sut.start({ email: NEW })
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'failed')
    assert.ok(!t.calledArgs().some((c) => c.args[1] === 'login'))
    assert.match(t.pins.at(-1).note, /sign-?out|logged out|still/i)
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
  } finally { t.cleanup() }
})

test('limit-signin 7: signed in as another account fails with the mismatch and restores', async () => {
  const t = make({ fakeEnv: { FAKE_LOGIN_EMAIL: 'someone@else.com' } })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'failed')
    const note = t.pins.at(-1).note
    assert.doesNotMatch(note, /someone@else\.com/, 'another account email does not go onto a card (hub, phone)')
    assert.match(note, /different account/)
    assert.match(note, /new@x\.com/)
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
    assert.equal(t.read(join(t.home, '.claude.json')), '{"default":1}')
  } finally { t.cleanup() }
})

test('limit-signin 7b: the email comparison ignores case', async () => {
  const t = make({ fakeEnv: { FAKE_LOGIN_EMAIL: 'NEW@x.COM' } })
  try {
    await t.sut.start({ email: 'new@x.com' })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'signed-in')
  } finally { t.cleanup() }
})

test('limit-signin 8 Mode A: target is the active account folder; new login goes to its own folder; activeAccount and default follow', async () => {
  const t = make({ modeA: true })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'signed-in', t.pins.at(-1)?.note)
    const calls = t.calledArgs()
    assert.equal(calls[0].dir, t.oldFolder) // logout
    assert.equal(calls[1].dir, t.oldFolder) // status
    const login = calls.find((c) => c.args[1] === 'login')
    assert.notEqual(login.dir, t.oldFolder)
    assert.equal(dirname(login.dir), t.accountsDir)
    assert.equal(existsSync(login.dir), false, 'staging is gone')
    const folder = join(t.accountsDir, accountId('new@x.com'))
    assert.equal(JSON.parse(t.read(join(folder, '.credentials.json'))).email, 'new@x.com')
    assert.deepEqual(t.calls.setActive, ['new@x.com'])
    assert.deepEqual(t.calls.makeDefault, ['new@x.com'])
    assert.deepEqual(readdirSync(join(t.dshHome, 'claude-code', 'limit-backup')), [], 'backup removed after success')
  } finally { t.cleanup() }
})

test('limit-signin 8b Mode A: failure restores the old folder and touches no setting', async () => {
  const t = make({ modeA: true, fakeEnv: { FAKE_LOGIN_EMAIL: 'someone@else.com' } })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'failed')
    assert.equal(JSON.parse(t.read(join(t.oldFolder, '.credentials.json'))).email, OLD)
    assert.deepEqual(readdirSync(t.accountsDir), [OLD_FOLDER], 'no staging left')
    assert.deepEqual(t.calls.setActive, [])
    assert.deepEqual(t.calls.makeDefault, [])
  } finally { t.cleanup() }
})

test('limit-signin 8c: missing optional services fall back with the "set activeAccount" note', async () => {
  const t = make({ noAccounts: true })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'signed-in')
    assert.ok(t.specs.every((s) => !('CLAUDE_CONFIG_DIR' in s.env)), 'falls back to the default login')
    assert.match(t.pins.at(-1).note, /set activeAccount to new@x\.com/i)
  } finally { t.cleanup() }
  const a = make({ modeA: true, noSetActive: true })
  try {
    await a.sut.start({ email: NEW })
    await awaitCode(a)
    await a.sut.code('GOOD')
    await a.sut.whenDone()
    assert.equal(a.sut.state().state, 'signed-in')
    assert.match(a.pins.at(-1).note, /set activeAccount to new@x\.com/i)
  } finally { a.cleanup() }
})

test('limit-signin 8d: makeDefault refusing is reported on the card but the sign-in stands', async () => {
  const t = make({ modeA: true, makeDefaultResult: { ok: false, reason: 'new@x.com has not signed in; sign in first' } })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'signed-in')
    assert.match(t.pins.at(-1).note, /default/i)
  } finally { t.cleanup() }
})

test('limit-signin 8e: a setActiveAccount that resolves { ok: false } is reported on the card (the sign-in stands)', async () => {
  const t = make({ modeA: true, setActiveResult: { ok: false, error: 'revision-conflict' } })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'signed-in')
    assert.match(t.pins.at(-1).note, /set activeAccount to new@x\.com/i)
  } finally { t.cleanup() }
  const ok = make({ modeA: true, setActiveResult: { ok: true } })
  try {
    await ok.sut.start({ email: NEW })
    await awaitCode(ok)
    await ok.sut.code('GOOD')
    await ok.sut.whenDone()
    assert.doesNotMatch(ok.pins.at(-1).note, /set activeAccount/i)
  } finally { ok.cleanup() }
})

test('limit-signin 8f: a failed run deletes credential files the login wrote that the backup did not have (Mode D, was logged out)', async () => {
  const t = make({ fakeEnv: { FAKE_LOGIN_EMAIL: 'someone-else@x.com' } })
  try {
    rmSync(join(t.defaultDir, '.credentials.json'), { force: true })
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'failed')
    assert.equal(existsSync(join(t.defaultDir, '.credentials.json')), false, 'the other account credentials must not stay')
  } finally { t.cleanup() }
})

test('limit-signin 8g: an email with control characters or quote/shell characters is bad-email before any process runs', async () => {
  const t = make()
  try {
    for (const bad of ['a\u0000@b.co', 'a\u001b@b.co', 'a\n@b.co', 'a"b@c.co', "a'b@c.co", 'a%b@c.co', 'a&b@c.co', 'a|b@c.co', 'a<b>@c.co', 'a`b@c.co', 'a\\b@c.co']) {
      assert.deepEqual(await t.sut.start({ email: bad }), { ok: false, error: 'bad-email' }, JSON.stringify(bad))
    }
    assert.equal(t.specs.length, 0)
    assert.equal((await t.sut.start({ email: 'first.last+tag@sub.example.co' })).ok, true)
    await t.sut.cancel()
  } finally { t.cleanup() }
})

test('limit-signin 8h: no credentials file to back up while Claude says it is signed in (keychain): no logout, nothing changed, honest note', async () => {
  const t = make({ fakeEnv: { FAKE_STATUS_ALWAYS_IN: '1' } })
  try {
    rmSync(join(t.defaultDir, '.credentials.json'), { force: true })
    await t.sut.start({ email: NEW })
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'failed')
    assert.ok(!t.calledArgs().some((c) => c.args[1] === 'logout'), 'logout must never run')
    assert.match(t.pins.at(-1).note, /nothing was changed/i)
    assert.doesNotMatch(t.pins.at(-1).note, /restored from backup/i)
  } finally { t.cleanup() }
})

test('limit-signin 8i: a failed run that restored the login removes the backup copy of the token', async () => {
  const t = make({ fakeEnv: { FAKE_LOGIN_EMAIL: 'someone-else@x.com' } })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'failed')
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
    assert.deepEqual(readdirSync(join(t.dshHome, 'claude-code', 'limit-backup')), [])
  } finally { t.cleanup() }
})

test('limit-signin 8j: a rejected code echoed back in halves (code part only) is masked in the note and the log', async () => {
  const t = make({ fakeEnv: { FAKE_ECHO_HALF: '1' } })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('BAD-half-s3cr3tpart')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'failed')
    assert.doesNotMatch(everything(t), /s3cr3tpart/)
  } finally { t.cleanup() }
})

test('limit-signin 9: cancel kills the child, restores, removes temp files, says failed with the revoke warning', async () => {
  const t = make({ modeA: true })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    const login = t.specs.find((s) => s.args.includes('login'))
    assert.deepEqual(await t.sut.cancel(), { ok: true })
    assert.equal(t.sut.state().state, 'failed')
    assert.match(t.pins.at(-1).note, /cancel/i)
    assert.match(t.pins.at(-1).note, /revoke|sign in again/i)
    assert.ok(t.handles.every((h) => h.exited), 'children are gone')
    assert.equal(JSON.parse(t.read(join(t.oldFolder, '.credentials.json'))).email, OLD)
    assert.equal(existsSync(dirname(login.env.BROWSER)), false)
    assert.deepEqual(readdirSync(t.accountsDir), [OLD_FOLDER])
    assert.deepEqual(await t.sut.cancel(), { ok: false, error: 'no-run' })
  } finally { t.cleanup() }
})

test('limit-signin 9b: a Cancel that arrives after the login is verified (committing) is refused and the new login stands', async () => {
  let pending
  const t = make({ modeA: true, setActiveImpl: () => { pending = t.sut.cancel() } })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.deepEqual(await pending, { ok: false, error: 'no-run' })
    assert.equal(t.sut.state().state, 'signed-in')
    assert.equal(JSON.parse(t.read(join(t.accountsDir, accountId(NEW), '.credentials.json'))).email, 'New@X.com'.toLowerCase())
  } finally { t.cleanup() }
})

// Security review High: a backup that fails midway must not make the failure path delete the live login files (nothing was logged out yet).
test('limit-signin 9c: a backup copy that fails leaves the live login files untouched, no logout, and no OS error text on the card', async () => {
  const failing = { copyFile: async (src, dest) => { if (String(dest).endsWith('.claude.json')) { const e = new Error("EBUSY: copyfile 'C:\\Users\\secretname\\.claude.json'"); e.code = 'EBUSY'; throw e } return copyFile(src, dest) } }
  const t = make({ fs: failing })
  try {
    await t.sut.start({ email: NEW })
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'failed')
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
    assert.equal(t.read(join(t.home, '.claude.json')), '{"default":1}')
    assert.ok(!t.calledArgs().some((c) => c.args[1] === 'logout'), 'logout must never run')
    assert.match(t.pins.at(-1).note, /nothing was changed/i)
    assert.doesNotMatch(t.pins.at(-1).note, /secretname|restored from backup/i)
    assert.deepEqual(readdirSync(join(t.dshHome, 'claude-code', 'limit-backup')), [])
  } finally { t.cleanup() }
})

// Memory/perf review Medium: after the commit point the budget cannot abort; a settings write or makeDefault that never settles must not wedge the run.
test('limit-signin 9d: a setActiveAccount that never settles is cut off after commitStepMs, the run ends signed-in with the manual note', async () => {
  const t = make({ modeA: true, commitStepMs: 150, setActiveImpl: () => new Promise(() => {}) })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().running, false)
    assert.equal(t.sut.state().state, 'signed-in')
    assert.match(t.pins.at(-1).note, /set activeAccount to new@x\.com/i)
    assert.deepEqual(t.calls.makeDefault, ['new@x.com'])
  } finally { t.cleanup() }
})

// Peer review Low: a faulty seam that makes finish() throw must not reject whenDone() unhandled or leave the run stuck.
test('limit-signin 9e: finish() throwing is caught and logged, the run still ends and a good sign-in stays signed-in', async () => {
  const t = make({ fs: { rm: () => { throw new Error('sync boom') } } })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().running, false)
    assert.equal(t.sut.state().state, 'signed-in')
    assert.ok(t.logs.some((l) => /finish failed/.test(l)))
  } finally { t.cleanup() }
})

test('limit-signin 10: the child env is the minimal inherited env plus CLAUDE_CONFIG_DIR/BROWSER, no tokens', async () => {
  const t = make({ modeA: true })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.cancel()
    const allowed = /^(PATH|PATHEXT|SystemRoot|SYSTEMROOT|windir|WINDIR|ComSpec|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|USERNAME|USER|LOGNAME|LANG|LC_ALL|SHELL|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|ProgramData|NUMBER_OF_PROCESSORS|OS|CLAUDE_CONFIG_DIR|BROWSER)$/
    for (const s of t.specs) {
      for (const k of Object.keys(s.env)) assert.match(k, allowed)
      assert.ok(!('ANTHROPIC_API_KEY' in s.env) && !('CLAUDE_CODE_OAUTH_TOKEN' in s.env))
      assert.ok(s.env.CLAUDE_CONFIG_DIR !== 'C:\\should\\not\\leak')
    }
  } finally { t.cleanup() }
})

test('limit-signin: accountId equals DSH account.ts (the real folder name of awang@ingeniux.com)', () => {
  assert.equal(accountId('awang@ingeniux.com'), 'awang-at-ingeniux.com-dc9cda76')
  assert.equal(accountId('  AWang@Ingeniux.com '), 'awang-at-ingeniux.com-dc9cda76')
  assert.match(accountId('arnold.wang@ingeniux.com'), /^arnold\.wang-at-ingeniux\.com-[0-9a-f]{8}$/)
  assert.match(accountId('a b/c@x.y'), /^[a-z0-9][a-z0-9._-]*$/)
})

// Low 3: the server-side writer of activeAccount is the host `settings` service (ctx.get('settings').mutate), not ctx.remote.settings (browser side).
test('limit-signin: activeAccountSetter writes activeAccount of llm-claude-code through settings.mutate', async () => {
  const calls = []
  const set = activeAccountSetter({ mutate: async (...a) => { calls.push(a) } })
  await set('a@x.com')
  assert.deepEqual(calls, [['llm-claude-code', [{ op: 'set', path: ['activeAccount'], value: 'a@x.com' }]]])
})

test('limit-signin: activeAccountSetter is undefined without a settings service with mutate', () => {
  assert.equal(activeAccountSetter(undefined), undefined)
  assert.equal(activeAccountSetter({}), undefined)
})

// ---- cycle 2 security review: crash recovery (Medium) and the cheap Lows -------------------------------------------------------------------------
const BACKUP = (t) => join(t.dshHome, 'claude-code', 'limit-backup')
const markerOf = (t, over = {}) => ({
  pid: 424242, startedAt: Date.now() - 60_000, mode: 'D', committed: false,
  saved: [[join(t.defaultDir, '.credentials.json'), '.credentials.json'], [join(t.home, '.claude.json'), '.claude.json']], absent: [], ...over,
})
/** A backup folder as a run that died would leave it. */
function strand(t, { name = '2026-01-01T00-00-00-000Z', marker, files = { '.credentials.json': JSON.stringify({ email: OLD }), '.claude.json': '{"default":1}' } } = {}) {
  const dir = join(BACKUP(t), name)
  mkdirSync(dir, { recursive: true })
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text)
  if (marker) writeFileSync(join(dir, 'RUN.json'), typeof marker === 'string' ? marker : JSON.stringify(marker))
  const old = Date.now() / 1000 - 7200 // the live login files predate the run that died (a newer one is a login made since: see 12i)
  for (const p of [join(t.defaultDir, '.credentials.json')]) if (existsSync(p)) utimesSync(p, old, old)
  return dir
}

test('limit-signin 11: a RUN.json marker with the restore plan is in the backup folder before the logout; the folder goes away on success', async () => {
  const t = make()
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    const root = BACKUP(t)
    const [stamp] = readdirSync(root)
    const marker = JSON.parse(t.read(join(root, stamp, 'RUN.json')))
    assert.equal(marker.pid, process.pid)
    assert.equal(marker.mode, 'D')
    assert.equal(marker.committed, false)
    assert.equal(typeof marker.startedAt, 'number')
    assert.deepEqual(marker.saved, [[join(t.defaultDir, '.credentials.json'), '.credentials.json'], [join(t.home, '.claude.json'), '.claude.json']])
    assert.deepEqual(marker.absent, [])
    assert.doesNotMatch(JSON.stringify(marker), /s3cr3t|token|https:|@/i, 'no secret and no email in the marker')
    assert.equal(t.read(join(t.tmp, 'marker.log')).trim().split('\n')[0], 'true', 'the marker existed when the logout ran')
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.deepEqual(readdirSync(root), [])
  } finally { t.cleanup() }
})

test('limit-signin 11b: a file the backup saw absent is listed under absent, not saved', async () => {
  const t = make()
  try {
    rmSync(join(t.home, '.claude.json'), { force: true })
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    const [stamp] = readdirSync(BACKUP(t))
    const marker = JSON.parse(t.read(join(BACKUP(t), stamp, 'RUN.json')))
    assert.deepEqual(marker.saved, [[join(t.defaultDir, '.credentials.json'), '.credentials.json']])
    assert.deepEqual(marker.absent, [join(t.home, '.claude.json')])
    await t.sut.cancel()
  } finally { t.cleanup() }
})

test('limit-signin 11c: the marker says committed once the new login is verified', async () => {
  let seen
  const t = make({ modeA: true, setActiveImpl: () => { const [stamp] = readdirSync(BACKUP(t)); seen = JSON.parse(t.read(join(BACKUP(t), stamp, 'RUN.json'))).committed } })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(seen, true)
  } finally { t.cleanup() }
})

test('limit-signin 12: recoverStranded restores the login of a run that died after the logout, then drops the backup', async () => {
  const t = make()
  try {
    const dir = strand(t, { marker: markerOf(t) })
    rmSync(join(t.defaultDir, '.credentials.json'), { force: true })
    writeFileSync(join(t.home, '.claude.json'), '{"loggedout":1}')
    assert.deepEqual(await t.sut.recoverStranded(), { recovered: 1, kept: 0, skipped: 0, pruned: 0 })
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
    assert.equal(t.read(join(t.home, '.claude.json')), '{"default":1}')
    assert.equal(existsSync(dir), false)
    assert.ok(t.logs.some((l) => /recovered/i.test(l)))
  } finally { t.cleanup() }
})

test('limit-signin 12b: files the backup saw absent are deleted again by the recovery (another login may have written them)', async () => {
  const t = make()
  try {
    const cred = join(t.defaultDir, '.credentials.json')
    strand(t, { files: {}, marker: markerOf(t, { saved: [], absent: [cred] }) })
    assert.ok(existsSync(cred))
    assert.equal((await t.sut.recoverStranded()).recovered, 1)
    assert.equal(existsSync(cred), false)
    assert.deepEqual(readdirSync(BACKUP(t)), [])
  } finally { t.cleanup() }
})

test('limit-signin 12c: a run that is still alive in another process (live pid, fresh marker) is left alone', async () => {
  const t = make({ pidAlive: (pid) => pid === 424242 })
  try {
    const dir = strand(t, { marker: markerOf(t) })
    writeFileSync(join(t.home, '.claude.json'), '{"other":1}')
    assert.deepEqual(await t.sut.recoverStranded(), { recovered: 0, kept: 0, skipped: 1, pruned: 0 })
    assert.equal(existsSync(dir), true)
    assert.equal(t.read(join(t.home, '.claude.json')), '{"other":1}')
  } finally { t.cleanup() }
})

test('limit-signin 12d: a live pid with a marker older than the budget plus slack is a reused pid: recovered', async () => {
  const t = make({ pidAlive: () => true })
  try {
    const dir = strand(t, { marker: markerOf(t, { startedAt: Date.now() - 3_600_000 }) })
    assert.equal((await t.sut.recoverStranded()).recovered, 1)
    assert.equal(existsSync(dir), false)
  } finally { t.cleanup() }
})

test('limit-signin 12e: a committed run that died keeps its new login: the backup is dropped, nothing is restored', async () => {
  const t = make()
  try {
    const dir = strand(t, { marker: markerOf(t, { committed: true }) })
    writeFileSync(join(t.home, '.claude.json'), '{"new":1}')
    assert.equal((await t.sut.recoverStranded()).recovered, 1)
    assert.equal(existsSync(dir), false)
    assert.equal(t.read(join(t.home, '.claude.json')), '{"new":1}')
  } finally { t.cleanup() }
})

test('limit-signin 12f: the backup of the run that is live in this process is never touched', async () => {
  const t = make()
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    assert.deepEqual(await t.sut.recoverStranded(), { recovered: 0, kept: 0, skipped: 1, pruned: 0 })
    assert.equal(readdirSync(BACKUP(t)).length, 1)
    await t.sut.cancel()
  } finally { t.cleanup() }
})

test('limit-signin 12g: a restore that fails keeps the backup and the marker; a bad or unsafe marker is kept and writes nothing', async () => {
  const t = make({ fs: { copyFile: async () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }) } } })
  try {
    const a = strand(t, { name: 'a', marker: markerOf(t) })
    const b = strand(t, { name: 'b', marker: '{not json' })
    const evil = join(t.tmp, 'evil.txt')
    const c = strand(t, { name: 'c', marker: markerOf(t, { saved: [[evil, '.credentials.json']] }) })
    const d = strand(t, { name: 'd', marker: markerOf(t, { saved: [[join(t.tmp, 'x'), '../evil']] }) })
    assert.deepEqual(await t.sut.recoverStranded(), { recovered: 0, kept: 4, skipped: 0, pruned: 0 })
    for (const dir of [a, b, c, d]) assert.equal(existsSync(dir), true)
    assert.equal(existsSync(evil), false)
  } finally { t.cleanup() }
})

test('limit-signin 12h: no backup folder at all is fine; old backup folders without a marker are pruned, fresh ones kept', async () => {
  const t = make()
  try {
    assert.deepEqual(await t.sut.recoverStranded(), { recovered: 0, kept: 0, skipped: 0, pruned: 0 })
    const old = strand(t, { name: 'old' })
    const fresh = strand(t, { name: 'fresh' })
    const week = Date.now() / 1000 - 8 * 86_400
    utimesSync(old, week, week)
    assert.deepEqual(await t.sut.recoverStranded(), { recovered: 0, kept: 0, skipped: 0, pruned: 1 })
    assert.equal(existsSync(old), false)
    assert.equal(existsSync(fresh), true)
  } finally { t.cleanup() }
})

// Cycle 3 security Medium: a login made since the run died (the user signed in by hand before DSH restarted) must not be overwritten by the old token.
test('limit-signin 12i: a credentials file newer than the run is a newer login: nothing is restored or deleted, the backup is kept', async () => {
  const t = make()
  try {
    const dir = strand(t, { marker: markerOf(t) })
    writeFileSync(join(t.defaultDir, '.credentials.json'), JSON.stringify({ email: 'fresh@x.com' })) // written now, after startedAt
    writeFileSync(join(t.home, '.claude.json'), '{"fresh":1}')
    assert.deepEqual(await t.sut.recoverStranded(), { recovered: 0, kept: 1, skipped: 0, pruned: 0 })
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, 'fresh@x.com')
    assert.equal(t.read(join(t.home, '.claude.json')), '{"fresh":1}')
    assert.equal(existsSync(dir), true)
    assert.ok(t.logs.some((l) => /newer login/i.test(l)))
  } finally { t.cleanup() }
})

test('limit-signin 12j: a newer credentials file that the backup saw absent is not deleted either', async () => {
  const t = make()
  try {
    const cred = join(t.defaultDir, '.credentials.json')
    const dir = strand(t, { files: {}, marker: markerOf(t, { saved: [], absent: [cred] }) })
    writeFileSync(cred, JSON.stringify({ email: 'fresh@x.com' }))
    assert.equal((await t.sut.recoverStranded()).kept, 1)
    assert.equal(existsSync(cred), true)
    assert.equal(existsSync(dir), true)
  } finally { t.cleanup() }
})

test('limit-signin 12k: an oversized marker is kept unread', async () => {
  const t = make()
  try {
    const dir = strand(t, { marker: JSON.stringify(markerOf(t)) + ' '.repeat(70_000) })
    assert.deepEqual(await t.sut.recoverStranded(), { recovered: 0, kept: 1, skipped: 0, pruned: 0 })
    assert.equal(existsSync(dir), true)
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
  } finally { t.cleanup() }
})

// Cycle 3 security Medium 2: the marker may say committed only once the new login is in its final place (Mode A moves a staging folder after the verify).
test('limit-signin 14: Mode A: the marker still says committed:false when the staging folder is moved into place, and committed:true after', async () => {
  let atRename
  let t
  const fsSeam = {
    rename: async (from, to) => {
      if (String(from).includes('.limit-')) { const [stamp] = readdirSync(BACKUP(t)); atRename = JSON.parse(readFileSync(join(BACKUP(t), stamp, 'RUN.json'), 'utf8')).committed }
      return renameAsync(from, to)
    },
  }
  let afterMove
  t = make({ modeA: true, fs: fsSeam, setActiveImpl: () => { const [stamp] = readdirSync(BACKUP(t)); afterMove = JSON.parse(readFileSync(join(BACKUP(t), stamp, 'RUN.json'), 'utf8')).committed } })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(atRename, false)
    assert.equal(afterMove, true)
  } finally { t.cleanup() }
})

// Cycle 3 security Low-Medium 3: recovery writes the same credential files a run uses, so a run waits for a recovery that is under way.
test('limit-signin 15: a run started while a recovery is under way does not spawn until the recovery has finished', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const t = make({ fs: { readdir: async (...a) => { await gate; return readdirAsync(...a) } } })
  try {
    const recovery = t.sut.recoverStranded()
    assert.equal((await t.sut.start({ email: NEW })).ok, true)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(t.specs.length, 0, 'no claude process while the recovery is pending')
    release()
    await recovery
    await awaitCode(t)
    assert.ok(t.specs.length > 0)
    await t.sut.cancel()
  } finally { release?.(); t.cleanup() }
})

// Cycle 3 security Low 4: a relative PATH entry is resolved against the working directory: never used.
test('locateClaude: relative PATH entries are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-rel-'))
  const cwd = process.cwd()
  try {
    mkdirSync(join(dir, 'rel'))
    writeFileSync(join(dir, 'rel', 'claude.exe'), '')
    const home = join(dir, 'home')
    mkdirSync(home)
    process.chdir(dir)
    assert.equal(locateClaude({ PATH: 'rel' }, 'win32', home), undefined)
    assert.equal(locateClaude({ PATH: '.' + (process.platform === 'win32' ? ';' : ':') + 'rel' }, 'win32', home), undefined)
  } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }) }
})

test('locateClaude: claude.exe on PATH or in ~/.local/bin; never a .cmd (it cannot be spawned without a shell); undefined when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-loc-'))
  try {
    const bin = join(dir, 'bin')
    const home = join(dir, 'home')
    mkdirSync(bin)
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    assert.equal(locateClaude({ PATH: bin }, 'win32', home), undefined)
    writeFileSync(join(bin, 'claude.cmd'), '')
    assert.equal(locateClaude({ PATH: bin }, 'win32', home), undefined)
    writeFileSync(join(home, '.local', 'bin', 'claude.exe'), '')
    assert.equal(locateClaude({ PATH: bin }, 'win32', home), join(home, '.local', 'bin', 'claude.exe'))
    writeFileSync(join(bin, 'claude.exe'), '')
    assert.equal(locateClaude({ PATH: bin }, 'win32', home), join(bin, 'claude.exe'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('limit-signin 13: no claude executable found: the run fails before any change and never spawns a bare name', async () => {
  const t = make({ locate: true, baseEnv: { PATH: '' } })
  try {
    await t.sut.start({ email: NEW })
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'failed')
    assert.match(t.pins.at(-1).note, /claude.*not found/i)
    assert.match(t.pins.at(-1).note, /nothing was changed/i)
    assert.equal(t.specs.length, 0)
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
    assert.equal(existsSync(BACKUP(t)) ? readdirSync(BACKUP(t)).length : 0, 0)
  } finally { t.cleanup() }
})

test('limit-signin 6c: the CLI output of a rejected code stays in the local log; the card gets a fixed reason', async () => {
  const t = make()
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('BAD-s3cr3tvalue')
    await t.sut.whenDone()
    const note = t.pins.at(-1).note
    assert.match(note, /rejected/i)
    assert.doesNotMatch(note, /Invalid code/)
    assert.ok(t.logs.some((l) => /Invalid code/.test(l)), 'the detail is kept in the local log')
    assert.ok(!everything(t).includes('s3cr3tvalue'))
  } finally { t.cleanup() }
})

// Cycle 3 regression Medium: a cancel/timeout while start() still waits for a recovery stops the run before any change: the card must say nothing was changed.
test('limit-signin 16: cancel while a recovery is pending: nothing was changed, no "restored" claim', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  const t = make({ fs: { readdir: async (...a) => { await gate; return readdirAsync(...a) } } })
  try {
    t.sut.recoverStranded()
    assert.equal((await t.sut.start({ email: NEW })).ok, true)
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(await t.sut.cancel(), { ok: true })
    await t.sut.whenDone()
    const note = t.pins.at(-1).note
    assert.match(note, /nothing was changed/i)
    assert.doesNotMatch(note, /restored from backup/i)
    assert.equal(t.specs.length, 0)
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
  } finally { release?.(); t.cleanup() }
})

// Cycle 3 security Medium: when finish() keeps the backup because the restore failed, the marker must not stay a retryable plan (a later recovery could overwrite a newer login).
test('limit-signin 17: a failed restore marks the kept backup as kept; recoverStranded then leaves it and the live files alone', async () => {
  let failRestore = false
  let t
  t = make({ fs: { copyFile: async (from, to) => {
    if (failRestore && to === join(t.defaultDir, '.credentials.json')) throw Object.assign(new Error('x'), { code: 'EBUSY' })
    return copyFile(from, to)
  } } })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    failRestore = true
    await t.sut.cancel()
    await t.sut.whenDone()
    assert.match(t.pins.at(-1).note, /restoring failed/i)
    const [stamp] = readdirSync(BACKUP(t))
    assert.equal(JSON.parse(t.read(join(BACKUP(t), stamp, 'RUN.json'))).kept, true)
    failRestore = false
    assert.equal(existsSync(join(t.defaultDir, '.credentials.json')), false, 'the logout removed it and the restore failed')
    assert.deepEqual(await t.sut.recoverStranded(), { recovered: 0, kept: 1, skipped: 0, pruned: 0 })
    assert.equal(existsSync(join(t.defaultDir, '.credentials.json')), false, 'not restored by a later recovery')
    assert.equal(readdirSync(BACKUP(t)).length, 1)
  } finally { t.cleanup() }
})

// Cycle 3 Low: a fresh marker of this very process belongs to a run of another instance here (hub and app): never recovered under it.
test('limit-signin 18: a fresh marker with this process\' pid but no run of this instance is skipped', async () => {
  const t = make()
  try {
    const dir = strand(t, { marker: markerOf(t, { pid: process.pid, startedAt: Date.now() - 60_000 }) })
    assert.deepEqual(await t.sut.recoverStranded(), { recovered: 0, kept: 0, skipped: 1, pruned: 0 })
    assert.equal(existsSync(dir), true)
  } finally { t.cleanup() }
})

test('limit-signin 18b: a marker of this process older than budget plus slack is stale: recovered', async () => {
  const t = make()
  try {
    const dir = strand(t, { marker: markerOf(t, { pid: process.pid, startedAt: Date.now() - 3_600_000 }) })
    assert.equal((await t.sut.recoverStranded()).recovered, 1)
    assert.equal(existsSync(dir), false)
  } finally { t.cleanup() }
})

// Cycle 3b security Medium 3: an account folder that already exists keeps everything but the login files (no wholesale replace and delete).
test('limit-signin 20: Mode A: an existing account folder keeps its other files; only the login files are replaced; no .old-/.limit- folders are left', async () => {
  const t = make({ modeA: true })
  try {
    const existing = join(t.accountsDir, accountId(NEW))
    mkdirSync(join(existing, 'projects'), { recursive: true })
    writeFileSync(join(existing, 'projects', 'keep.txt'), 'keep')
    writeFileSync(join(existing, 'history.txt'), 'history')
    writeFileSync(join(existing, '.credentials.json'), JSON.stringify({ email: 'stale@x.com' }))
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'signed-in')
    assert.equal(t.read(join(existing, 'projects', 'keep.txt')), 'keep')
    assert.equal(t.read(join(existing, 'history.txt')), 'history')
    assert.equal(JSON.parse(t.read(join(existing, '.credentials.json'))).email, 'new@x.com')
    assert.deepEqual(readdirSync(t.accountsDir).filter((n) => /\.limit-|\.old-/u.test(n)), [])
  } finally { t.cleanup() }
})

// Cycle 3b security Medium 1: the staging folder of a run is in the marker, and recovery removes it (it holds a live token of the new account).
test('limit-signin 21: Mode A: the marker names the staging folder, which exists while the run waits for the code', async () => {
  const t = make({ modeA: true })
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    const [stamp] = readdirSync(BACKUP(t))
    const marker = JSON.parse(t.read(join(BACKUP(t), stamp, 'RUN.json')))
    assert.equal(typeof marker.staging, 'string')
    assert.equal(dirname(marker.staging), t.accountsDir)
    assert.equal(basename(marker.staging).startsWith(`${accountId(NEW)}.limit-`), true)
    assert.match(basename(marker.staging), /\.limit-[0-9a-f]{8}$/u)
    assert.equal(existsSync(marker.staging), true)
    await t.sut.cancel()
    assert.equal(existsSync(marker.staging), false)
  } finally { t.cleanup() }
})

test('limit-signin 21b: recoverStranded removes the staging folder of a run that died, and still restores the login', async () => {
  const t = make()
  try {
    const staging = join(t.accountsDir, 'new-at-x.com.limit-abcdef12')
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, '.credentials.json'), JSON.stringify({ email: 'new@x.com' }))
    const dir = strand(t, { marker: markerOf(t, { staging }) })
    rmSync(join(t.defaultDir, '.credentials.json'), { force: true })
    assert.equal((await t.sut.recoverStranded()).recovered, 1)
    assert.equal(existsSync(staging), false)
    assert.equal(existsSync(dir), false)
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
  } finally { t.cleanup() }
})

test('limit-signin 21c: a marker whose staging is not one of our staging folders is kept and deletes nothing', async () => {
  const t = make()
  try {
    const victim = join(t.tmp, 'victim')
    mkdirSync(victim)
    writeFileSync(join(victim, 'a.txt'), 'a')
    const a = strand(t, { name: 'a', marker: markerOf(t, { staging: victim }) })
    const b = strand(t, { name: 'b', marker: markerOf(t, { staging: t.oldFolder }) }) // a real account folder: not a staging name
    const c = strand(t, { name: 'c', marker: markerOf(t, { staging: 5 }) })
    assert.deepEqual(await t.sut.recoverStranded(), { recovered: 0, kept: 3, skipped: 0, pruned: 0 })
    assert.equal(t.read(join(victim, 'a.txt')), 'a')
    assert.equal(existsSync(join(t.oldFolder, '.credentials.json')), true)
    for (const dir of [a, b, c]) assert.equal(existsSync(dir), true)
  } finally { t.cleanup() }
})

// Cycle 3b security Medium 2: one run at a time across instances (app and hub in one process) and processes: a lock file next to the backups.
const LOCK = (t) => join(t.dshHome, 'claude-code', 'limit-signin.lock')
test('limit-signin 22: a second instance on the same DSH home is busy while the first runs, and free after it ended', async () => {
  const t1 = make()
  const t2 = make({ shareWith: t1 })
  try {
    assert.equal((await t1.sut.start({ email: NEW })).ok, true)
    await awaitCode(t1)
    assert.deepEqual(await t2.sut.start({ email: 'other@x.com' }), { ok: false, error: 'busy' })
    assert.equal(t2.specs.length, 0)
    assert.equal(t2.sut.state().running, false)
    await t1.sut.cancel()
    assert.equal(existsSync(LOCK(t1)), false, 'the lock is released')
    assert.equal((await t2.sut.start({ email: 'other@x.com' })).ok, true)
    await awaitCode(t2)
    await t2.sut.cancel()
  } finally { t1.cleanup(); t2.cleanup() }
})

test('limit-signin 22b: a lock of another live process younger than budget plus slack means busy; a dead pid or an old lock is stale', async () => {
  const t = make({ pidAlive: (pid) => pid === 424242 })
  try {
    mkdirSync(dirname(LOCK(t)), { recursive: true })
    writeFileSync(LOCK(t), JSON.stringify({ pid: 424242, startedAt: Date.now() - 60_000 }))
    assert.deepEqual(await t.sut.start({ email: NEW }), { ok: false, error: 'busy' })
    writeFileSync(LOCK(t), JSON.stringify({ pid: 424242, startedAt: Date.now() - 3_600_000 }))
    assert.equal((await t.sut.start({ email: NEW })).ok, true, 'a reused pid with an old lock')
    await awaitCode(t)
    await t.sut.cancel()
    writeFileSync(LOCK(t), JSON.stringify({ pid: 31337, startedAt: Date.now() - 1000 }))
    assert.equal((await t.sut.start({ email: NEW })).ok, true, 'a dead pid')
    await awaitCode(t)
    await t.sut.cancel()
  } finally { t.cleanup() }
})

test('limit-signin 22c: a leftover lock of this process that no instance holds is stale', async () => {
  const t = make()
  try {
    mkdirSync(dirname(LOCK(t)), { recursive: true })
    writeFileSync(LOCK(t), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 1000 }))
    assert.equal((await t.sut.start({ email: NEW })).ok, true)
    await awaitCode(t)
    await t.sut.cancel()
  } finally { t.cleanup() }
})

test('limit-signin 22d: the lock is released after a failed run and after a success', async () => {
  const t = make()
  try {
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('BAD')
    await t.sut.whenDone()
    assert.equal(existsSync(LOCK(t)), false)
    await t.sut.start({ email: NEW })
    await awaitCode(t)
    await t.sut.code('GOOD')
    await t.sut.whenDone()
    assert.equal(t.sut.state().state, 'signed-in')
    assert.equal(existsSync(LOCK(t)), false)
  } finally { t.cleanup() }
})

// Cycle 3 Low: Windows paths compare case-insensitively (a differently cased spelling of the same file must not be refused).
test('limit-signin 19: on Windows an allowed path in another letter case is still allowed', { skip: process.platform !== 'win32' }, async () => {
  const t = make()
  try {
    const odd = join(dirname(join(t.defaultDir, '.credentials.json')).toUpperCase(), '.credentials.json')
    const dir = strand(t, { marker: markerOf(t, { saved: [[odd, '.credentials.json']] }) })
    rmSync(join(t.defaultDir, '.credentials.json'), { force: true })
    assert.equal((await t.sut.recoverStranded()).recovered, 1)
    assert.equal(JSON.parse(t.read(join(t.defaultDir, '.credentials.json'))).email, OLD)
    assert.equal(existsSync(dir), false)
  } finally { t.cleanup() }
})