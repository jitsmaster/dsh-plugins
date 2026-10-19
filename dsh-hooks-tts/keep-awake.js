/**
 * Keeps the computer awake for as long as the DSH server runs (settings keepAwake, keepDisplayOn).
 *
 * The OS request is held by a tiny helper process that this module starts and kills:
 *  - win32: scripts/keep-awake.ps1 (SetThreadExecutionState; it exits by itself when the DSH pid is gone)
 *  - darwin: caffeinate -i -w <pid> (also ends with the DSH pid)
 *  - linux: systemd-inhibit ... sleep infinity (killed on stop; a hard-killed DSH leaves it until the next login/reboot)
 * Everything is best effort: a missing command, a failing spawn or a dead helper is logged and never thrown into the server.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const DEFAULT_POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const MAX_RESTARTS = 3
const RESTART_DELAY_MS = 2000
/** A helper that lived this long is considered healthy: its restart budget starts over. */
const HEALTHY_MS = 60_000

/**
 * @param {object} deps
 * @param {{ get(): object, subscribe?(listener: (next: object, previous: object) => void): () => void }} deps.settings
 * @param {(line: string) => void} [deps.log]
 */
export function createKeepAwake({
  platform = process.platform,
  spawn = nodeSpawn,
  settings,
  log = () => {},
  pid = process.pid,
  script = join(ROOT, 'scripts', 'keep-awake.ps1'),
  powershell = DEFAULT_POWERSHELL,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
}) {
  let current
  let startedAt = 0
  let restartTimer
  let restarts = 0
  let failed = false
  let warnedUnsupported = false
  let unsubscribe
  let running = false

  const say = (line) => { try { log('keep-awake: ' + line) } catch { /* logging never breaks the host */ } }
  const wants = () => settings.get().keepAwake === true
  const displayOn = () => settings.get().keepDisplayOn === true

  /** Command and args of the helper for this platform, or undefined. */
  function commandFor() {
    if (platform === 'win32') return { cmd: powershell, args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentPid', String(pid), ...(displayOn() ? ['-DisplayOn'] : [])] }
    if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-i', '-w', String(pid)] }
    if (platform === 'linux') return { cmd: 'systemd-inhibit', args: ['--what=sleep', '--who=DSH', '--why=DSH is running', 'sleep', 'infinity'] }
    return undefined
  }

  function fail(reason) {
    failed = true
    current = undefined
    say(reason)
  }

  function launch() {
    const command = commandFor()
    if (!command) {
      if (!warnedUnsupported) { warnedUnsupported = true; say('not supported on ' + platform) }
      return
    }
    let child
    try {
      child = spawn(command.cmd, command.args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
    } catch (error) { fail('cannot start the helper: ' + String(error?.message ?? error)); return }
    current = child
    startedAt = now()
    child.unref?.()
    child.on?.('error', (error) => { if (child === current) fail('helper failed: ' + String(error?.message ?? error)) })
    child.on?.('exit', () => { if (child === current) onExit() })
    say('started (' + platform + ', helper pid ' + child.pid + ')')
  }

  function onExit() {
    current = undefined
    if (now() - startedAt >= HEALTHY_MS) restarts = 0
    if (restarts >= MAX_RESTARTS) { failed = true; say('helper keeps exiting, giving up'); return }
    restarts++
    restartTimer = setTimer(() => { restartTimer = undefined; if (running && wants() && !current && !failed) launch() }, RESTART_DELAY_MS)
    restartTimer?.unref?.()
  }

  function halt() {
    clearTimer(restartTimer)
    restartTimer = undefined
    const child = current
    current = undefined // before kill(): its exit event is then ignored
    if (child) {
      try { child.kill() } catch { /* already gone */ }
      say('stopped')
    }
  }

  function reconcile(next, previous) {
    if (!running) return
    if (!wants()) { halt(); failed = false; return }
    if (failed) return
    if (!current && !restartTimer) { restarts = 0; launch(); return }
    if (current && Boolean(next?.keepDisplayOn) !== Boolean(previous?.keepDisplayOn)) { halt(); restarts = 0; launch() }
  }

  return {
    start() {
      if (running) return
      running = true
      try { unsubscribe = settings.subscribe?.((next, previous) => reconcile(next, previous), (error) => say('setting change failed: ' + String(error?.message ?? error))) } catch { /* no live updates */ }
      if (wants()) launch()
    },
    stop() {
      running = false
      try { unsubscribe?.() } catch { /* ignore */ }
      unsubscribe = undefined
      halt()
      failed = false
      restarts = 0
    },
    status() {
      return { active: Boolean(current), platform, ...(current?.pid !== undefined ? { pid: current.pid } : {}) }
    },
  }
}
