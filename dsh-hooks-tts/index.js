/**
 * dsh-hooks-tts — runs Claude-Code-style command hooks (hooks.json) inside
 * DeepSeek Harness. Matching follows Claude Code: absent/''/'*' match all,
 * word+pipe patterns are exact alternatives, anything else is a regex.
 *
 * Event mapping:
 *   SessionStart      -> agent/created        (matcher: startup|resume|clear|compact)
 *   UserPromptSubmit  -> agent/pre-step
 *   PreToolUse        -> tools/pre-execute    (matcher: tool name, Claude aliases too)
 *   PostToolUse       -> tools/post-execute
 *   Stop              -> agent/turn-stopping  (payload.last_assistant_message)
 *   PermissionRequest -> approval/request     (observe only, never answers)
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStatusService } from './status.js'
import { installContextCap } from './cap.js'
import { installPrPoller } from './pr.js'
import { installAskUserTuning } from './ask.js'
import { createWorktreeTracker } from './worktrees.js'
import { createSettings } from './settings.js'
import { createGroups } from './groups.js'
import { createGroupPinner } from './pin-groups.js'
import { alertRelevant, createDeferredAlerts, permissionIsPending, questionIsPending } from './voice/deferred-alerts.js'
import { createPendingQuestions } from './voice/pending-questions.js'
import { createVoiceLog } from './voice/log.js'
import { alertLocator, buildHookBody, createAlerts, isAskTool } from './voice/alerts.js'
import { queuePositionOf, refreshHeldAlert } from './voice/alert-position.js'
import { createVoiceService } from './voice/service.js'
import { createDecider } from './voice/decider.js'
import { createSpeakWorker } from './voice/speaker.js'
import { createAlertSpeech, speechModeOf } from './alert-speech.js'
import { createSttLauncher, normalizePort } from './voice/stt-launcher.js'
import { createToolSummaries } from './voice/tool-summaries.js'
import { createHandoffTracker } from './handoffs.js'
import { installHoldTitles } from './hold.js'

export const name = 'hooks-tts'

/** Longest shutdown waits for the last voice.log lines. */
const LOG_FLUSH_TIMEOUT_MS = 2000
/** Quiet time after voice stops being busy before the held alerts are replayed (the mic often reopens at once). */
const FLUSH_DEBOUNCE_MS = 300
const ROOT = dirname(fileURLToPath(import.meta.url))
const SOURCE = { kind: `plugin:${name}` } // producer-owned kind (format v4 rejects the retired kind: 'plugin')

/** Claude tool-name aliases so existing matchers (e.g. AskUserQuestion) keep working. */
const ALIASES = {
  ask_user_question: 'AskUserQuestion',
  bash: 'Bash',
  pwsh: 'PowerShell',
  write: 'Write',
  edit: 'Edit',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  subagent: 'Task',
}

const LITERAL = /^[A-Za-z0-9_|]+$/

export function matches(matcher, query) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if (LITERAL.test(matcher)) return matcher.split('|').includes(query)
  try { return new RegExp(matcher).test(query) } catch { return false }
}

function matchesAny(matcher, queries) {
  return queries.some(q => matches(matcher, q))
}

function substitute(value, vars) {
  return value.replace(/\$\{(\w+)\}/g, (m, k) => vars[k] ?? m)
}

function loadHooks(path, vars) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const hooks = raw.hooks ?? raw
  const out = {}
  for (const [event, groups] of Object.entries(hooks)) {
    out[event] = (groups ?? []).map(group => ({
      matcher: group.matcher,
      hooks: (group.hooks ?? [])
        .filter(h => h.type === undefined || h.type === 'command')
        .map(h => ({
          ...h,
          command: substitute(h.command, vars),
          args: h.args?.map(a => substitute(a, vars)),
        }))
        // speak | stop | elicit for the three speak launchers (they are played through the speak worker, see alert-speech.js).
        .map(h => ({ ...h, speechMode: speechModeOf(h) })),
    }))
  }
  return out
}

function textOf(content) {
  if (typeof content === 'string') return content
  return (content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('')
}

function makeMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: SOURCE,
  })
}

/** Spawn one hook, feed the payload on stdin, resolve with parsed Claude-style output. */
function runCommand(hook, payload, { cwd, env, signal, defaultTimeoutMs }) {
  return new Promise((resolveRun) => {
    const timeoutMs = hook.timeout ? hook.timeout * 1000 : defaultTimeoutMs
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun(result)
    }
    let child
    try {
      child = hook.args
        ? spawn(hook.command, hook.args, { cwd, env, signal, windowsHide: true })
        : spawn(hook.command, { cwd, env, signal, windowsHide: true, shell: true })
    } catch (error) {
      return finish({ code: -1, output: {}, stderr: String(error) })
    }
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.stdin.on('error', () => {})
    child.on('error', error => finish({ code: -1, output: {}, stderr: String(error) }))
    child.on('close', (code) => {
      let output = {}
      const trimmed = stdout.trim()
      if (trimmed.startsWith('{')) {
        try { output = JSON.parse(trimmed) } catch { /* plain text output is ignored */ }
      }
      finish({ code, output, stderr })
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

export function apply(ctx, baseConfig = {}) {
  const stateDir = resolve(baseConfig.stateDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'tts'))
  mkdirSync(stateDir, { recursive: true })
  // Machine-specific values (paths etc.) live in <stateDir>/config.local.json, which wins over
  // the plugin config, so cordis.patch.yml can stay free of personal paths.
  let config = baseConfig
  try { config = { ...baseConfig, ...JSON.parse(readFileSync(join(stateDir, 'config.local.json'), 'utf8')) } } catch { /* optional */ }
  const defaultTimeoutMs = config.defaultTimeoutMs ?? 600_000
  const skipSubagents = config.skipSubagents ?? true

  const baseEnv = {
    ...process.env,
    DSH_TTS_STATE_DIR: stateDir,
    DSH_PLUGIN_ROOT: ROOT,
    CLAUDE_PLUGIN_ROOT: ROOT,
    ...config.ttsUrl ? { DSH_TTS_URL: config.ttsUrl } : {},
    ...config.ttsServerScript ? { DSH_TTS_SERVER_SCRIPT: config.ttsServerScript } : {},
    ...config.hotkeyDir ? { DSH_TTS_HOTKEY_DIR: config.hotkeyDir } : {},
    ...config.obsidianVault ? { DSH_OBSIDIAN_VAULT: config.obsidianVault } : {},
  }
  const vars = { PLUGIN_ROOT: ROOT, CLAUDE_PLUGIN_ROOT: ROOT, DSH_TTS_STATE_DIR: stateDir }

  let hooks = {}
  try {
    hooks = loadHooks(resolve(config.configPath ?? join(ROOT, 'hooks.json')), vars)
  } catch (error) {
    ctx.logger.warn(`hooks-tts: could not load hooks config: ${String(error)} — no hooks registered`)
    return
  }

  const controller = new AbortController()
  const pending = new Set()
  // The dsh-review-queue service (task-list voice commands and the queue position in alerts); resolved per call and guarded: the plugin may not be installed.
  const reviewQueueOf = () => { try { return ctx.get('reviewQueue') ?? undefined } catch { return undefined } }
  ctx.effect(() => async () => {
    controller.abort()
    await Promise.allSettled([...pending])
  }, 'hooks-tts: abort running hooks')

  const settings = createSettings(stateDir, { contextCapTokens: config.contextCapTokens })
  const worktrees = createWorktreeTracker(stateDir)
  const alerts = createAlerts()
  const groups = createGroups(stateDir, { trace: (line) => ctx.logger.warn(`hooks-tts: ${line}`) })
  const handoffs = createHandoffTracker(stateDir)
  // Pinning a session pins the rest of its group (the registry announces every pin change).
  const groupPinner = createGroupPinner({
    groups,
    registry: () => ctx.get('workspaceRegistry') ?? ctx.workspaceRegistry,
    trace: (line) => ctx.logger.warn(`hooks-tts: ${line}`),
  })
  ctx.on('domain/changed', (change) => { void groupPinner.onChange(change) })
  // "Follow-up from handoff" spawns through the cap's machinery, installed further down (hence lazy).
  let contextCap
  startStatusService(ctx, config, stateDir, controller.signal, settings, worktrees, groups, { handoffs, followUp: (sessionId) => contextCap.followUp(sessionId), voice: () => voice })

  // Record the worktree each session actually works in (its cwd stays at the launch directory),
  // and every handoff note it writes (the session menu offers a follow-up from the latest one).
  ctx.on('tools/post-execute', async (exec, result, next) => {
    toolSummaries.drop(exec) // the call settled: its approval summary is no longer needed
    const id = exec.agent?.id
    if (id) void worktrees.observe(id, exec.arguments, exec.agent.session?.header?.cwd)
    if (id && !skip(exec.agent)) handoffs.observe(id, exec.name, exec.arguments, exec.agent.session?.header?.cwd)
    return next()
  })

  const children = new Set()
  ctx.on('subagent/start', (info) => { children.add(info.id) })
  ctx.on('subagent/end', (info) => { children.delete(info.id) })
  const skip = agent => skipSubagents && agent && children.has(agent.id)

  /** A TTS hook (the detached speak launcher): these are switched together from the sidebar and held while a voice flow runs. */
  const isTtsHook = (hook) => Boolean(hook.args?.some(a => /detach-launcher\.ps1$/.test(a)))

  /**
   * Run every matching hook for `event`. Async hooks are fired and tracked but not
   * awaited. Returns the folded decision/context of the synchronous hooks.
   */
  /** What happens to a TTS hook right now: 'off' (read-outs switched off), 'hold' (the mic is open: spoken after the conversation) or 'play'. */
  const ttsAction = () => (!settings.get().ttsEnabled ? 'off' : voice.busy() ? 'hold' : 'play')
  async function run(event, queries, payload, agent, signal) {
    const cwd = agent?.session?.header?.cwd
    const env = { ...baseEnv, CLAUDE_PROJECT_DIR: cwd ?? baseEnv.CLAUDE_PROJECT_DIR ?? process.cwd() }
    let sessionTitle
    try { sessionTitle = ctx.get('sessionTitle')?.get(agent?.session)?.title } catch { /* title is optional */ }
    // Only a TTS hook that will really run gets a headline, so a session is numbered when it is first spoken for.
    const noAlerts = { headlineFor: () => undefined }
    let plainBody, ttsBody
    // A headline alert says the item's task-list position when the item is already in the list (no position: the old headline).
    const locator = alertLocator(event, { agentId: agent?.id, payload })
    const bodyFor = (isTts) => (isTts
      ? (ttsBody ??= buildHookBody({ event, agent, cwd, sessionTitle, payload, alerts, position: locator ? queuePositionOf(reviewQueueOf, locator) : undefined }))
      : (plainBody ??= buildHookBody({ event, agent, cwd, sessionTitle, payload, alerts: noAlerts })))
    // The session an alert is raised for becomes the voice target ("lastAlerted") when the alert arrives live. A held alert does not:
    // it may still be deduped, evicted or expired, so it is noted only when it is really replayed (see play below).
    const isAlertEvent = event === 'Stop' || event === 'PermissionRequest' || (event === 'PreToolUse' && isAskTool(payload?.tool_name))
    if (agent?.id && isAlertEvent) {
      const heldBack = (hooks[event] ?? []).some((group) => matchesAny(group.matcher, queries) && group.hooks.some(isTtsHook)) && ttsAction() === 'hold'
      if (!heldBack) voice.noteAlert(agent.id)
    }
    const folded = { decision: undefined, reason: undefined, context: [] }
    for (const group of hooks[event] ?? []) {
      if (!matchesAny(group.matcher, queries)) continue
      for (const hook of group.hooks) {
        // TTS hooks (the detached speak launchers) are switched together from the sidebar.
        const isTts = isTtsHook(hook)
        const action = isTts ? ttsAction() : 'play'
        if (action === 'off') continue
        // No read-outs while the mic is open: the alert is held and spoken once the voice conversation is over.
        if (action === 'hold') {
          const held = { hook, body: bodyFor(true), cwd, env, sessionId: agent?.id, event }
          // Replay re-renders the headline for the position the item has by then (see refresh below); only small strings are kept for it.
          if (locator) { held.locator = locator; held.headlineAt = alerts.headlineMaker(event, { cwd, sessionTitle, payload }) }
          // Noted now: whether voice control tracks this request, so a later "no longer pending" really means it was answered.
          if (event === 'PermissionRequest') held.tracked = permissionIsPending(held, voice.status().pendingApprovals)
          // Same for an ask_user_question alert: pending now (tools/pre-execute noted the call), so a later "gone" means it was answered.
          if (event === 'PreToolUse' && isAskTool(payload?.tool_name)) { held.question = true; held.callId = payload.tool_use_id; held.tracked = questionIsPending(held, pendingQuestions.list()) }
          deferredAlerts.defer(held)
          continue
        }
        const opts = {
          cwd, env, defaultTimeoutMs,
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        }
        const job = launch(hook, bodyFor(isTts), opts)
        if (hook.async || (alertSpeech && hook.speechMode)) {
          const tracked = job.finally(() => pending.delete(tracked))
          pending.add(tracked)
          continue
        }
        const { code, output, stderr } = await job
        const specific = output.hookSpecificOutput
        if (specific?.additionalContext) folded.context.push(specific.additionalContext)
        const perm = specific?.permissionDecision
        if (code === 2) {
          folded.decision = 'deny'
          folded.reason = stderr.trim() || undefined
        } else if (output.decision === 'block' || perm === 'deny') {
          folded.decision = 'deny'
          folded.reason = output.reason ?? specific?.permissionDecisionReason
        } else if (perm === 'ask' && folded.decision !== 'deny') {
          folded.decision = 'ask'
          folded.reason = specific?.permissionDecisionReason
        }
      }
    }
    return folded
  }

  const toolQueries = toolName => [toolName, ALIASES[toolName]].filter(Boolean)
  const contextMessage = folded => folded.context.length ? makeMessage(folded.context.join('\n\n')) : undefined

  // PR comment poller (and PR rename); the cap reads its handoff lines so a resumed session can re-register the poll.
  // PR creation hands over to two new sessions through the cap's spawn machinery (installed right after, hence lazy).
  const prPoller = installPrPoller(ctx, config, { settings, skip, signal: controller.signal, onPrCreated: (agent, id) => contextCap?.prCreated(agent, id) })
  // A restart drops the in-memory polls: re-register every "PR <n>" session. The host services may not be ready at
  // once, so retry a few times (restore is idempotent).
  for (const ms of [5_000, 20_000, 60_000]) {
    const timer = setTimeout(() => { void prPoller.restore().catch(() => {}) }, ms)
    timer.unref?.()
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  }
  contextCap = installContextCap(ctx, config, { skip, makeMessage, settings, prHandoff: (agent) => prPoller.handoffLines(agent.id), groups, handoffs, waitForPr: (sessionId, prId) => prPoller.addWait(sessionId, prId) })
  installAskUserTuning(ctx, { skip, makeMessage })
  installHoldTitles(ctx, { skip, stateDir: dirname(settings.path) })

  // Voice control: the STT service's transcripts drive sessions (see voice/service.js). Off unless settings.voiceControl.
  const voiceAgents = new Map()
  const controllerOf = () => ctx.get('sessionController') ?? ctx.sessionController
  // Start the STT daemon together with DSH when voice control is on (config.sttAutoStart: false opts out).
  // The port is interpolated into URLs, so anything but an integer 1-65535 falls back to the default.
  const sttPort = normalizePort(config.sttPort)
  const sttLauncher = config.sttAutoStart === false ? undefined : createSttLauncher({
    dir: config.sttDir ?? 'D:\\dev\\ai\\STT',
    configFile: config.sttConfig ?? 'config.example.toml',
    port: sttPort,
    probe: async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).ok } catch { return false } },
    exists: existsSync,
    spawnDetached: (cmd, args, opts) => {
      const log = openSync(join(stateDir, 'stt-service.log'), 'a')
      try {
        spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', log, log], windowsHide: true, env: baseEnv }).unref()
      } finally { closeSync(log) }
    },
    readLock: () => { try { return readFileSync(join(stateDir, 'stt-starting'), 'utf8') } catch { return undefined } },
    writeLock: (v) => { try { writeFileSync(join(stateDir, 'stt-starting'), String(v)) } catch { /* best effort */ } },
  })
  // What each pending tool call will do, recorded before the approval request so a spoken approve/deny can say what is being
  // approved. Security: keyed by session + tool + call id with an argument hash, dropped when the call settles (voice/tool-summaries.js).
  // Voice off: nothing is read back, so no call is summarised or hashed. settings.get() is mtime-cached (one stat per call, the file
  // is only re-read when it changed), so the flag is read live: the same switch the voice service uses. A call already pending when
  // voice is switched on has no summary, so voice cannot approve it (fails safe; the GUI still can).
  const voiceControlOn = () => settings.get().voiceControl === true
  const toolSummaries = createToolSummaries({ enabled: voiceControlOn })
  // Buffered, asynchronous: logging never blocks the event loop.
  const voiceLogger = createVoiceLog({ file: join(stateDir, 'voice.log') })
  const voiceLog = (entry) => voiceLogger.write(entry)
  // Resolved per call and guarded: reading a service the plugin did not inject can throw, and that must never abort apply().
  const llmService = () => { try { return ctx.get('llm') ?? ctx.llm } catch { return undefined } }
  const lazyLlm = {
    listProviders: () => llmService().listProviders(),
    listModels: (p) => llmService().listModels(p),
    prepareCall: (...a) => llmService().prepareCall(...a),
  }
  // The flow's lines go through one persistent, prewarmed speak worker (attached child; see voice/speaker.js).
  const speaker = createSpeakWorker({ spawn, root: ROOT, env: baseEnv, log: (stage, data) => voiceLog({ type: 'flow', stage, ...data }) })
  // The three speak hooks (Stop, permission, question) use the same worker, with the WAVs cached by the plugin: no PowerShell process
  // per alert. config.ttsAlertsViaWorker: false goes back to running the launcher scripts of hooks.json.
  const alertSpeech = config.ttsAlertsViaWorker === false ? undefined : createAlertSpeech({
    speaker, stateDir, speed: config.ttsSpeed,
    url: config.ttsUrl ?? process.env.DSH_TTS_URL ?? 'http://127.0.0.1:8880/tts',
    fetchFn: (...args) => fetch(...args),
    log: (stage, data) => voiceLog({ type: 'alert', stage, ...data }),
  })
  /** Runs one hook: a speak hook is played by the worker, any other hook is a spawned command. */
  const launch = (hook, body, opts) => (alertSpeech && hook.speechMode ? alertSpeech.run(hook.speechMode, body, { signal: opts.signal }) : runCommand(hook, body, opts))
  // Keep the worker started while read-outs are on, so an alert never pays its start-up (warm() is a no-op when it already runs).
  const warmWorker = () => { if (alertSpeech && settings.get().ttsEnabled) speaker.warm() } // called by the 5 s timer below
  // The voice service stops its speaker whenever voice control is off (every reconcile); the worker must survive that while alerts use it.
  // Shutdown stops it for real (see the cleanup effect).
  const voiceSpeaker = {
    speak: (text, opts) => speaker.speak(text, opts),
    cancel: () => speaker.cancel(),
    warm: () => speaker.warm(),
    stop: () => { if (!(alertSpeech && settings.get().ttsEnabled)) speaker.stop() },
  }
  // Lazy: the decider context reads the voice service, created right below.
  const decider = createDecider({
    llm: lazyLlm,
    log: (line) => { voiceLog({ type: 'decider', line }); ctx.logger.info(`hooks-tts: ${line}`) },
    context: () => voice.context(),
  })
  // ask_user_question calls waiting for an answer (a held Question alert is stale once its call is answered).
  const pendingQuestions = createPendingQuestions()
  // Held alerts are replayed shortly after voice stops being busy (mic closed / flow ended), not only on the 5 s tick below. Debounced:
  // the mic often closes and reopens within moments (a clarify), and flush() itself re-checks busy().
  let idleTimer
  let voiceStopped = false
  const flushSoon = () => {
    if (idleTimer || voiceStopped) return
    idleTimer = setTimeout(() => { idleTimer = undefined; void deferredAlerts.flush() }, FLUSH_DEBOUNCE_MS)
    idleTimer.unref?.()
  }
  const voice = createVoiceService({
    onIdle: flushSoon,
    // The dsh-review-queue service (task-list voice commands); resolved per call and guarded: the plugin may not be installed.
    reviewQueue: reviewQueueOf,
    speaker: voiceSpeaker,
    summaryOf: (req) => toolSummaries.lookup(req),
    decide: (utterance, opts) => decider.decide(utterance, opts),
    cwdOf: (id) => voiceAgents.get(id)?.session?.header?.cwd,
    // Slash commands the target session offers (name + description only), for the decider and for validation.
    slashOf: (id) => {
      const agent = voiceAgents.get(id)
      if (!agent) return []
      return (ctx.get('commands')?.list(agent) ?? []).map((c) => ({ name: c.name, description: c.description ?? '' }))
    },
    record: voiceLog,
    ensureStt: sttLauncher ? async () => { const r = await sttLauncher.ensure(); if (r === 'started') ctx.logger.info('hooks-tts: started the STT service'); return r } : undefined,
    enabled: voiceControlOn,
    readSecret: () => readFileSync(join(stateDir, 'stt-secret'), 'utf8').trim(),
    port: sttPort,
    titleOf: (id) => { try { return ctx.get('sessionTitle')?.get(voiceAgents.get(id)?.session)?.title } catch { return undefined } },
    controller: {
      cancel: async (r) => controllerOf().cancel(r),
      create: async (r) => controllerOf().create(r),
      fork: async (r) => controllerOf().fork(r),
      rename: async (r) => controllerOf().rename(r),
      selectModel: async (r) => controllerOf().selectModel(r),
      prompt: async (r) => controllerOf().prompt(r, AbortSignal.timeout(30_000)),
    },
    runSlash: async ({ sessionId, name, input }) => {
      const resolved = await controllerOf().resolveAgent(sessionId)
      if (!resolved.agent) throw new Error('session is not available')
      const done = await ctx.get('commands').execute(resolved.agent, `/${name}${input}`, [], AbortSignal.timeout(30_000))
      if (done === undefined) throw new Error(`/${name} is not a known command`)
      if (done.result?.kind === 'error') throw new Error(done.result.text)
    },
    trace: (line) => ctx.logger.info(`hooks-tts: ${line}`),
  })
  // Alerts held back while a voice flow ran (see the TTS branch of run()).
  const deferredAlerts = createDeferredAlerts({
    busy: () => voice.busy(),
    enabled: () => settings.get().ttsEnabled,
    // A permission or question alert is stale once its request was answered (by voice or in the GUI) while the flow ran; with voice off or a
    // request voice never tracked there is no way to tell, so it counts as relevant. A Stop alert is always replayed.
    relevant: (item) => { const status = voice.status(); return alertRelevant(item, { voiceOn: status.running, pending: status.pendingApprovals, pendingQuestions: pendingQuestions.list() }) },
    log: voiceLog,
    // A held alert says the queue position its item has when it is replayed, not the one it had when it was held; an item that left the list gets the old headline.
    refresh: (item) => refreshHeldAlert(item, (locator) => queuePositionOf(reviewQueueOf, locator)),
    // Replaying makes the alert's session the voice target (an alert that was deduped, evicted or expired never gets here).
    // Returns the launcher's promise: the queue starts the next held alert only after this one's launcher has finished.
    play: ({ hook, body, cwd, env, sessionId }) => {
      if (sessionId) voice.noteAlert(sessionId)
      const job = launch(hook, body, { cwd, env, defaultTimeoutMs, signal: controller.signal })
      const tracked = job.finally(() => pending.delete(tracked))
      tracked.catch(() => {})
      pending.add(tracked)
      return tracked
    },
  })
  const voiceTimer = setInterval(() => {
    try { voice.reconcile() } catch (error) { ctx.logger.warn(`hooks-tts: voice reconcile failed: ${String(error)}`) }
    try { warmWorker() } catch { /* the next alert starts the worker */ }
    void deferredAlerts.flush() // never rejects; plays the held alerts one after another
  }, 5000)
  voiceTimer.unref?.()
  // Returns the flush promise so shutdown awaits the last log lines, but only for LOG_FLUSH_TIMEOUT_MS: a stalled disk must not hang it.
  ctx.effect(() => () => { voiceStopped = true; clearInterval(voiceTimer); clearTimeout(idleTimer); deferredAlerts.clear(); voice.stop(); speaker.stop(); return voiceLogger.flushWithin(LOG_FLUSH_TIMEOUT_MS) }, 'hooks-tts: stop voice control')
  ctx.on('agent/created', ({ agent }) => { if (!skip(agent)) { voiceAgents.set(agent.id, agent); voice.agentCreated(agent.id) } })
  ctx.on('agent/disposed', ({ agent }) => { voiceAgents.delete(agent.id); pendingQuestions.dropSession(agent.id); voice.agentDisposed(agent.id) })

  ctx.on('agent/created', async ({ agent, source, signal }) => {
    if (skip(agent)) return
    // Handoff notes the session wrote before the plugin watched it (one history scan per session, off the hot path).
    setTimeout(() => handoffs.scan(agent.id, () => agent.session.deriveMessages(), agent.session?.header?.cwd), 0).unref?.()
    try {
      const folded = await run('SessionStart', [source ?? 'startup'], { source }, agent, signal)
      const message = contextMessage(folded)
      if (message) agent.inject(message)
    } catch (error) {
      ctx.logger.warn(`hooks-tts: SessionStart failed: ${String(error)}`)
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    if (agent?.id && !skip(agent)) { voiceAgents.set(agent.id, agent); voice.noteActive(agent.id) }
    if (skip(agent) || !messages?.length || !hooks.UserPromptSubmit) return next()
    const prompt = messages.map(m => textOf(m.content)).join('')
    const folded = await run('UserPromptSubmit', [''], { prompt }, agent, signal)
    if (folded.decision === 'deny') return { kind: 'reject' }
    const downstream = await next()
    const message = contextMessage(folded)
    if (!message || downstream.kind !== 'enter') return downstream
    return { ...downstream, messages: [...downstream.messages, message] }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    toolSummaries.note(exec)
    // Pending from here until the result arrives (post-execute): the alert hook below may hold its read-out and must know that.
    pendingQuestions.note({ sessionId: exec.agent?.id, callId: exec.callId, name: exec.name, signal: exec.signal })
    if (skip(exec.agent) || !hooks.PreToolUse) return next()
    const folded = await run('PreToolUse', toolQueries(exec.name), {
      tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId,
    }, exec.agent, exec.signal)
    if (folded.decision === 'deny') {
      pendingQuestions.release({ sessionId: exec.agent?.id, callId: exec.callId }) // the tool will not run: nothing is waiting
      return { kind: 'deny', reason: folded.reason ?? 'blocked by PreToolUse hook' }
    }
    if (folded.decision === 'ask') return { kind: 'ask', ...folded.reason ? { reason: folded.reason } : {} }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    pendingQuestions.release({ sessionId: exec.agent?.id, callId: exec.callId })
    if (skip(exec.agent) || !hooks.PostToolUse) return next()
    const folded = await run('PostToolUse', toolQueries(exec.name), {
      tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId,
      tool_response: textOf(result?.content),
    }, exec.agent, exec.signal)
    const message = contextMessage(folded)
    if (folded.decision === 'deny') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: folded.reason ?? 'blocked by PostToolUse hook' }],
        ...message ? { additionalContexts: [message] } : {},
      }
    }
    const downstream = await next()
    if (!message) return downstream
    return { ...downstream, additionalContexts: [message, ...downstream.additionalContexts ?? []] }
  })

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (skip(agent) || !hooks.Stop) return
    let last = ''
    try {
      const assistant = agent.session.deriveMessages().filter(m => m.role === 'assistant')
      last = textOf(assistant.at(-1)?.content).trim()
    } catch { /* best effort */ }
    const folded = await run('Stop', [''], { stop_hook_active: false, last_assistant_message: last }, agent, signal)
    if (folded.decision === 'deny') {
      agent.steer(makeMessage(folded.reason ?? 'continue: blocked by Stop hook'))
    }
  })

  // Observe-only: never answers the request, just lets hooks (e.g. TTS) react.
  ctx.on('approval/request', async (req, next) => {
    // off = plain next(); on = a spoken approve/deny races the GUI. The summary goes once the request is answered or withdrawn.
    // intercept() registers the pending entry synchronously, so it must run BEFORE the alert hooks: run() may hold the alert
    // right away (a flow is busy) and notes there whether voice already tracks this request (permissionIsPending).
    const answered = voice.intercept(req, next)
    if (hooks.PermissionRequest && !skip(req.agent)) {
      const message = `The agent needs your permission to use ${req.toolName}${req.reason ? `. ${req.reason}` : ''}`
      void run('PermissionRequest', toolQueries(req.toolName), {
        tool_name: req.toolName, message,
      }, req.agent, req.signal).catch(() => {})
    }
    return Promise.resolve(answered).finally(() => toolSummaries.drop(req))
  })
}
