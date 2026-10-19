/**
 * Closes the DSH desktop app (the Electron process that owns this app's host) for "Pause all and quit" and the Close menu's Quit.
 * The Desktop belongs to the Electron main process, which this plugin cannot reach, so scripts/desktop-quit.ps1 finds it up this
 * process's parent chain (the top-most ancestor with the same image name, an Electron or DeepSeek Harness executable that is not a
 * child-type process) and stops it and its process tree. Windows only. Without such an ancestor (DSH opened in a browser, plain node host)
 * the script exits 3 and nothing is stopped.
 *
 * The kill runs from a detached script a moment after the HTTP answer has been sent: the script lives in the tree it stops, so it
 * stops the desktop process first and its own tree after.
 */
import { existsSync } from 'node:fs'

export const NO_DESKTOP = 3

/** @param {{ spawn: Function, script: string, powershell: string, pid?: number, platform?: string, exists?: (p: string) => boolean, delayMs?: number, setTimer?: Function, log?: (line: string) => void }} deps */
export function createDesktop({ spawn, script, powershell, pid = process.pid, platform = process.platform, exists = existsSync, delayMs = 800, setTimer = setTimeout, log = () => {} }) {
  const args = (mode) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-StartPid', String(pid), '-Mode', mode]
  const usable = platform === 'win32' && exists(script)
  let quitting = false
  return {
    /** Is there a desktop app to close? (the script's find mode answers) */
    canQuit() {
      if (!usable) return Promise.resolve(false)
      return new Promise((resolve) => {
        let child
        try { child = spawn(powershell, args('find'), { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }) } catch (error) { log('desktop: cannot start the finder: ' + String(error?.message ?? error)); resolve(false); return }
        child.on('error', (error) => { log('desktop: finder failed: ' + String(error?.message ?? error)); resolve(false) })
        child.on('exit', (code) => resolve(code === 0))
      })
    },
    /** Stops the desktop app and its process tree after delayMs. Idempotent. */
    quitSoon() {
      if (quitting || !usable) return false
      quitting = true
      const t = setTimer(() => {
        try {
          const child = spawn(powershell, args('kill'), { detached: true, stdio: 'ignore', windowsHide: true })
          child.on?.('error', (error) => { quitting = false; log('desktop: quit failed: ' + String(error?.message ?? error)) })
          child.unref?.()
        } catch (error) { quitting = false; log('desktop: cannot start the quit script: ' + String(error?.message ?? error)) }
      }, delayMs)
      t?.unref?.()
      return true
    },
  }
}
