/**
 * Per-session worktree tracker. DSH has no worktree concept and a session's cwd stays at its
 * launch directory, so the plugin watches every tool call: any directory a call works in
 * (workdir, file paths, `cd`, absolute paths in a command) that is inside a linked git
 * worktree becomes that session's recorded worktree. Records persist to
 * <stateDir>/worktrees.json (session id -> { root, name, branch, at }) for the status overlay.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const git = (cwd, args) => new Promise((res) => {
  execFile('git', ['-C', cwd, ...args], { timeout: 5000, windowsHide: true }, (err, out) => res(err ? undefined : out.trim()))
})

/** Linked-worktree info for a path, or undefined if it is not inside one. */
export async function linkedWorktreeOf(path) {
  if (!path || !existsSync(path)) return undefined
  const dir = statSync(path).isDirectory() ? path : dirname(path)
  const [top, gitDir, common, branch] = await Promise.all([
    git(dir, ['rev-parse', '--show-toplevel']),
    git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']),
    git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ])
  if (!top || !gitDir || !common || gitDir === common) return undefined
  const root = resolve(top)
  return { root, name: root.split(/[\\/]/).filter(Boolean).at(-1), branch: branch && branch !== 'HEAD' ? branch : '(detached)' }
}

/** Candidate paths mentioned by one tool call's arguments. */
function candidates(args, baseCwd) {
  const out = new Set()
  const add = (p) => {
    if (typeof p !== 'string' || !p.trim()) return
    const clean = p.trim().replace(/^["']|["']$/g, '')
    out.add(isAbsolute(clean) ? clean : baseCwd ? resolve(baseCwd, clean) : clean)
  }
  for (const k of ['workdir', 'cwd', 'file_path', 'path', 'notebook_path']) add(args?.[k])
  const cmd = typeof args?.command === 'string' ? args.command : ''
  for (const m of cmd.matchAll(/(?:\bcd|Set-Location|\bpushd)\s+(?:-[A-Za-z]+\s+)?["']?([^\s"';|&]+)/gi)) add(m[1])
  for (const m of cmd.matchAll(/[A-Za-z]:[\\/][^\s"'`;|&)]*/g)) add(m[0])
  return [...out].slice(0, 8)
}

export function createWorktreeTracker(stateDir) {
  const path = join(stateDir, 'worktrees.json')
  let data = {}
  try { data = JSON.parse(readFileSync(path, 'utf8')) } catch { /* first run */ }
  const save = () => { try { writeFileSync(path, JSON.stringify(data, null, 2)) } catch { /* non-fatal */ } }

  return {
    get: (sessionId) => data[sessionId],
    /** Inspect one finished tool call; records the worktree if it touched one. Never throws. */
    async observe(sessionId, args, baseCwd) {
      try {
        for (const p of candidates(args, baseCwd)) {
          const wt = await linkedWorktreeOf(p)
          if (wt) {
            if (data[sessionId]?.root !== wt.root || data[sessionId]?.branch !== wt.branch) {
              data[sessionId] = { ...wt, at: new Date().toISOString() }
              save()
            }
            return
          }
        }
      } catch { /* best effort */ }
    },
  }
}
