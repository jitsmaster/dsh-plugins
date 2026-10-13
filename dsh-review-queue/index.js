/**
 * dsh-review-queue — host half. Collects what is waiting on the user across every session (finished work, open
 * questions, permission requests) into one queue and serves it to the browser half (lib/client.js: a sidebar tab and
 * a full-screen overlay) under /review-queue on the Host web server.
 *
 * Config (all optional): `stateDir` (where queue.json lives), `dev` (true, or env DSH_REVIEW_QUEUE_DEV=1, enables the
 * /v1/dev/ask route that creates fake questions, permissions and completions for testing the UI).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createStore } from './store.js'
import { createSummarizer } from './summary.js'
import { installCapture, cancelStalePending } from './capture.js'
import { createReviewQueue } from './service.js'
import { createRouter, PREFIX } from './server.js'

export const name = 'review-queue'

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

  const log = (line) => ctx.logger?.info?.('review-queue: ' + line)
  const store = createStore({ io: stateDir ? fileIo(join(stateDir, 'queue.json')) : undefined })
  cancelStalePending(store)
  store.prune()

  const llmService = () => { try { return ctx.get?.('llm') ?? ctx.llm } catch { return undefined } }
  const summarizer = createSummarizer({
    llm: { listProviders: () => llmService().listProviders(), listModels: (p) => llmService().listModels(p), prepareCall: (...a) => llmService().prepareCall(...a) },
    log,
  })
  const capture = installCapture(ctx, { store, summarizer, log })
  const controllerOf = () => { try { return ctx.get?.('sessionController') ?? ctx.sessionController } catch { return undefined } }
  const queue = createReviewQueue({ store, capture, controllerOf })

  const pruneTimer = setInterval(() => store.prune(), 3600_000)
  pruneTimer.unref?.()
  ctx.effect?.(() => () => { clearInterval(pruneTimer); capture.dispose() }, 'review-queue: stop')

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
  const serve = createRouter({ queue, dev })

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
