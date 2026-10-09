import { lastParagraph, permissionHeadline, questionHeadline, stopHeadline } from './headline.js'

const ASK_TOOLS = new Set(['ask_user_question', 'AskUserQuestion'])

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

export function createAlerts({ numbers }) {
  return {
    /** The short spoken line for a hook event, or undefined when the event is not an alert. */
    headlineFor(event, { agentId, cwd, sessionTitle, payload = {} } = {}) {
      if (event === 'Stop') {
        if (agentId) numbers.numberFor(agentId) // not spoken any more, but the number stays reserved for voice commands
        return stopHeadline({
          session: String(sessionTitle ?? '').trim(),
          workspace: workspaceOf(cwd),
          summary: lastParagraph(payload.last_assistant_message),
        })
      }
      if (!agentId) return undefined
      if (event === 'PermissionRequest') {
        return permissionHeadline({ number: numbers.numberFor(agentId), toolName: payload.tool_name })
      }
      if (event === 'PreToolUse' && ASK_TOOLS.has(payload.tool_name)) {
        return questionHeadline({ number: numbers.numberFor(agentId), questions: payload.tool_input?.questions })
      }
      return undefined
    },
  }
}

/** The JSON a hook script receives on stdin, with the spoken headline for alert events. */
export function buildHookBody({ event, agent, cwd, sessionTitle, payload, alerts }) {
  const headline = alerts.headlineFor(event, { agentId: agent?.id, cwd, sessionTitle, payload })
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
