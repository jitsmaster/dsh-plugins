import { lastParagraph, permissionHeadline, questionHeadline, stopHeadline } from './headline.js'

/** The tool names (both spellings) of the ask-the-user tool: the one definition every module shares. */
export const ASK_TOOLS = new Set(['ask_user_question', 'AskUserQuestion'])
export const isAskTool = (name) => typeof name === 'string' && ASK_TOOLS.has(name)

/**
 * The workspace a cwd belongs to: the last path segment (a drive root or a dot is no name), except that a git
 * worktree under ".worktrees" or ".claude/worktrees" is named after the repository that holds it.
 */
export function workspaceOf(cwd) {
  const parts = (cwd ? String(cwd).split(/[\\/]+/) : []).filter((s) => s && !/^[A-Za-z]:$|^\.+$/.test(s))
  const at = parts.findIndex((s, i) => s === '.worktrees' || (s === 'worktrees' && parts[i - 1] === '.claude'))
  if (at > 0) return parts[parts[at] === '.worktrees' ? at - 1 : at - 2] ?? ''
  return parts.at(-1) ?? ''
}

/**
 * Which task-list item an alert is about, for looking up its queue position (voice/alert-position.js): { type, sessionId, callId?,
 * toolName? } with the review queue's item type; undefined for an event that is no alert or has no session.
 */
export function alertLocator(event, { agentId, payload = {} } = {}) {
  if (!agentId) return undefined
  if (event === 'Stop') return { type: 'completed', sessionId: agentId }
  if (event === 'PermissionRequest') return { type: 'permission', sessionId: agentId, ...(typeof payload.tool_name === 'string' ? { toolName: payload.tool_name } : {}) }
  if (event === 'PreToolUse' && isAskTool(payload.tool_name)) return { type: 'question', sessionId: agentId, ...(payload.tool_use_id !== undefined ? { callId: payload.tool_use_id } : {}) }
  return undefined
}

export function createAlerts() {
  /**
   * A function (position?) => headline for a hook event, or undefined when the event is not an alert. It keeps only the small
   * strings the headline is made of (never the payload), so a held alert can be re-rendered when it is replayed, for the queue
   * position the item has by then (none: the old headline).
   */
  function headlineMaker(event, { cwd, sessionTitle, payload = {} } = {}) {
    if (event === 'Stop') {
      const parts = { session: String(sessionTitle ?? '').trim(), workspace: workspaceOf(cwd), summary: lastParagraph(payload.last_assistant_message) }
      return (position) => stopHeadline({ ...parts, position })
    }
    if (event === 'PermissionRequest') {
      const toolName = payload.tool_name
      return (position) => permissionHeadline({ toolName, position })
    }
    if (event === 'PreToolUse' && isAskTool(payload.tool_name)) {
      const first = (Array.isArray(payload.tool_input?.questions) ? payload.tool_input.questions : []).map((q) => q?.question).find((q) => typeof q === 'string' && q.trim())
      const questions = first ? [{ question: first }] : []
      return (position) => questionHeadline({ questions, position })
    }
    return undefined
  }
  return {
    headlineMaker,
    /** The short spoken line for a hook event, or undefined when the event is not an alert. A position (1-based, in the task list) makes it say "Item three, ...". */
    headlineFor(event, { agentId, cwd, sessionTitle, payload = {}, position } = {}) {
      return headlineMaker(event, { cwd, sessionTitle, payload })?.(position)
    },
  }
}

/** The JSON a hook script receives on stdin, with the spoken headline for alert events. */
export function buildHookBody({ event, agent, cwd, sessionTitle, payload, alerts, position }) {
  const headline = alerts.headlineFor(event, { agentId: agent?.id, cwd, sessionTitle, payload, position })
  return {
    session_id: agent?.session?.header?.id ?? '',
    session_title: sessionTitle ?? '',
    transcript_path: '',
    cwd: cwd ?? process.cwd(),
    hook_event_name: event,
    ...payload,
    ...(headline ? { headline } : {}),
  }
}
