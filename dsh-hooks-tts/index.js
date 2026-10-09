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
import { mkdirSync, readFileSync } from 'node:fs'
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

export const name = 'hooks-tts'

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
        })),
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
  ctx.effect(() => async () => {
    controller.abort()
    await Promise.allSettled([...pending])
  }, 'hooks-tts: abort running hooks')

  const settings = createSettings(stateDir, { contextCapTokens: config.contextCapTokens })
  const worktrees = createWorktreeTracker(stateDir)
  const groups = createGroups(stateDir, { trace: (line) => ctx.logger.warn(`hooks-tts: ${line}`) })
  startStatusService(ctx, config, stateDir, controller.signal, settings, worktrees, groups)

  // Record the worktree each session actually works in (its cwd stays at the launch directory).
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const id = exec.agent?.id
    if (id) void worktrees.observe(id, exec.arguments, exec.agent.session?.header?.cwd)
    return next()
  })

  const children = new Set()
  ctx.on('subagent/start', (info) => { children.add(info.id) })
  ctx.on('subagent/end', (info) => { children.delete(info.id) })
  const skip = agent => skipSubagents && agent && children.has(agent.id)

  /**
   * Run every matching hook for `event`. Async hooks are fired and tracked but not
   * awaited. Returns the folded decision/context of the synchronous hooks.
   */
  async function run(event, queries, payload, agent, signal) {
    const cwd = agent?.session?.header?.cwd
    const env = { ...baseEnv, CLAUDE_PROJECT_DIR: cwd ?? baseEnv.CLAUDE_PROJECT_DIR ?? process.cwd() }
    let sessionTitle
    try { sessionTitle = ctx.get('sessionTitle')?.get(agent?.session)?.title } catch { /* title is optional */ }
    const body = {
      session_id: agent?.session?.header?.id ?? '',
      session_title: sessionTitle ?? '',
      transcript_path: '',
      cwd: cwd ?? process.cwd(),
      hook_event_name: event,
      ...payload,
    }
    const folded = { decision: undefined, reason: undefined, context: [] }
    for (const group of hooks[event] ?? []) {
      if (!matchesAny(group.matcher, queries)) continue
      for (const hook of group.hooks) {
        // TTS hooks (the detached speak launchers) are switched together from the sidebar.
        if (hook.args?.some(a => /detach-launcher\.ps1$/.test(a)) && !settings.get().ttsEnabled) continue
        const opts = {
          cwd, env, defaultTimeoutMs,
          signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        }
        const job = runCommand(hook, body, opts)
        if (hook.async) {
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
  let contextCap
  const prPoller = installPrPoller(ctx, config, { settings, skip, signal: controller.signal, onPrCreated: (agent, id) => contextCap?.prCreated(agent, id) })
  // A restart drops the in-memory polls: re-register every "PR <n>" session. The host services may not be ready at
  // once, so retry a few times (restore is idempotent).
  for (const ms of [5_000, 20_000, 60_000]) {
    const timer = setTimeout(() => { void prPoller.restore().catch(() => {}) }, ms)
    timer.unref?.()
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  }
  contextCap = installContextCap(ctx, config, { skip, makeMessage, settings, prHandoff: (agent) => prPoller.handoffLines(agent.id), groups, waitForPr: (sessionId, prId) => prPoller.addWait(sessionId, prId) })
  installAskUserTuning(ctx, { skip, makeMessage })

  ctx.on('agent/created', async ({ agent, source, signal }) => {
    if (skip(agent)) return
    try {
      const folded = await run('SessionStart', [source ?? 'startup'], { source }, agent, signal)
      const message = contextMessage(folded)
      if (message) agent.inject(message)
    } catch (error) {
      ctx.logger.warn(`hooks-tts: SessionStart failed: ${String(error)}`)
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
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
    if (skip(exec.agent) || !hooks.PreToolUse) return next()
    const folded = await run('PreToolUse', toolQueries(exec.name), {
      tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId,
    }, exec.agent, exec.signal)
    if (folded.decision === 'deny') return { kind: 'deny', reason: folded.reason ?? 'blocked by PreToolUse hook' }
    if (folded.decision === 'ask') return { kind: 'ask', ...folded.reason ? { reason: folded.reason } : {} }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
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
    if (hooks.PermissionRequest && !skip(req.agent)) {
      const message = `The agent needs your permission to use ${req.toolName}${req.reason ? `. ${req.reason}` : ''}`
      void run('PermissionRequest', toolQueries(req.toolName), {
        tool_name: req.toolName, message,
      }, req.agent, req.signal).catch(() => {})
    }
    return next()
  })
}
