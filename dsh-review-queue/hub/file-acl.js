/**
 * Private files on Windows (docs/hub.md 9.3): mode 0o600 means nothing there, so a secret file gets
 * icacls <file> /inheritance:r /grant:r "<DOMAIN\\user>:(R,W)", i.e. no inherited rights and the current user only. The command goes
 * through an injectable runner. A failure is logged (file name only) and remembered, so the devices page can say "file permissions
 * could not be tightened"; it never stops the hub. A rename keeps the rights of the file that is renamed, so an atomic replace must
 * tighten the temp file before the rename (hardenedWrite).
 */
import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { basename } from 'node:path'

const currentUser = () => (process.env.USERNAME ? (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + process.env.USERNAME : undefined)
const realRun = (cmd, args) => spawnSync(cmd, args, { windowsHide: true, stdio: 'ignore', timeout: 10_000 })

/** @param {{ platform?: string, user?: string, run?: (cmd: string, args: string[]) => { status: number | null, error?: Error }, chmod?: (file: string, mode: number) => void, log?: (line: string) => void }} [opts] */
export function createHardener({ platform = process.platform, user = currentUser(), run = realRun, chmod = chmodSync, log = () => {} } = {}) {
  const failed = new Set()

  function tighten(file) {
    if (platform !== 'win32') { chmod(file, 0o600); return true }
    if (!user) return false
    const result = run('icacls', [file, '/inheritance:r', '/grant:r', user + ':(R,W)'])
    return result?.status === 0 && !result.error
  }

  return {
    /** @returns {{ ok: boolean }} never throws */
    harden(file) {
      const name = basename(file).replace(/\.\d+\.tmp$/, '')
      let ok = false
      try { ok = tighten(file) } catch { ok = false }
      if (ok) failed.delete(name)
      else if (!failed.has(name)) { failed.add(name); log('file permissions could not be tightened (' + name + ')') }
      return { ok }
    },
    status: () => ({ tightened: failed.size === 0, failed: [...failed].sort() }),
  }
}

/** The writeAtomic options that tighten the temp file just before it replaces the target. */
export const hardenedWrite = ({ harden, ...rest }) => ({ ...rest, prepare: (tmp) => { harden(tmp) } })
