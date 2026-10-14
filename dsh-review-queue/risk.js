/**
 * What a permission card should warn about. Pattern based and deliberately conservative: it flags the usual ways a tool
 * call can destroy work or leave the workspace, so the user looks twice. It never blocks anything.
 */

const MAX_DETAIL = 3000
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g
const TOOL_ARG_KEYS = ['command', 'file_path', 'path', 'url', 'pattern', 'query']

/** The whole telling argument of a tool call (the command, the path...): newlines kept, control characters dropped, capped. */
export function toolDetail(name, args) {
  for (const key of TOOL_ARG_KEYS) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim()) {
      const text = value.replace(/\r\n?/g, '\n').replace(CONTROL, '')
      return text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL) + '…' : text
    }
  }
  return ''
}

const RULES = [
  ['recursive-delete', 'Deletes files recursively', [
    /(^|[\s;&|(])rm\s+(?:-[a-z]*r[a-z]*\b|--recursive\b)/i,
    /\b(?:remove-item|ri|rm|del|rd|rmdir)\b[^\n|;]*\s-recurse\b/i,
    /\b(?:rd|rmdir)\s+\/s\b/i,
    /\bdel\s+[^\n]*\/s\b/i,
  ]],
  ['force-push', 'Force-pushes and can overwrite remote history', [/\bgit\s+push\b[^\n;|&]*(?:\s--force(?:-with-lease)?\b|\s-f\b)/i]],
  ['hard-reset', 'Hard reset throws away uncommitted changes', [/\bgit\s+reset\b[^\n;|&]*--hard\b/i]],
  ['git-clean', 'git clean deletes untracked files', [/\bgit\s+clean\b[^\n;|&]*\s-[a-z]*f/i]],
  ['pipe-to-shell', 'Runs a downloaded script without looking at it', [/\b(?:curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n]*\|\s*(?:sh|bash|zsh|iex|invoke-expression|powershell|pwsh)\b/i]],
  ['elevated', 'Runs with elevated rights', [/(^|[\s;&|(])(?:sudo|runas)\b/i, /\bchmod\s+(?:-R\s+)?0?777\b/i]],
  ['disk', 'Touches disks or partitions', [/\b(?:mkfs\w*|format-volume|diskpart)\b/i, /\bdd\s+[^\n]*of=\/dev\//i]],
]

const norm = (p) => {
  const parts = []
  for (const part of String(p).replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/').toLowerCase()
}

/** @returns {{ code: string, label: string }[]} */
export function riskOf({ toolName, detail, path, workspace } = {}) {
  const risks = []
  try {
    const text = typeof detail === 'string' ? detail : ''
    for (const [code, label, patterns] of RULES) {
      if (patterns.some((re) => re.test(text))) risks.push({ code, label })
    }
    if (typeof path === 'string' && path && typeof workspace === 'string' && workspace) {
      const root = norm(workspace)
      const target = norm(path)
      if (root && target !== root && !target.startsWith(root + '/')) risks.push({ code: 'outside-workspace', label: 'Writes outside this session’s workspace' })
    }
  } catch { /* a warning must never break a card */ }
  void toolName
  return risks
}
