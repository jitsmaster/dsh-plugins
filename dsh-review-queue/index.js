/**
 * dsh-review-queue — host half. Collects what is waiting on the user across every session (finished work, open
 * questions, permission requests) into one queue and serves it to the browser half (lib/client.js: a sidebar tab and
 * a full-screen overlay) under /review-queue on the Host web server.
 *
 * `taskbarBadge` (default on, Windows only; env DSH_RQ_TASKBAR=0 turns it off): the number of waiting items as a badge on the app's taskbar button (taskbar.js).
 *
 * Config (all optional): `sparcCommandPath` (the modes:sparc command file a "Use SPARC" todo inlines, default ~/.claude/commands/modes/sparc.md), `stateDir` (where queue.json lives), `ttsClient` (path of dsh-hooks-tts's tts-client.ps1, default the
 * sibling plugin folder), `voice` ('male' default, or 'female') for the play button, `dev` (true, or env DSH_REVIEW_QUEUE_DEV=1, enables the
 * /v1/dev/ask route that creates fake questions, permissions and completions for testing the UI), `pushSubject` (the mailto: or https: contact
 * the push services see in the VAPID token) and `sendPush` (replaces the real Web Push delivery, for tests).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.js'
import { createSummarizer } from './summary.js'
import { installCapture, cancelStalePending } from './capture.js'
import { createReviewQueue } from './service.js'
import { createReader } from './reader.js'
import { createRouter, PREFIX } from './server.js'
import { createPushStore, loadOrCreateVapid, jsonFileIo } from './push.js'
import { createPushRoutes } from './push-routes.js'
import { createFileLog } from './filelog.js'
import { createTaskbarBadge } from './taskbar.js'

export const name = 'review-queue'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Atomic-ish JSON file: write a temp file, then rename over the target. */
function fileIo(file) {
  return {
    read: () => { try { return readFileSync(file, 'utf8') } catch { return undefined } },
    write: (text) => { const tmp = file + '.tmp'; writeFileSync(tmp, text); renameSync(tmp, file) },
  }
}

export function apply(ctx, config = {}) {
  let stateDir
  try {
    stateDir = resolve(config.stateDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'review-queue'))
    mkdirSync(stateDir, { recursive: true })
  } catch (error) { ctx.logger?.warn?.('review-queue: state directory unusable (' + String(error) + '); the queue is not persisted'); stateDir = undefined }

  // Every log line also goes to review-queue.log next to queue.json (size capped), so a silent failure can be traced later.
  const fileLog = stateDir ? createFileLog(join(stateDir, 'review-queue.log')) : undefined
  const log = (line) => { ctx.logger?.info?.('review-queue: ' + line); fileLog?.('review-queue: ' + line) }
  const store = createStore({ io: stateDir ? fileIo(join(stateDir, 'queue.json')) : undefined })
  cancelStalePending(store)
  store.prune()

  const llmService = () => { try { return ctx.get?.('llm') ?? ctx.llm } catch { return undefined } }
  const llm = { listProviders: () => llmService().listProviders(), listModels: (p) => llmService().listModels(p), prepareCall: (...a) => llmService().prepareCall(...a) }
  const summarizer = createSummarizer({ llm, log })
  const capture = installCapture(ctx, { store, summarizer, log })
  const controllerOf = () => { try { return ctx.get?.('sessionController') ?? ctx.sessionController } catch { return undefined } }
  // The play button speaks through the sibling dsh-hooks-tts plugin's TTS client (same server, mute switch and stop hotkey).
  const reader = createReader({
    spawn,
    script: join(HERE, 'scripts', 'read-aloud.ps1'),
    clientScript: resolve(config.ttsClient ?? join(HERE, '..', 'dsh-hooks-tts', 'scripts', 'tts-client.ps1')),
    powershell: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    stateDir: process.env.DSH_TTS_STATE_DIR || join(process.env.TEMP || tmpdir(), 'dsh-tts'),
    gender: config.voice === 'female' ? 'female' : 'male',
    log,
  })
  const registryOf = () => { try { return ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry } catch { return undefined } }
  // Todo: recent session titles help the model pick a workspace (best effort), and a SPARC todo inlines the modes:sparc text like dsh-hooks-tts does.
  const titlesOf = async (ids) => {
    const titles = new Map()
    try {
      const query = ctx.get?.('sessionQuery')
      if (!ids.length || typeof query?.readTitleSnapshots !== 'function') return titles
      const results = await query.readTitleSnapshots(ids)
      results.forEach((r, i) => { if (r?.status === 'fulfilled' && typeof r.value?.title?.title === 'string') titles.set(ids[i], r.value.title.title) })
    } catch { /* titles are a bonus */ }
    return titles
  }
  const sparcText = () => {
    try { return readFileSync(resolve(config.sparcCommandPath ?? join(homedir(), '.claude', 'commands', 'modes', 'sparc.md')), 'utf8').replace(/^---[\s\S]*?\n---\s*/, '') } catch { return '' }
  }
  const queue = createReviewQueue({ store, capture, controllerOf, registryOf, speaker: reader, llm, titlesOf, sparcText, log })

  // The waiting count as a badge on the taskbar button. Off in node --test runs (they set NODE_TEST_CONTEXT) unless a test asks with taskbarBadge: true.
  const badgeWanted = config.taskbarBadge === true || (config.taskbarBadge !== false && process.env.DSH_RQ_TASKBAR !== '0' && process.env.NODE_TEST_CONTEXT === undefined)
  const taskbar = badgeWanted
    ? createTaskbarBadge({
      queue, spawn: config.badgeDeps?.spawn ?? spawn, script: join(HERE, 'scripts', 'taskbar-badge.ps1'), pid: process.pid, log,
      powershell: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ...(config.badgeDeps ?? {}),
    })
    : undefined

  const pruneTimer = setInterval(() => store.prune(), 3600_000)
  pruneTimer.unref?.()
  ctx.effect?.(() => async () => { clearInterval(pruneTimer); capture.dispose(); reader.stop(); await taskbar?.dispose() }, 'review-queue: stop')

  // Dev route: drive the real handlers with a fake agent so the whole path (item, card answer, expiry) can be tried
  // without a model. Off unless asked for.
  let dev
  if (config.dev === true || process.env.DSH_REVIEW_QUEUE_DEV === '1') {
    let n = 0
    const never = () => new Promise(() => {})
    dev = {
      async ask(body) {
        const agent = { id: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : 'dev-' + ++n, devTitle: String(body.title ?? 'Dev session'), session: { header: { cwd: 'D:/dev' }, deriveMessages: () => [{ role: 'assistant', content: String(body.reply ?? 'Done.') }] } }
        if (body.kind === 'question') {
          const ac = new AbortController()
          const seconds = Number.isInteger(body.timeoutSec) ? body.timeoutSec : 0
          const callId = 'dev-call-' + n
          if (seconds > 0) {
            await capture.handlers['tools/pre-execute']({ name: 'ask_user_question', callId, arguments: { timeout: seconds }, agent }, async () => ({}))
            setTimeout(() => ac.abort(Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' })), seconds * 1000).unref?.()
          }
          void capture.handlers['user-questions/request']({ agent, questions: body.questions, signal: ac.signal, wait: { callId, timed: seconds > 0 } }, never).catch(() => {})
        } else if (body.kind === 'permission') {
          const callId = 'dev-perm-' + n
          await capture.handlers['tools/pre-execute']({ name: String(body.toolName ?? 'shell'), callId, arguments: { command: String(body.command ?? 'echo hi') }, agent }, async () => ({}))
          void capture.handlers['approval/request']({ agent, toolName: String(body.toolName ?? 'shell'), callId }, never).catch(() => {})
        } else {
          await capture.handlers['agent/turn-stopping']({ agent })
        }
        return { ok: true }
      },
    }
  }
  // Phone notifications: the VAPID key pair and the registered devices live next to queue.json (private files); delivery is injectable.
  const vapid = loadOrCreateVapid({ io: stateDir ? jsonFileIo(join(stateDir, 'vapid.json'), { mode: 0o600 }) : undefined, subject: config.pushSubject })
  const push = createPushStore({ io: stateDir ? jsonFileIo(join(stateDir, 'push.json'), { mode: 0o600 }) : undefined, vapid, ...(typeof config.sendPush === 'function' ? { sendPush: config.sendPush } : {}) })
  const serve = createRouter({ queue, dev, pushRoutes: createPushRoutes({ push, publicKey: vapid.publicKey }) })

  // Same pattern as dsh-git-view: ride the Host web server so the browser, Desktop and remote access all reach it, behind
  // the Host's own Host/Origin fence and cookie authentication.
  try {
    ctx.inject(['connection', 'webServer'], (webCtx) => {
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => {
          const admission = webCtx.connection.admit(req)
          if ('rejection' in admission) { res.statusCode = admission.rejection; res.end(); return }
          req.url = (req.url ?? '/').slice(PREFIX.length) || '/'
          serve(req, res)
        },
      }), 'review-queue: routes')
    })
  } catch (error) { ctx.logger?.warn?.('review-queue: routes not registered: ' + String(error)) }

  // Other plugins (voice) reach the queue through the context.
  try { ctx.provide?.('reviewQueue', queue) } catch { /* optional */ }
  return queue
}
