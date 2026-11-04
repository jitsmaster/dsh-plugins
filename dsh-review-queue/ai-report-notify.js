/**
 * The chat channel of the AI report: a RingCentral DM to the user through scripts/rc-notify.ps1. PowerShell is started with an argument array (no shell),
 * the message goes through stdin as JSON (never into the command line), the credentials stay in the env file the script reads. Best effort: a missing
 * env file, a failed run or a timeout is logged (redacted, one line) and never thrown.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redact } from './triage-log.js'

const TIMEOUT_MS = 20_000
const MAX_STDERR = 2000

/**
 * @param {{ spawn: Function, script: string, powershell: string, envFile?: string, log?: (m: string) => void, exists?: (p: string) => boolean, timeoutMs?: number }} deps
 * @returns {(text: string) => Promise<void>}
 */
export function createRcNotify({ spawn, script, powershell, envFile = join(homedir(), '.claude', 'skills', 'ado-monitor', '.env'), log = () => {}, exists = existsSync, timeoutMs = TIMEOUT_MS }) {
  // Whatever the script printed, cut to its first line and scrubbed: stderr must never carry a credential into the log.
  const oneLine = (text) => redact(text.split(/\r?\n/).find((l) => l.trim()) ?? '').replace(/RC_[A-Z_]+\s*=\s*\S+/g, '[redacted]').slice(0, 200)
  let envMissingLogged = false // the hourly tick would repeat the same line forever
  return (text) => new Promise((resolve) => {
    if (!exists(envFile)) { if (!envMissingLogged) { envMissingLogged = true; log('ai-report: RingCentral env file not found; chat channel skipped') } resolve(); return }
    let done = false
    let stderr = ''
    let timer
    const finish = (line) => { if (done) return; done = true; clearTimeout(timer); if (line) log(line); resolve() }
    try {
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-EnvFile', envFile], { windowsHide: true, timeout: TIMEOUT_MS })
      timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } finish('ai-report: RingCentral post timed out') }, timeoutMs)
      timer.unref?.()
      child.stderr?.on('data', (d) => { if (stderr.length < MAX_STDERR) stderr += String(d) })
      child.on('error', (e) => finish('ai-report: RingCentral post failed to start: ' + oneLine(String(e?.message ?? e))))
      // 'close' (not 'exit'): it fires after stdio is drained, so the failure line carries the script's stderr
      child.on('close', (code) => finish(code === 0 ? undefined : 'ai-report: RingCentral post failed (exit ' + code + '): ' + oneLine(stderr)))
      child.stdin?.on?.('error', () => {}) // a child that died early closes the pipe: the close event reports it
      child.stdin?.end(JSON.stringify({ text }))
    } catch (e) { finish('ai-report: RingCentral post failed to start: ' + oneLine(String(e?.message ?? e))) }
  })
}
