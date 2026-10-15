/**
 * ensureHub (docs/hub.md 8.1, 8.2, 10): find the hub (hub.json plus a health probe that must answer with the hubId hub.json names, so a
 * foreign program on the port is never taken for it), else start one under an atomic lock file (flag wx; stale when its holder is dead or
 * older than 30 s) as a detached hidden node process, and poll its health. Only a strictly newer plugin protocol restarts an older hub
 * (POST /hub/v1/shutdown with the agent secret); a hub too new for this agent means standalone with a notice. Every side effect is
 * injected. Answers { mode: 'hub', info, baseUrl, spawned } or { mode: 'standalone', status: 'unavailable' | 'hub-newer', reason, notice? }.
 * createReconnector retries while the hub is not there (60 s, doubling to 10 min).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import http from 'node:http'
import { closeSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readText } from '../hub/atomic-file.js'
import { probeHealth } from '../hub/probe.js'
import { MIN_HUB_PROTOCOL, PROTOCOL } from '../hub/protocol.js'
import { resolveNodeExe } from './node-exe.js'

export const DEFAULT_HUB_PORT = 47615
const POLL_MS = 150
const START_MS = 10_000
const LOCK_STALE_MS = 30_000
const STOP_WAIT_MS = 5000
const LOG_CAP = 256 * 1024
/** What the hub child needs from the environment: nothing else (no tokens, no DSH variables but the home) is handed on. */
const ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'DSH_HOME']

const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535
/** The hub port: config hubPort, else env DSH_RQ_HUB_PORT, else 47615. */
export function hubPortOf({ hubPort, env = process.env } = {}) {
  if (validPort(hubPort)) return hubPort
  const fromEnv = /^\d{1,5}$/.test(env.DSH_RQ_HUB_PORT ?? '') ? Number(env.DSH_RQ_HUB_PORT) : NaN
  return validPort(fromEnv) ? fromEnv : DEFAULT_HUB_PORT
}

const defaultFs = {
  readText,
  writeExclusive: (file, text) => writeFileSync(file, text, { flag: 'wx' }),
  remove: (file) => rmSync(file, { force: true }),
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  openLog(file) {
    let size = 0
    try { size = statSync(file).size } catch { /* new file */ }
    return openSync(file, size > LOG_CAP ? 'w' : 'a')
  },
  closeLog: (fd) => closeSync(fd),
}

function pidAliveDefault(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function postDefault(port, path, body, secret) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', agent: false, timeout: 3000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: 'Bearer ' + secret } }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(payload)
  })
}

const parse = (text) => { try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : undefined } catch { return undefined } }
const unavailable = (reason) => ({ mode: 'standalone', status: 'unavailable', reason })
const reasonOf = (error) => String(error?.code ?? error?.message ?? 'error').slice(0, 80)

/**
 * @param {{ stateDir: string, port: number, hubMain?: string, hubNode?: string, protocol?: number, minHubProtocol?: number, pid?: number,
 *   fs?: typeof defaultFs, spawn?: Function, probe?: (port: number) => Promise<any>, post?: Function, sleep?: (ms: number) => Promise<void>,
 *   now?: () => number, pidAlive?: (pid: number) => boolean, nodeExe?: (opts: object) => any, env?: Record<string, string | undefined>, log?: (line: string) => void }} opts
 */
export function createLauncher({ stateDir, port, hubMain = fileURLToPath(new URL('../hub/main.js', import.meta.url)), hubNode, protocol = PROTOCOL, minHubProtocol = MIN_HUB_PROTOCOL, pid = process.pid, fs = defaultFs, spawn = nodeSpawn, probe = probeHealth, post = postDefault, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, pidAlive = pidAliveDefault, nodeExe = resolveNodeExe, env = process.env, log = () => {} }) {
  const hubJson = join(stateDir, 'hub.json')
  const lockFile = join(stateDir, 'hub.lock')
  let inflight

  /** The running hub: hub.json names it and its health answers with that hubId. */
  async function discover() {
    const info = parse(fs.readText(hubJson))
    if (!info || !validPort(info.port)) return undefined
    const health = await probe(info.port)
    return health && health.hubId === info.hubId ? { info, health } : undefined
  }

  const lockText = () => JSON.stringify({ pid, ts: now() })
  const tryLock = (text) => { try { fs.writeExclusive(lockFile, text); return true } catch (error) { if (error?.code === 'EEXIST') return false; throw error } }
  const releaseLock = (text) => { if (fs.readText(lockFile) === text) fs.remove(lockFile) }
  /** True while the lock belongs to a live launcher that took it less than 30 s ago. */
  function lockActive() {
    const lock = parse(fs.readText(lockFile))
    return !!lock && Number.isInteger(lock.pid) && Number.isFinite(lock.ts) && now() - lock.ts < LOCK_STALE_MS && pidAlive(lock.pid)
  }

  const ready = (found, state) => ({ mode: 'hub', info: { pid: found.info.pid, port: found.info.port, hubId: found.info.hubId, protocol: found.health.protocol, version: found.health.version }, baseUrl: 'http://127.0.0.1:' + found.info.port, spawned: state.spawned })

  /** Compares the protocols (8.2): too new for us, too old for us (upgrade, once), or fine. */
  async function decide(found, state) {
    const hubProtocol = Number(found.health.protocol)
    if (protocol < hubProtocol - 1) return { mode: 'standalone', status: 'hub-newer', reason: 'the hub is newer than this app', notice: 'hub is newer, restart DSH' }
    if (minHubProtocol <= hubProtocol) return ready(found, state)
    if (state.upgraded) return unavailable('the hub did not upgrade')
    return upgrade(found, state)
  }

  async function upgrade(found, state) {
    const secret = fs.readText(join(stateDir, 'hub.secret'))?.trim()
    if (!secret) return unavailable('could not restart the hub (no secret file)')
    log('restarting the hub for a newer protocol')
    let answer
    try { answer = await post(found.info.port, '/hub/v1/shutdown', { reason: 'upgrade', hubId: found.info.hubId }, secret) } catch (error) { return unavailable('could not restart the hub (' + reasonOf(error) + ')') }
    if (answer?.status !== 200) return unavailable('could not restart the hub (refused)')
    for (let waited = 0; waited <= STOP_WAIT_MS; waited += POLL_MS) {
      const health = await probe(found.info.port)
      if (!health || health.hubId !== found.info.hubId) return attempt({ ...state, upgraded: true })
      await sleep(POLL_MS)
    }
    return unavailable('could not restart the hub (it did not stop)')
  }

  /** Waits for the hub of a launcher that holds the lock: hub.json plus health, up to 10 s; undefined when its lock went away. */
  async function waitForOther(state) {
    for (let waited = 0; waited < START_MS; waited += POLL_MS) {
      const found = await discover()
      if (found) return decide(found, state)
      if (!lockActive()) return undefined
      await sleep(POLL_MS)
    }
    return unavailable('another app is starting the hub and it did not answer in time')
  }

  async function startHub(state) {
    const resolved = nodeExe({ hubNode })
    if (resolved.error) return unavailable(resolved.error)
    let fd
    let child
    try {
      fs.mkdir(stateDir)
      fd = fs.openLog(join(stateDir, 'hub-process.log'))
      const childEnv = Object.fromEntries(ENV_KEYS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]))
      Object.assign(childEnv, resolved.env)
      child = spawn(resolved.exe, [hubMain, '--state-dir', stateDir, '--port', String(port)], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: childEnv })
      child.unref?.()
    } catch (error) { return unavailable('could not start node (' + reasonOf(error) + ')') } finally { if (fd !== undefined) { try { fs.closeLog(fd) } catch { /* already closed */ } } }
    state.spawned = true
    let failure
    const onExit = (code) => { if (code !== 0 && code !== null) failure = code === 2 ? 'the port is taken by another program' : 'the hub process exited (code ' + code + ')' }
    const onError = (error) => { failure = 'could not start node (' + reasonOf(error) + ')' }
    child.once?.('exit', onExit)
    child.once?.('error', onError)
    try {
      for (let waited = 0; waited < START_MS; waited += POLL_MS) {
        await sleep(POLL_MS)
        if (failure) return unavailable(failure)
        const found = await discover()
        if (found) return decide(found, state)
      }
      return unavailable('the hub did not answer within 10 s')
    } finally { child.off?.('exit', onExit); child.off?.('error', onError) }
  }

  async function attempt(state) {
    const running = await discover()
    if (running) return decide(running, state)
    for (let round = 0; round < 4; round++) {
      fs.mkdir(stateDir)
      const mine = lockText()
      if (tryLock(mine)) {
        try {
          const again = await discover() // another launcher may have finished between the check and the lock
          if (again) return await decide(again, state)
          return await startHub(state)
        } finally { releaseLock(mine) }
      }
      if (lockActive()) {
        const waited = await waitForOther(state)
        if (waited) return waited
      } else fs.remove(lockFile)
    }
    return unavailable('could not take the start lock')
  }

  return {
    ensureHub() {
      inflight ??= attempt({ spawned: false, upgraded: false }).then((r) => { log(r.mode === 'hub' ? 'hub ready' : 'no hub: ' + r.reason); return r }, (error) => unavailable(reasonOf(error))).finally(() => { inflight = undefined })
      return inflight
    },
  }
}

/** Delay before retry number n (0 = the first): 60 s, doubling, capped at 10 min. */
export const retryDelayMs = (failures, { min = 60_000, max = 600_000 } = {}) => Math.min(max, min * 2 ** failures)

/**
 * Keeps trying ensureHub while the hub is not there: run() tries now and schedules the next try after every miss; kick() starts over at
 * the shortest delay (the hub was just lost); stop() cancels. onResult hears every answer, hub or not.
 */
export function createReconnector({ ensureHub, onResult = () => {}, retryMs, setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout }) {
  let failures = 0
  let timer
  let stopped = false
  let running
  const clear = () => { if (timer !== undefined) { cancel(timer); timer = undefined } }
  function run() {
    clear()
    running ??= (async () => {
      let result
      try { result = await ensureHub() } catch (error) { result = unavailable(reasonOf(error)) }
      if (stopped) return result
      try { onResult(result) } catch { /* a bad listener must not stop the retries */ }
      if (result.mode === 'hub') failures = 0
      else { timer = later(() => { timer = undefined; void run() }, retryDelayMs(failures++, retryMs)); timer?.unref?.() }
      return result
    })().finally(() => { running = undefined })
    return running
  }
  return {
    run,
    kick() { failures = 0; stopped = false; void run() },
    stop() { stopped = true; clear() },
  }
}
