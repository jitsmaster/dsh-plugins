import { join } from 'node:path'

/**
 * Speaks a short line through the plugin's own stop-speak.ps1 (the same Kokoro path as the Stop alert).
 * The child must stay attached: a detached powershell with piped stdio exits in ~250 ms without speaking on Windows.
 */
export function createSpeaker({ spawn, root, env, onError = () => {} }) {
  return (text) => {
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'stop-speak.ps1')],
        { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env },
      )
      child.stdin.end(JSON.stringify({ headline: text }))
      child.unref?.()
    } catch (error) {
      onError(error)
    }
  }
}
