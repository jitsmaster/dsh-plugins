/**
 * dsh-git-view — host half. Shows the git state of the repository a DSH session is working in:
 * current branch or linked worktree, staged / unstaged / untracked changes, commits on the branch,
 * and diffs. The browser half (lib/client.js) is a right-sidebar tab that talks to the loopback API
 * started here.
 *
 * Config (all optional): `stateDir` (where sessions.json lives), `gitPath` (absolute git executable),
 * `port` (loopback API port; the shipped client only knows 3082, see README).
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setGitPath } from './gitpath.js'
import { createSessionRegistry } from './sessions.js'
import { GIT_VIEW_PORT, startServer } from './server.js'

export const name = 'git-view'

/** Workspace folders DSH knows about; the registry's shape varies by version, so read it defensively. */
function workspacePathsOf(ctx) {
  try {
    const registry = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry')
    return (registry?.list?.() ?? []).map(w => w?.path).filter(p => typeof p === 'string')
  } catch { return [] }
}

export function apply(ctx, config = {}) {
  // A bad stateDir (not a string, unwritable, ...) is logged and sessions stay in memory; it must not fail plugin load.
  let stateDir
  try {
    stateDir = resolve(config.stateDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'git-view'))
    mkdirSync(stateDir, { recursive: true })
  } catch (error) { ctx.logger?.warn?.(`git-view: state directory unusable (${String(error)}); sessions are not persisted`); stateDir = undefined }
  // Optional absolute git executable override; otherwise git is resolved from PATH (never the cwd).
  if (config.gitPath) setGitPath(config.gitPath)

  // No usable state directory: stay in memory rather than writing sessions.json into the host's cwd.
  const registry = createSessionRegistry({ stateDir, persist: stateDir !== undefined, workspacePaths: () => workspacePathsOf(ctx) })

  ctx.on('agent/created', ({ agent } = {}) => {
    try { registry.seen(agent?.id, agent?.session?.header?.cwd) } catch (error) { ctx.logger?.warn?.(`git-view: agent/created failed: ${String(error)}`) }
  })
  ctx.on('agent/disposed', (payload) => { registry.gone(payload?.agent?.id ?? payload?.id) })

  // Record the worktree each session actually works in (its cwd stays at the launch directory).
  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Best effort bookkeeping must never stop the tool pipeline: whatever happens, next() runs.
    try {
      const id = exec?.agent?.id
      if (id) {
        registry.seen(id, exec.agent.session?.header?.cwd)
        registry.observe(id, exec.arguments).catch(() => {})
      }
    } catch (error) { ctx.logger?.warn?.(`git-view: tool hook failed: ${String(error)}`) }
    return next()
  })

  const controller = new AbortController()
  ctx.effect(() => () => controller.abort(), 'git-view: stop server')
  // The shipped client talks to 3082 only (it reads window.__GIT_VIEW_PORT__, which the page must set), so a
  // different port is only useful together with that page-side change. Invalid values fall back to the default.
  const port = Number.isInteger(config.port) && config.port > 0 && config.port < 65536 ? config.port : GIT_VIEW_PORT
  // A bad DSH_WEB_URL (new URL throws) or a listen failure must not fail plugin load.
  try {
    startServer({
      registry,
      logger: ctx.logger,
      signal: controller.signal,
      port,
    })
  } catch (error) { ctx.logger?.warn?.(`git-view: server not started: ${String(error)}`) }
}
