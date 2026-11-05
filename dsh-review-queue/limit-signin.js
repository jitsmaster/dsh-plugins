/**
 * The "session limit" sign-out / sign-in run (design: vault "Session Limit Re-Auth Design Spec" 3.3). One run at a time:
 * backup -> `claude auth logout` (+ status must say loggedIn:false) -> `claude auth login --claudeai --email=<e>` in a private browser window
 * -> the user pastes the code (written to the login child's stdin only) -> `claude auth status` must say loggedIn:true AND the typed email.
 * Any failure, the budget and cancel() restore the backup. Progress goes to the pinned card through `pinned.set({ state, note })`; notes never hold
 * a secret (no code, no link, no token). Everything with a side effect is an injected seam so tests use a fake `claude` and temp dirs.
 *
 * Mode A (an activeAccount that is signed in, from `accounts.status()`): logout runs on that account's folder, the new email logs in to a NEW staging
 * folder that is moved to <accounts>/<accountId(email)> after verification (so a folder never holds another account than its name). Then
 * `setActiveAccount(email)` and `accounts.makeDefault(email)`. Mode D (otherwise): the default ~/.claude login, CLAUDE_CONFIG_DIR not set.
 */
import { spawn as cpSpawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { writeLauncher } from './limit-browser.js'

export const BUDGET_MS = 600_000
const CODE_MAX = 2000
const EMAIL_MAX = 254
const COMMAND_MS = 30_000
const NOTE_REASON_MAX = 130
const CREDENTIALS_FILE = '.credentials.json'
const SETTINGS_FILE = '.claude.json'
const MARKER_FILE = 'RUN.json' // in the backup folder: the restore plan of the run, so a crashed run can be undone at the next start (recoverStranded)
const MARKER_MAX = 65_536 // a marker is a few hundred bytes; a bigger one is not ours and is not read
const STATE_FILES = new Set([CREDENTIALS_FILE, SETTINGS_FILE])
const ACCOUNT_FOLDER = /^[a-z0-9][a-z0-9._-]*$/u
const STAGING_FOLDER = /^[a-z0-9][a-z0-9._-]*\.limit-[0-9a-f]{8}$/u // the staging folder of a Mode A login (named by us, recorded in the marker)
const LOCK_FILE = 'limit-signin.lock' // next to the backups: one run at a time across instances (app and hub) and processes
const heldLocks = new Set() // lock paths held by an instance of THIS process (a lock file with our own pid and no entry here is a leftover)
const BACKUP_KEEP_MS = 7 * 86_400_000 // a backup folder without a marker (a run that never got that far) is pruned after a week
const STRAND_SLACK_MS = 120_000 // a live pid with a marker younger than budget + this is a run in another process
const KEEP_ENV = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'home', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata',
  'temp', 'tmp', 'tmpdir', 'username', 'user', 'logname', 'lang', 'lc_all', 'shell', 'programdata', 'programfiles', 'programfiles(x86)', 'programw6432',
  'number_of_processors', 'os'])

// ---- ports of DSH llm-claude-code/src/account.ts (keep equal; the test pins a real folder name) -------------------------------------------------
export const normalizeEmail = (email) => String(email).trim().toLowerCase()
export const isPlausibleEmail = (email) => /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/u.test(String(email).trim())
/** Stricter than DSH's plausibility check: the email goes into argv and onto cards (hub, phone), so no control, invisible, quote or shell characters. */
const UNSAFE_EMAIL = /[\p{Cc}\p{Cf}"'\\<>`%&|]/u
export function accountId(email) {
  const lower = normalizeEmail(email)
  const slug = lower.replaceAll('@', '-at-').replaceAll(/[^a-z0-9._-]+/gu, '-').replaceAll(/-{2,}/gu, '-').replaceAll(/^[-.]+|[-.]+$/gu, '').slice(0, 64).replaceAll(/[-.]+$/gu, '')
  const hash = createHash('sha256').update(lower).digest('hex').slice(0, 8)
  return slug === lower && slug.length > 0 ? slug : `${slug.length > 0 ? `${slug}-` : ''}${hash}`
}
const flatten = (text) => text.replaceAll('\u001b', ' ').replaceAll('\u0007', ' ').replaceAll('\u009c', ' ')
export function extractAuthorizeUrl(output) {
  for (const m of flatten(output).matchAll(/https:\/\/\S+(?=\s)/gu)) {
    try { const u = new URL(m[0]); if (u.protocol === 'https:' && u.pathname.endsWith('/oauth/authorize')) return u.href } catch { /* keep looking */ }
  }
  return undefined
}
const stripEscapes = (t) => t.replaceAll(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '').replaceAll(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
export function parseAuthStatus(output) {
  const a = output.indexOf('{'); const b = output.lastIndexOf('}')
  if (a < 0 || b <= a) return undefined
  try {
    const o = JSON.parse(output.slice(a, b + 1))
    if (typeof o !== 'object' || o === null || typeof o.loggedIn !== 'boolean') return undefined
    return { loggedIn: o.loggedIn, ...(typeof o.email === 'string' && o.email ? { email: o.email } : {}) }
  } catch { return undefined }
}
/** `<code>#<state>` as `claude auth login` wants it; a pasted code without the `#state` half gets it from the page's own state (DSH completeAuthCode). */
export function completeAuthCode(pasted, url) {
  const compact = pasted.replaceAll(/\s+/gu, '')
  const hash = compact.indexOf('#')
  if (compact.length === 0 || (hash >= 0 && hash < compact.length - 1)) return compact
  let state = null
  try { state = new URL(url).searchParams.get('state') } catch { /* as pasted */ }
  if (!state) return compact
  return `${hash >= 0 ? compact.slice(0, hash) : compact}#${state}`
}

// ---- default seams ---------------------------------------------------------------------------------------------------------------------------
/** Real process launcher: { file, args, env, cwd } -> { stdout, stderr, stdin, done: Promise<{ exitCode, error? }>, exited, kill() }. The env is used as given. */
export function spawnProcess({ file, args, env, cwd }) {
  const child = cpSpawn(file, args, { env, cwd: cwd ?? tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  const h = { stdout: child.stdout, stderr: child.stderr, stdin: child.stdin, exited: false, kill() { try { child.kill() } catch { /* gone */ } } }
  h.done = new Promise((resolve) => {
    child.once('error', (error) => { h.exited = true; resolve({ exitCode: null, error }) })
    child.once('close', (exitCode) => { h.exited = true; resolve({ exitCode }) })
  })
  return h
}
const defaultFs = { copyFile, chmod, mkdir, mkdtemp, rename, rm, readdir, readFile, stat, writeFile, exists: (p) => access(p).then(() => true, () => false) }
const defaultPidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' } }

/**
 * Where `claude` is: PATH, then ~/.local/bin (the installer's place, often not on PATH). undefined when it is not found: a bare name would be resolved from the
 * working directory first on Windows, and a `.cmd` cannot be spawned without a shell (never use one: the email would reach cmd.exe), so only `claude.exe` counts there.
 */
export function locateClaude(env = process.env, platform = process.platform, home = homedir()) {
  const names = platform === 'win32' ? ['claude.exe'] : ['claude']
  const dirs = [...String(env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d && isAbsolute(d)), join(home, '.local', 'bin')] // a relative entry resolves against the working directory: never used
  for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n)
  return undefined
}

class Stop extends Error {}
const clipText = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t)
const duration = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.max(1, Math.round(ms / 1000))} seconds`)

/**
 * The writer of llm-claude-code's live `activeAccount`: the host `settings` service (ctx.get('settings').mutate, server side; ctx.remote.settings is the browser namespace).
 * @param {{ mutate?: (ns: string, ops: object[]) => Promise<unknown> } | undefined} settings
 * @returns {((email: string) => Promise<unknown>) | undefined} undefined when there is no settings service with mutate
 */
export function activeAccountSetter(settings) {
  if (typeof settings?.mutate !== 'function') return undefined
  return (email) => settings.mutate('llm-claude-code', [{ op: 'set', path: ['activeAccount'], value: email }])
}

/**
 * @param {object} o seams (all optional): spawn, fs, now, claudeExecutable, accounts ({ status(), makeDefault(email) }), setActiveAccount(email),
 *   pinned ({ set({ state, note }) }), log, dshHome, defaultPaths ({ credentials, settings }), baseEnv, platform, launcherEnv, browserExists,
 *   budgetMs (default 10 minutes), codeReplyMs (silence allowed after the code, default 60 s).
 * @returns {{ start, code, cancel, state, whenDone }}
 */
export function createLimitSignIn(o = {}) {
  const spawn = o.spawn ?? spawnProcess
  const fs = { ...defaultFs, ...o.fs }
  const now = o.now ?? Date.now
  const log = o.log ?? (() => {})
  const baseEnv = o.baseEnv ?? process.env
  const platform = o.platform ?? process.platform
  const dshHome = o.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const accountsDir = join(dshHome, 'claude-code', 'accounts')
  const backupRoot = join(dshHome, 'claude-code', 'limit-backup')
  const defaults = o.defaultPaths ?? { credentials: join(homedir(), '.claude', CREDENTIALS_FILE), settings: join(homedir(), SETTINGS_FILE) }
  const budgetMs = o.budgetMs ?? BUDGET_MS
  const codeReplyMs = o.codeReplyMs ?? 60_000
  const commitStepMs = o.commitStepMs ?? 15_000
  const pidAlive = o.pidAlive ?? defaultPidAlive
  const homeDir = o.homeDir ?? homedir()
  const writeMarker = (r) => fs.writeFile(join(r.backupDir, MARKER_FILE), JSON.stringify(r.markerPlan), { mode: 0o600 })
  const lockPath = join(dshHome, 'claude-code', LOCK_FILE)
  /** Exclusive lock for a run: false when another instance or process runs one (a stale lock is taken over). Fails closed on a file error. */
  async function acquireLock() {
    try {
      await fs.mkdir(dirname(lockPath), { recursive: true })
      const body = JSON.stringify({ pid: process.pid, startedAt: now() })
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await fs.writeFile(lockPath, body, { flag: 'wx', mode: 0o600 }); heldLocks.add(lockPath); return true } catch (e) { if (e?.code !== 'EEXIST') throw e }
        let held
        try { held = JSON.parse(await fs.readFile(lockPath, 'utf8')) } catch { held = undefined }
        const fresh = typeof held?.pid === 'number' && typeof held.startedAt === 'number' && now() - held.startedAt < budgetMs + STRAND_SLACK_MS
        if (fresh && (held.pid === process.pid ? heldLocks.has(lockPath) : pidAlive(held.pid))) return false
        await fs.rm(lockPath, { force: true }) // stale: a dead pid, an old lock, or a leftover of this process
      }
      return false
    } catch (e) { log(`limit-signin: could not take the run lock (${e?.code ?? 'error'})`); return false }
  }
  async function releaseLock() {
    heldLocks.delete(lockPath)
    try { await fs.rm(lockPath, { force: true }) } catch (e) { log(`limit-signin: could not remove the run lock (${e?.code ?? 'error'})`) }
  }
  /** After the commit point the budget cannot abort (guard is not used): a host call that never settles must not wedge the run, so it is cut off (rejects, the caller's catch adds the manual note). */
  const bounded = (p) => {
    let timer
    const cut = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer')), commitStepMs); timer.unref?.() })
    return Promise.race([p, cut]).finally(() => clearTimeout(timer))
  }
  const setPin = (p) => { try { o.pinned?.set?.(p) } catch (e) { log('limit-signin: card update failed: ' + String(e?.message ?? e)) } }

  let run // the current run, or undefined
  let last = Promise.resolve()
  let recovering = Promise.resolve() // the recoverStranded() under way, if any
  let shown = { state: 'idle', note: '' }

  function setState(state, note) {
    shown = { state, note: note ?? shown.note }
    setPin(note === undefined ? { state } : { state, note })
  }

  /** Env of a child: the minimal inherited set, never CLAUDE_CONFIG_DIR from here, never a token; plus the given extras. */
  function childEnv(extra) {
    const env = {}
    for (const [k, v] of Object.entries(baseEnv)) if (KEEP_ENV.has(k.toLowerCase()) && v !== undefined) env[k] = v
    return { ...env, ...extra }
  }

  async function execute(r) {
    const guard = (p) => Promise.race([p, r.stopped])
    const tail = (text, secret) => {
      let t = stripEscapes(text).replaceAll(/https?:\/\/\S+/gu, '<link>').trim()
      // the whole `code#state` and each half alone (the CLI may echo only one half), longest first
      if (secret) for (const s of [secret, ...secret.split('#')].filter((x) => x.length >= 4).sort((a, b) => b.length - a.length)) t = t.replaceAll(s, '[code]')
      return t.slice(-120)
    }
    const launch = (args, env) => {
      const h = spawn({ file: r.exe, args, env, cwd: tmpdir() })
      r.children.add(h)
      let out = ''; let err = ''
      for (const [stream, add] of [[h.stdout, (c) => { out += c }], [h.stderr, (c) => { err += c }]]) {
        stream?.setEncoding?.('utf8')
        stream?.on('data', (c) => { add(String(c)); out = out.slice(-65_536); err = err.slice(-65_536) })
        stream?.on('error', () => {})
      }
      const exit = h.done.then((x) => x, (error) => ({ exitCode: null, error }))
      return { h, stdout: () => out, stderr: () => err, all: () => out + '\n' + err, exit }
    }
    const command = async (args, env) => {
      const c = launch(args, env)
      let timer
      const slow = new Promise((resolve) => { timer = setTimeout(() => resolve({ slow: true }), COMMAND_MS); timer.unref?.() })
      const x = await guard(Promise.race([c.exit, slow])).finally(() => clearTimeout(timer))
      if (x.slow) throw new Error(`claude ${args.slice(0, 2).join(' ')} did not answer in ${duration(COMMAND_MS)}`)
      return { ...x, stdout: c.stdout(), stderr: c.stderr() }
    }
    const statusOf = async (env) => parseAuthStatus((await command(['auth', 'status', '--json'], env)).stdout)

    r.untouched = true // until the backup is complete nothing has been changed: a failure here must not delete or "restore" anything
    if (!r.exe) throw new Error('claude was not found (looked on PATH and in ~/.local/bin)')

    // 1. which login, 2. backup
    setState('opening', 'Backing up the current login…')
    let folder // Mode A: the active account's folder
    try {
      const st = await guard(Promise.resolve(o.accounts?.status?.()))
      const active = st?.activeAccount && st.accounts?.find((a) => normalizeEmail(a.email) === normalizeEmail(st.activeAccount) && a.signedIn && /^[a-z0-9][a-z0-9._-]*$/u.test(String(a.id)))
      if (active) folder = join(accountsDir, active.id)
    } catch (e) { if (e instanceof Stop) throw e; log('limit-signin: accounts.status failed, using the default login') }
    r.mode = folder ? 'A' : 'D'
    const files = folder
      ? [[join(folder, CREDENTIALS_FILE), CREDENTIALS_FILE], [join(folder, SETTINGS_FILE), SETTINGS_FILE]]
      : [[defaults.credentials, CREDENTIALS_FILE], [defaults.settings, SETTINGS_FILE]]
    r.targets = [] // targets the backup SAW absent: on failure they are deleted (a login may have written them); a file the backup never reached is left alone
    const stamp = new Date(now()).toISOString().replaceAll(/[:.]/gu, '-')
    let dir = join(backupRoot, stamp)
    for (let n = 1; await fs.exists(dir); n++) dir = join(backupRoot, `${stamp}-${n}`)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    r.backupDir = dir
    for (const [src, name] of files) {
      if (!await fs.exists(src)) { r.targets.push(src); continue }
      const dest = join(dir, name)
      await fs.copyFile(src, dest)
      await fs.chmod?.(dest, 0o600).catch(() => {}) // best effort (no effect on Windows): the copy holds tokens
      r.saved.push([src, dest])
    }
    // The restore plan goes next to the copies BEFORE the logout: if this process dies from here on, the next start (recoverStranded) can undo the run. No secret, no email.
    r.markerPlan = { pid: process.pid, startedAt: now(), mode: r.mode, committed: false, saved: r.saved.map(([src, dest]) => [src, basename(dest)]), absent: [...r.targets] }
    await writeMarker(r)
    r.untouched = false // the backup is complete: from the logout on, a failure restores it
    r.backupName = stamp
    log(`limit-signin: mode ${r.mode}, backup of ${r.saved.length} file(s) made`)
    const targetEnv = folder ? { CLAUDE_CONFIG_DIR: folder } : {}

    // No credentials file to back up: if Claude still says it is signed in, the login lives elsewhere (OS keychain), logout could not be undone.
    if (!r.saved.some(([src]) => src === files[0][0])) {
      const present = await statusOf(childEnv(targetEnv))
      if (!present || present.loggedIn) {
        r.untouched = true
        throw new Error('the current login is not in a credentials file that can be backed up, so it could not be restored')
      }
    }

    // 3. logout, then status must say loggedIn:false
    setState('opening', 'Signing out of Claude Code…')
    await command(['auth', 'logout'], childEnv(targetEnv))
    const after = await statusOf(childEnv(targetEnv))
    if (!after) throw new Error('could not read the sign-in status after sign-out')
    if (after.loggedIn) throw new Error('sign-out did not take effect (Claude still reports it is signed in)')

    // 4. login in a private window
    let loginEnv = targetEnv
    if (folder) {
      await fs.mkdir(accountsDir, { recursive: true })
      // The staging folder will hold a live token of the new account: its name goes into the marker BEFORE it is created, so a crash can never strand it unrecorded.
      const staging = join(accountsDir, `${accountId(r.email)}.limit-${randomBytes(4).toString('hex')}`)
      r.markerPlan.staging = staging
      await writeMarker(r)
      r.staging = staging
      await fs.mkdir(staging, { mode: 0o700 })
      loginEnv = { CLAUDE_CONFIG_DIR: staging }
    }
    r.launcherDir = await fs.mkdtemp(join(tmpdir(), 'dsh-limit-'))
    const written = await writeLauncher(r.launcherDir, platform, o.launcherEnv ?? process.env, o.browserExists ?? existsSync)
    const hint = written.browser
      ? `A private ${written.browser.name} window opens. Sign in as ${r.email} and paste the code here.`
      : `Open the sign-in page in a private window, or clear the claude.ai cookies first, so the old account is not picked. Sign in as ${r.email}.`
    const login = launch(['auth', 'login', '--claudeai', `--email=${r.email}`], childEnv({ ...loginEnv, BROWSER: written.path }))
    const urlSeen = new Promise((resolve) => {
      const look = () => { const u = extractAuthorizeUrl(login.all()); if (u) resolve(u); return Boolean(u) }
      if (look()) return
      for (const s of [login.h.stdout, login.h.stderr]) s?.on('data', look)
    })
    const first = await guard(Promise.race([urlSeen.then((url) => ({ url })), login.exit.then((exit) => ({ exit }))]))
    if (first.exit) { log(`limit-signin: login output: ${tail(login.all())}`); throw new Error('the sign-in ended before showing the page') } // the CLI text stays in the local log, never on a card
    r.awaitingCode = true
    setState('awaiting-code', hint)
    const second = await guard(Promise.race([r.codeArrived.then((code) => ({ code })), login.exit.then((exit) => ({ exit }))]))
    let exit = second.exit
    let secret = ''
    r.awaitingCode = false
    if (second.code !== undefined) {
      secret = completeAuthCode(second.code, first.url)
      login.h.stdin?.write(`${secret}\n`)
      let timer
      const silent = new Promise((resolve) => { timer = setTimeout(() => resolve({ silent: true }), codeReplyMs); timer.unref?.() })
      const x = await guard(Promise.race([login.exit, silent])).finally(() => clearTimeout(timer))
      if (x.silent) throw new Error('Claude Code did not answer the code; copy the whole code from the page (it has a "#" in the middle)')
      exit = x
    } else setState('verifying', 'Checking the new login…')
    if (exit.error) throw new Error('Claude Code could not start')
    if (exit.exitCode !== 0) { log(`limit-signin: login output: ${tail(login.stderr().trim() ? login.stderr() : login.all(), secret)}`); throw new Error('the sign-in was rejected (the code may be wrong or expired)') }

    // 5. verify: loggedIn and the email we asked for
    const verifyEnv = childEnv(loginEnv)
    const st = await statusOf(verifyEnv)
    if (!st?.loggedIn) throw new Error('Claude Code reports it is not signed in after the login')
    if (!st.email) throw new Error('could not read which account signed in')
    if (normalizeEmail(st.email) !== r.email) throw new Error(`the browser signed in a different account, not ${r.email} (it kept another login)`) // the other email stays off the card (hub, phone)
    r.committed = true // the new login is in place and verified: a Cancel from here on is too late (cancel() answers no-run)
    // The marker says committed (a crash then keeps the new login: recoverStranded only drops the backup) only once the new login is in its final place:
    // Mode D right here, Mode A after the staging folder was moved.
    const markCommitted = async () => { r.markerPlan.committed = true; await writeMarker(r).catch((e) => log(`limit-signin: could not mark the run committed (${e?.code ?? 'error'})`)) }
    if (!folder) await markCommitted()

    // 6. Mode A: the staging folder becomes this account's own folder
    let note = `Signed in as ${r.email}.`
    const needsActive = ` Set activeAccount to ${r.email}.`
    if (folder) {
      if (!await fs.exists(join(r.staging, CREDENTIALS_FILE))) throw new Error('the login wrote no credentials file in the account folder')
      for (const h of r.children) h.kill()
      const finalDir = join(accountsDir, accountId(r.email))
      if (await fs.exists(finalDir)) {
        // The account folder already exists (re-sign-in, or switching back to an added account): it keeps everything but the login files (projects, history, settings).
        for (const name of STATE_FILES) {
          const from = join(r.staging, name)
          if (!await fs.exists(from)) continue
          const tmp = join(finalDir, `${name}.limit-${randomBytes(4).toString('hex')}.tmp`)
          try { await fs.copyFile(from, tmp); await fs.rename(tmp, join(finalDir, name)) } catch (e) { await fs.rm(tmp, { force: true }).catch(() => {}); throw new Error(`could not move the new login into place (${e?.code ?? 'error'})`) }
        }
        await fs.rm(r.staging, { recursive: true, force: true }).then(() => { r.staging = undefined }, () => {}) // kept in r.staging when it cannot be removed: finish() tries again
      } else {
        try { await fs.rename(r.staging, finalDir) } catch (e) { throw new Error(`could not move the new login into place (${e?.code ?? 'error'})`) }
        r.staging = undefined
      }
      await markCommitted()
      if (o.setActiveAccount) {
        try {
          const res = await bounded(o.setActiveAccount(r.email))
          if (res?.ok === false) note += needsActive // a Remote call resolves { ok: false } instead of throwing
        } catch { note += needsActive }
      } else note += needsActive
      if (o.accounts?.makeDefault) {
        try {
          const res = await bounded(o.accounts.makeDefault(r.email))
          if (res?.ok === false) note += ` The default ~/.claude login was not switched: ${clipText(String(res.reason ?? 'refused'), 90)}`
        } catch { note += ' The default ~/.claude login was not switched.' }
      }
    } else if (!o.accounts) note += needsActive
    return note
  }

  /** Card text for a failure: our own messages as written; an OS error (it has a `code`) only by its code, since its text carries local paths and the user name (the card goes to the hub and the phone). */
  const reasonOf = (error) => (error instanceof Stop ? error.message : typeof error?.code === 'string' ? `a file operation failed (${error.code})` : String(error?.message ?? error))

  async function finish(r, error) {
    // children first (no file is written while it is restored), then temp files, then the backup
    for (const h of r.children) h.kill()
    await Promise.all([...r.children].map((h) => Promise.race([h.done.catch(() => {}), new Promise((res) => { const t = setTimeout(res, 3000); t.unref?.() })])))
    for (const p of [r.launcherDir, r.staging]) if (p) await fs.rm(p, { recursive: true, force: true }).catch((e) => log(`limit-signin: could not remove a temp dir (${e?.code ?? 'error'})`))
    const dropBackup = async () => { if (r.backupDir) await fs.rm(r.backupDir, { recursive: true, force: true }).catch((e) => log(`limit-signin: could not remove the backup (${e?.code ?? 'error'})`)) }
    if (!error) { await dropBackup(); return } // the old token copy is not kept after a successful sign-in
    if (r.untouched) { // refused before anything was changed
      await dropBackup()
      setState('failed', `Sign-in not started: ${clipText(reasonOf(error), NOTE_REASON_MAX)}. Nothing was changed.`)
      log(`limit-signin: refused before any change (${String(error?.message ?? error).slice(0, 200)})`)
      return
    }
    let restored = true
    for (const [src, saved] of r.saved) {
      try { await fs.mkdir(join(src, '..'), { recursive: true }); await fs.copyFile(saved, src) } catch { restored = false }
    }
    const savedSources = new Set(r.saved.map(([src]) => src))
    for (const src of r.targets ?? []) {
      if (savedSources.has(src)) continue
      try { await fs.rm(src, { force: true }) } catch { restored = false } // the previous state had no such file: do not leave another account's login behind
    }
    if (restored) await dropBackup()
    else if (r.markerPlan) { // kept for a manual restore: the marker must not stay a plan a later recovery retries (it could overwrite a newer login)
      r.markerPlan.kept = true
      await writeMarker(r).catch((e) => log(`limit-signin: could not mark the backup as kept (${e?.code ?? 'error'})`))
    }
    const why = clipText(reasonOf(error), NOTE_REASON_MAX)
    setState('failed', `Sign-in failed: ${why}. ${restored ? 'Previous login restored from backup; if it no longer works, sign in again (sign-out can revoke its token).' : `Restoring failed; backup ${r.backupName}.`}`)
    log(`limit-signin: failed (${why}); restored=${restored}`)
  }

  return {
    /** @returns {Promise<{ ok: true, email: string } | { ok: false, error: 'bad-email' | 'busy' }>} */
    async start(input) {
      const raw = input?.email
      if (typeof raw !== 'string' || raw.trim().length > EMAIL_MAX || !isPlausibleEmail(raw) || UNSAFE_EMAIL.test(raw)) return { ok: false, error: 'bad-email' }
      if (run) return { ok: false, error: 'busy' }
      const email = normalizeEmail(raw)
      let abort
      const stopped = new Promise((_, reject) => { abort = (why) => reject(new Stop(why)) })
      stopped.catch(() => {})
      let release
      const codeArrived = new Promise((resolve) => { release = resolve })
      const r = { email, untouched: true, children: new Set(), saved: [], stopped, abort, codeArrived, release, awaitingCode: false, exe: o.claudeExecutable ?? locateClaude(baseEnv, platform, homeDir) }
      run = r // set before the first await: a second start() meanwhile is busy
      if (!await acquireLock()) { run = undefined; return { ok: false, error: 'busy' } }
      shown = { state: 'opening', note: '' }
      const timer = setTimeout(() => abort(`timed out after ${duration(budgetMs)}`), budgetMs)
      timer.unref?.()
      last = (async () => {
        let error
        let note
        try { await Promise.race([recovering, r.stopped]); note = await execute(r) } catch (e) { error = e }
        clearTimeout(timer)
        try { await finish(r, error) } catch (e) { log('limit-signin: finish failed: ' + String(e?.message ?? e).slice(0, 200)) } finally {
          await releaseLock()
          if (!error) { setState('signed-in', note); log('limit-signin: signed in') }
          run = undefined
        }
      })()
      return { ok: true, email }
    },
    /** The pasted code goes to the login child's stdin; only in state 'awaiting-code'. @returns {Promise<{ ok: boolean, error?: 'bad-code' | 'no-run' }>} */
    async code(text) {
      if (typeof text !== 'string' || text.trim().length === 0 || text.trim().length > CODE_MAX) return { ok: false, error: 'bad-code' }
      if (!run?.awaitingCode) return { ok: false, error: 'no-run' }
      run.awaitingCode = false
      setState('verifying', 'Checking the code…')
      run.release(text.trim())
      return { ok: true }
    },
    /** Stops the run, restores the backup; resolves once that is done. */
    async cancel() {
      if (!run || run.committed) return { ok: false, error: 'no-run' } // committed: the login is verified and kept, the run is only finishing
      run.abort('cancelled')
      await last
      return { ok: true }
    },
    /** { state, running, email?, mode?, note }. The live authorize link (OAuth state) is not exposed here. */
    state() {
      return { state: shown.state, running: Boolean(run), note: shown.note, ...(run ? { email: run.email, mode: run.mode } : {}) }
    },
    /**
     * Undoes runs that died (crash, kill, power loss) between the logout and the end: each backup folder with a RUN.json is restored (or, when the run had
     * already verified the new login, just dropped); one that cannot be restored is kept for the user. Folders without a marker older than a week are pruned.
     * Never touches the backup of a run live in this process, nor one of a live other process whose marker is younger than budget + slack.
     * @returns {Promise<{ recovered: number, kept: number, skipped: number, pruned: number }>}
     */
    recoverStranded() {
      const p = (async () => {
      const out = { recovered: 0, kept: 0, skipped: 0, pruned: 0 }
      let names
      try { names = (await fs.readdir(backupRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return out }
      const norm = (p) => { const x = resolve(p); return platform === 'win32' ? x.toLowerCase() : x } // Windows paths are case-insensitive
      const allowed = (src, name) => {
        if (basename(src) !== name || !STATE_FILES.has(name)) return false
        const s = norm(src)
        return s === norm(defaults.credentials) || s === norm(defaults.settings) || (dirname(dirname(s)) === norm(accountsDir) && ACCOUNT_FOLDER.test(basename(dirname(s))))
      }
      for (const name of names) {
        const dir = join(backupRoot, name)
        if (run?.backupDir === dir) { out.skipped++; continue }
        let plan
        try {
          const markerPath = join(dir, MARKER_FILE)
          if ((await fs.stat(markerPath)).size > MARKER_MAX) throw Object.assign(new Error('marker too large'), { code: 'EFBIG' })
          plan = JSON.parse(await fs.readFile(markerPath, 'utf8'))
        } catch (e) {
          if (e?.code === 'ENOENT') { // no marker: a run that never got past the copies, or a leftover; fresh ones may belong to a run starting right now
            try {
              if (now() - (await fs.stat(dir)).mtimeMs > BACKUP_KEEP_MS) { await fs.rm(dir, { recursive: true, force: true }); out.pruned++ }
            } catch { /* left for the next start */ }
          } else { out.kept++; log(`limit-signin: backup ${name} has an unreadable marker, kept`) }
          continue
        }
        const pairs = Array.isArray(plan?.saved) && plan.saved.every((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string' && allowed(p[0], p[1]))
        const absent = Array.isArray(plan?.absent) && plan.absent.every((p) => typeof p === 'string' && allowed(p, basename(p)))
        const stagingOk = plan?.staging === undefined || (typeof plan.staging === 'string' && dirname(norm(plan.staging)) === norm(accountsDir) && STAGING_FOLDER.test(basename(norm(plan.staging))))
        if (!plan || typeof plan !== 'object' || !pairs || !absent || !stagingOk || typeof plan.committed !== 'boolean' || typeof plan.pid !== 'number' || typeof plan.startedAt !== 'number') {
          out.kept++; log(`limit-signin: backup ${name} has an invalid marker, kept`); continue
        }
        if (plan.kept === true) { out.kept++; log(`limit-signin: backup ${name} is kept for a manual restore (an earlier restore failed), not retried`); continue }
        // a fresh marker of this very process belongs to a run of another instance here (app and hub), a live other pid to another process
        if ((plan.pid === process.pid || pidAlive(plan.pid)) && now() - plan.startedAt < budgetMs + STRAND_SLACK_MS) { out.skipped++; continue }
        // The staging folder of a Mode A login holds a live token of the new account: it never survives a dead run (the verified login is only ever kept once moved into place).
        if (plan.staging) await fs.rm(plan.staging, { recursive: true, force: true }).catch((e) => log(`limit-signin: could not remove a stranded staging folder (${e?.code ?? 'error'})`))
        let ok = true
        if (!plan.committed) {
          // A target changed after the run started is a login made since (by hand, before this start): the old token must not overwrite it, nothing is deleted.
          let newer = false
          // Only the credentials files count: .claude.json is rewritten by every running Claude session, so its mtime says nothing about a login.
          for (const p of [...plan.saved.map((s) => s[0]), ...plan.absent].filter((x) => basename(x) === CREDENTIALS_FILE)) { try { if ((await fs.stat(p)).mtimeMs > plan.startedAt) newer = true } catch { /* absent: nothing newer */ } }
          if (newer) { out.kept++; log(`limit-signin: backup ${name} kept: a newer login exists since the run died, not overwritten`); continue }
          for (const [src, file] of plan.saved) {
            try { await fs.mkdir(dirname(src), { recursive: true }); await fs.copyFile(join(dir, file), src) } catch { ok = false }
          }
          const restored = new Set(plan.saved.map(([src]) => src))
          for (const src of plan.absent) {
            if (restored.has(src)) continue
            try { await fs.rm(src, { force: true }) } catch { ok = false }
          }
        }
        if (!ok) { out.kept++; log(`limit-signin: could not restore the stranded backup ${name}; kept for a manual restore`); continue }
        try { await fs.rm(dir, { recursive: true, force: true }); out.recovered++; log(`limit-signin: recovered a stranded run (${plan.committed ? 'new login kept' : `restored ${plan.saved.length} file(s)`}), backup removed`) } catch { out.kept++ }
      }
      return out
      })()
      recovering = p.catch(() => {}) // a run waits for it (it writes the same credential files)
      return p
    },
    /** Resolves when the current run (if any) has ended. */
    whenDone: () => last,
  }
}
