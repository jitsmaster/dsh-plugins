import { permissionHeadline, questionHeadline, stopHeadline } from './headline.js'

const ASK_TOOLS = new Set(['ask_user_question', 'AskUserQuestion'])

/** The last path segment, for Windows or POSIX paths with or without a trailing separator. */
const projectOf = (cwd) => (cwd ? String(cwd).split(/[\\/]+/).filter(Boolean).at(-1) ?? '' : '')

export function createAlerts({ numbers }) {
  return {
    /** The short spoken line for a hook event, or undefined when the event is not an alert. */
    headlineFor(event, { agentId, cwd, payload = {} } = {}) {
      if (!agentId) return undefined
      if (event === 'Stop') return stopHeadline({ number: numbers.numberFor(agentId), project: projectOf(cwd) })
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
