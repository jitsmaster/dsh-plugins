/**
 * dsh-git-view — host half. Shows the git state of the repository a DSH session is working in:
 * current branch or linked worktree, staged / unstaged / untracked changes, commits on the branch,
 * and diffs. The browser half (lib/client.js) is a right-sidebar tab that talks to the loopback API
 * started here.
 *
 * Config (all optional): `stateDir` (where sessions.json lives), `gitPath` (absolute git executable),
 * (The API is served on the Host web server under /git-view; there is no separate port.)
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setGitPath } from './gitpath.js'
import { createSessionRegistry } from './sessions.js'
import { GIT_VIEW_PREFIX, startServer } from './server.js'

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

  // The API rides the Host's own web server: same origin and port as the page, so the browser, Desktop and the
  // remote-access proxy all reach it. Every request must pass the Host's Host/Origin fence and cookie authentication.
  try {
    const { serve } = startServer({ registry, logger: ctx.logger, embedded: true })
    ctx.inject(['connection', 'webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: GIT_VIEW_PREFIX,
        handler: (req, res) => {
          const admission = webCtx.connection.admit(req)
          if ('rejection' in admission) { res.statusCode = admission.rejection; res.end(); return }
          req.url = (req.url ?? '/').slice(GIT_VIEW_PREFIX.length) || '/'
          serve(req, res)
        },
      }), 'git-view: routes')
    })
  } catch (error) { ctx.logger?.warn?.(`git-view: routes not registered: ${String(error)}`) }
}
