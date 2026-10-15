/**
 * Which executable runs the hub (docs/hub.md 8.1): config hubNode, else the host's own process.execPath when the host is plain Node,
 * else "node" found on PATH, else the Electron executable run as Node (ELECTRON_RUN_AS_NODE=1). Existence checks and the
 * environment are injected, so every branch is testable. Answers { exe, env } (env: extra variables for the child) or { error }.
 */
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'

const pathOf = (env) => env[Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'] ?? ''

function findOnPath({ platform, env, exists }) {
  const windows = platform === 'win32'
  const { join } = windows ? win32 : posix
  for (const dir of pathOf(env).split(windows ? ';' : ':')) {
    if (!dir) continue
    const candidate = join(dir, windows ? 'node.exe' : 'node')
    if (exists(candidate)) return candidate
  }
  return undefined
}

/** @param {{ hubNode?: string, platform?: string, execPath?: string, versions?: Record<string, string>, env?: Record<string, string | undefined>, exists?: (p: string) => boolean }} [opts] */
export function resolveNodeExe({ hubNode, platform = process.platform, execPath = process.execPath, versions = process.versions, env = process.env, exists = existsSync } = {}) {
  if (typeof hubNode === 'string' && hubNode) return exists(hubNode) ? { exe: hubNode, env: {} } : { error: 'hubNode does not exist' }
  if (!versions.electron && execPath && exists(execPath)) return { exe: execPath, env: {} }
  const onPath = findOnPath({ platform, env, exists })
  if (onPath) return { exe: onPath, env: {} }
  if (versions.electron && execPath && exists(execPath)) return { exe: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
  return { error: 'node was not found' }
}
