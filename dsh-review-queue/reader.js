/**
 * Reads text aloud through the dsh-hooks-tts speech stack (scripts/tts-client.ps1: the Kokoro server, the shared playback
 * mutex, the Ctrl+Alt+M stop hotkey and the tts-muted flag), so it never talks over an alert and follows the same mute
 * switch. One PowerShell process (scripts/read-aloud.ps1) speaks the chunks one after the other; stopping kills it.
 * Only one read runs at a time: a new one replaces the old one.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function createReader({ spawn, script, clientScript, powershell, stateDir, exists = existsSync, gender = 'male', log = () => {} }) {
  let current // { child, ended, onEnd }

  const finish = (run) => {
    if (run.ended) return
    run.ended = true
    if (current === run) current = undefined
    try { run.onEnd?.() } catch { /* a listener must not break the reader */ }
  }

  return {
    /** @returns {{ ok: true } | { ok: false, error: 'muted' | 'no-speaker' | 'nothing-to-read' }} */
    speak(chunks, { onEnd } = {}) {
      const pieces = (chunks ?? []).filter((c) => typeof c === 'string' && c.trim())
      if (!pieces.length) return { ok: false, error: 'nothing-to-read' }
      if (exists(join(stateDir, 'tts-muted.flag'))) return { ok: false, error: 'muted' }
      if (!exists(script) || !exists(clientScript)) return { ok: false, error: 'no-speaker' }
      this.stop()
      let child
      try {
        child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ClientScript', clientScript, '-Gender', gender], {
          stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true,
        })
      } catch (error) { log('read: cannot start the speaker: ' + (error?.message ?? error)); return { ok: false, error: 'no-speaker' } }
      const run = { child, ended: false, onEnd }
      current = run
      child.stdin?.on?.('error', () => {}) // EPIPE after the process died is handled by its exit
      child.stderr?.on?.('data', (d) => log('read: ' + String(d).trim().slice(0, 200)))
      child.on('exit', () => finish(run))
      child.on('error', (error) => { log('read: ' + (error?.message ?? error)); finish(run) })
      child.stdin.end(JSON.stringify({ chunks: pieces }))
      return { ok: true }
    },
    stop() {
      const run = current
      current = undefined
      if (!run) return
      try { run.child.kill() } catch { /* already gone */ }
    },
    active: () => current !== undefined,
  }
}
