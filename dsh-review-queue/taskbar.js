/**
 * Shows how many items wait in the Task list as a red badge on the app's taskbar button (Windows only), so a glance at the taskbar
 * says whether anything changed. The Desktop window belongs to the Electron main process, which this plugin cannot reach, so
 * scripts/taskbar-badge.ps1 finds the window up this process's parent chain and sets the overlay icon through the shell
 * (ITaskbarList3). Without such a window (DSH opened in a browser) the script exits 3 and nothing happens. The count is the one the
 * Task list header shows (queue.count().total: a todo that is only starting does not count).
 *
 * Changes are debounced and a count equal to the last applied one is not sent again. A window that does not exist yet (the host
 * starts before the window) is retried a few times.
 */
import { existsSync } from 'node:fs'

const NO_WINDOW = 3

/**
 * @param {{ queue: { count: () => { total: number }, onChange: (l: () => void) => () => void }, spawn: Function, script: string, powershell: string,
 *   pid?: number, platform?: string, debounceMs?: number, retryMs?: number, maxRetries?: number, exists?: (p: string) => boolean, log?: (line: string) => void,
 *   setTimer?: Function, clearTimer?: Function }} deps
 */
export function createTaskbarBadge({ queue, spawn, script, powershell, pid = process.pid, platform = process.platform, debounceMs = 400, retryMs = 20_000, maxRetries = 5, exists = existsSync, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (platform !== 'win32') return { enabled: false, refresh() {}, dispose: async () => {} }
  if (!exists(script)) { log('taskbar badge: script missing, no badge'); return { enabled: false, refresh() {}, dispose: async () => {} } }

  let applied // the count the taskbar shows now (undefined: not known)
  let timer
  let retries = 0
  let running // promise of the PowerShell run in flight
  let pending // a count waiting for the run in flight
  let disposed = false
  let loggedNoWindow = false

  const totalNow = () => { try { const n = Number(queue.count()?.total); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 } catch { return 0 } }

  const run = (count) => new Promise((resolve) => {
    let child
    try {
      child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-StartPid', String(pid), '-Count', String(count)], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) { log('taskbar badge: cannot start PowerShell: ' + (error?.message ?? error)); resolve(4); return }
    let err = ''
    child.stderr?.on?.('data', (d) => { err += String(d) })
    child.on('error', (error) => { log('taskbar badge: ' + (error?.message ?? error)); resolve(4) })
    child.on('exit', (code) => { if (code && code !== NO_WINDOW && err.trim()) log('taskbar badge: ' + err.trim().slice(0, 200)); resolve(code ?? 4) })
  })

  const apply = async () => {
    if (disposed) return
    const count = totalNow()
    if (running) { pending = true; return }
    if (count === applied) return
    running = run(count)
    const code = await running
    running = undefined
    if (code === 0) { applied = count; retries = 0; log('taskbar badge: ' + count) }
    else if (code === NO_WINDOW) {
      if (!loggedNoWindow) { loggedNoWindow = true; log('taskbar badge: no app window above this process, will retry') }
      if (count > 0 && retries < maxRetries && !disposed) { retries++; schedule(retryMs) }
    } else if (count > 0 && retries < maxRetries && !disposed) { retries++; schedule(retryMs) }
    if (pending) { pending = false; await apply() }
  }

  const schedule = (ms) => {
    if (disposed) return
    if (timer !== undefined) clearTimer(timer)
    timer = setTimer(() => { timer = undefined; void apply() }, ms)
    timer?.unref?.()
  }

  const off = queue.onChange(() => { retries = 0; schedule(debounceMs) })
  schedule(debounceMs) // the count at start

  return {
    enabled: true,
    /** Re-applies the current count now (also when it equals the last one). */
    refresh() { applied = undefined; retries = 0; schedule(0) },
    /** Removes the badge and stops. */
    async dispose() {
      if (disposed) return
      disposed = true
      off?.()
      if (timer !== undefined) clearTimer(timer)
      if (running) await running
      if (applied !== undefined && applied !== 0) await run(0)
    },
  }
}
