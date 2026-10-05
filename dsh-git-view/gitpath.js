/**
 * Resolve an absolute path to the git executable.
 *
 * Security (binary planting): on Windows, CreateProcess searches the *current directory* before PATH, so
 * `execFile('git', { cwd: repo })` would run a `git.exe` planted inside an untrusted repository. We therefore
 * look git up ourselves, from PATH only, ignoring relative entries and the process's own cwd.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

const win = process.platform === 'win32'
let override
let cached

/**
 * Security: lexically true for UNC / device paths (`\\host\share`, `\\?\C:\`, `\\.\pipe`, `//host/x`).
 * Touching one with fs can trigger an SMB connection (NTLM credential leak) or open a device, so this
 * check runs before any fs call on a path that came from tool arguments or the browser.
 */
export const isUncOrDevicePath = (p) => typeof p === 'string' && /^\s*[\\/]{2}/.test(p)

/** Configured absolute path (config.gitPath); an invalid value is ignored. */
export function setGitPath(p) {
  override = typeof p === 'string' && p && isAbsolute(p) ? resolve(p) : undefined
  cached = undefined
}

const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
const isExec = (p) => { try { if (!isFile(p)) return false; if (!win) accessSync(p, constants.X_OK); return true } catch { return false } }

/**
 * @param {{ path?: string, cwd?: string, platform?: string }} [env] overridable for tests
 * @returns {string | undefined} absolute git path, or undefined when nothing was found
 */
export function findGit({ path = process.env.PATH ?? process.env.Path ?? '', cwd = process.cwd(), isWin = win } = {}) {
  const here = resolve(cwd).toLowerCase()
  // .cmd/.bat wrappers need a shell, so only a real git.exe is accepted on Windows.
  const names = isWin ? ['git.exe'] : ['git']
  for (const raw of path.split(isWin ? ';' : delimiter)) {
    const dir = raw.trim().replace(/^"|"$/g, '')
    if (!dir || !isAbsolute(dir)) continue // empty / relative entries mean "current directory"
    if (resolve(dir).toLowerCase() === here) continue
    for (const n of names) {
      const full = join(dir, n)
      if (isExec(full)) return full
    }
  }
  return undefined // fail closed: callers must not fall back to a bare `git` (cwd-relative lookup on Windows)
}

/** The git executable to run: override, else lazily resolved from PATH once. `undefined` when none was found. */
export function gitExecutable() {
  return override ?? (cached ??= findGit())
}
