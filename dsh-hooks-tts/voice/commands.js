/**
 * Spoken-command registry: maps a transcript to a DSH command or action. Anything that is not an exact command
 * (or a command plus a target/argument in the shapes below) is dictation, so a sentence that merely starts with
 * "stop" or "approve" is never mistaken for one.
 */

const PRESETS = [
  { preset: 'danger-full-access', en: ['full access', 'danger full access'], zh: ['完全访问', '完全权限'] },
  { preset: 'workspace-write', en: ['workspace write', 'workspace'], zh: ['工作区写入', '工作区'] },
]

/**
 * action: what the plugin does. 'slash' runs the DSH human command named by `slash`; 'session' calls the session
 * controller; 'approval' answers the pending permission request; 'ui' acts on the session list.
 * arg: 'text' | 'number' | 'preset' = a required argument after the phrase; absent = the phrase must stand alone.
 */
export const COMMANDS = [
  { id: 'cancel', action: 'session', method: 'cancel', en: ['stop', 'cancel', 'interrupt', 'abort'], zh: ['停止', '取消', '中断'] },
  { id: 'approve', action: 'approval', decision: 'approve', en: ['approve', 'approved', 'approves', 'allow', 'yes'], zh: ['批准', '允许', '同意', '是'] },
  { id: 'deny', action: 'approval', decision: 'deny', en: ['deny', 'denied', 'denies', 'reject', 'refuse', 'no'], zh: ['拒绝', '不同意', '否'] },
  { id: 'session-new', action: 'session', method: 'create', en: ['new session'], zh: ['新会话', '新建会话'] },
  { id: 'session-fork', action: 'session', method: 'fork', confirm: true, en: ['fork session', 'fork this session'], zh: ['分叉会话', '分支会话'] },
  { id: 'session-rename', action: 'session', method: 'rename', arg: 'text', en: ['rename session to', 'rename this session to', 'rename session'], zh: ['重命名会话', '重命名'] },
  { id: 'session-switch', action: 'ui', arg: 'text', noTarget: true, en: ['switch to', 'go to'], zh: ['切换到', '切换'] },
  { id: 'model-select', action: 'session', method: 'selectModel', arg: 'text', en: ['use model', 'select model'], zh: ['使用模型', '选择模型'] },
  { id: 'option', action: 'approval', decision: 'option', arg: 'number', en: ['option', 'choose', 'select', 'number'], zh: ['选项', '选择'] },
  { id: 'compact', action: 'slash', slash: 'compact', en: ['compact', 'compact history'], zh: ['压缩', '压缩历史'] },
  { id: 'plan', action: 'slash', slash: 'plan', en: ['plan mode', 'enter plan mode', 'leave plan mode', 'exit plan mode'], zh: ['计划模式', '进入计划模式', '退出计划模式'] },
  { id: 'goal', action: 'slash', slash: 'goal', arg: 'text', en: ['goal'], zh: ['目标'] },
  { id: 'feedback', action: 'slash', slash: 'feedback', arg: 'text', en: ['feedback'], zh: ['反馈'] },
  { id: 'export', action: 'slash', slash: 'export', en: ['export', 'export session'], zh: ['导出'] },
  { id: 'permission', action: 'slash', slash: 'permission', arg: 'preset', en: ['permission'], zh: ['权限'] },
]

const ZH_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const EN_NUMBERS = {
  one: 1, won: 1, two: 2, too: 2, to: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

export function parseNumber(text) {
  const t = String(text ?? '').trim().toLowerCase()
  if (/^\d{1,3}$/.test(t)) return Number(t)
  if (t in EN_NUMBERS) return EN_NUMBERS[t]
  if (/^[零一二两三四五六七八九十]{1,3}$/.test(t)) {
    if (t === '十') return 10
    if (t.length === 1) return ZH_DIGITS[t]
    if (t[0] === '十') return 10 + ZH_DIGITS[t[1]]
    if (t[1] === '十') return ZH_DIGITS[t[0]] * 10 + (t[2] ? ZH_DIGITS[t[2]] : 0)
  }
  return undefined
}

const clean = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Optimal-string-alignment distance (insert, delete, substitute, adjacent swap). */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

/** Exact match, or one slip in a single word of 5+ letters (shorter words are too easy to hit by accident). */
function phraseEquals(lower, phrase) {
  if (lower === phrase) return true
  return !/\s/.test(phrase) && !/\s/.test(lower) && phrase.length >= 5 && /^[a-z]+$/.test(phrase) && distance(lower, phrase) <= 1
}

function phrasesOf(cmd) {
  return [...cmd.en, ...cmd.zh].map((p) => p.toLowerCase())
}

function matchStandalone(lower) {
  for (const cmd of COMMANDS) {
    if (cmd.arg) continue
    if (phrasesOf(cmd).some((p) => phraseEquals(lower, p))) return cmd
  }
  return undefined
}

function stripTarget(text) {
  const lower = text.toLowerCase()
  const en = lower.match(/^(.+?)\s+(?:in|on|for)\s+(?:the\s+)?(.+)$/)
  if (en) {
    const cmd = matchStandalone(en[1])
    if (cmd) return { cmd, target: text.slice(text.length - en[2].length) }
  }
  if (lower.startsWith('在')) {
    const rest = text.slice(1).trim()
    for (const cmd of COMMANDS) {
      if (cmd.arg) continue
      for (const p of cmd.zh) {
        if (rest.toLowerCase().endsWith(p) && rest.length > p.length) {
          return { cmd, target: rest.slice(0, rest.length - p.length).trim() }
        }
      }
    }
  }
  return undefined
}

const route = (cmd) => ({ id: cmd.id, action: cmd.action, ...(cmd.method ? { method: cmd.method } : {}), ...(cmd.decision ? { decision: cmd.decision } : {}), ...(cmd.slash ? { slash: cmd.slash } : {}) })

function matchWithArgument(text, lower) {
  for (const cmd of COMMANDS) {
    if (!cmd.arg) continue
    const prefixes = phrasesOf(cmd).sort((a, b) => b.length - a.length)
    for (const p of prefixes) {
      const cjk = /[^\x00-\x7f]/.test(p)
      if (!(lower === p || lower.startsWith(cjk ? p : p + ' '))) continue
      const rest = text.slice(p.length).trim()
      if (!rest) continue
      if (cmd.arg === 'text') return { ...route(cmd), args: { text: rest }, ...(cmd.confirm ? { confirm: true } : {}) }
      if (cmd.arg === 'number') {
        const n = parseNumber(rest)
        if (n === undefined) continue
        return { ...route(cmd), args: { number: n } }
      }
      if (cmd.arg === 'preset') {
        const r = rest.toLowerCase()
        const hit = PRESETS.find((x) => [...x.en, ...x.zh].some((w) => w === r))
        if (!hit) continue
        return { ...route(cmd), args: { preset: hit.preset }, ...(hit.preset === 'danger-full-access' ? { confirm: true } : {}) }
      }
    }
  }
  return undefined
}

/**
 * The command a transcript names, or undefined when it is dictation.
 * Shape: { id, action, args, target?, confirm? } (see COMMANDS for what each action means).
 */
export function matchCommand(transcript) {
  const text = clean(transcript)
  if (!text) return undefined
  const lower = text.toLowerCase()
  const withArg = matchWithArgument(text, lower)
  if (withArg) return withArg
  const own = matchStandalone(lower)
  if (own) return build(own)
  const split = stripTarget(text)
  if (split && !split.cmd.noTarget) return build(split.cmd, split.target)
  return undefined
}

function build(cmd, target) {
  return { ...route(cmd), args: {}, ...(target ? { target } : {}), ...(cmd.confirm ? { confirm: true } : {}) }
}

const YES = ['yes', 'yeah', 'yep', 'confirm', 'confirmed', 'do it', 'go ahead', 'ok', 'okay', 'sure', '确认', '确定', '是', '是的', '好', '好的']
const NO = ['no', 'nope', 'deny', 'denied', 'cancel', 'stop', 'never mind', 'reject', '不', '不要', '取消', '否', '拒绝']

/** 'yes' | 'no' | undefined for a reply to a read-back; undefined means keep waiting (or treat as dictation). */
export function resolveConfirmation(transcript) {
  const lower = clean(transcript).toLowerCase()
  if (!lower) return undefined
  if (YES.some((p) => phraseEquals(lower, p))) return 'yes'
  if (NO.some((p) => phraseEquals(lower, p))) return 'no'
  return undefined
}

/**
 * Pick the target session: a spoken name matches by partial title (every word must appear); with no name, the last
 * session that alerted. Returns the session, { ambiguous: [...] } when several match, or undefined.
 */
export function resolveSession(name, sessions, lastAlertedId) {
  const spoken = clean(name).toLowerCase()
  if (!spoken) return sessions.find((s) => s.id === lastAlertedId)
  const words = spoken.split(' ')
  const hits = sessions.filter((s) => {
    const title = clean(s.title).toLowerCase()
    return words.every((w) => title.includes(w))
  })
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    const exact = hits.filter((s) => clean(s.title).toLowerCase() === spoken)
    return exact.length === 1 ? exact[0] : { ambiguous: hits }
  }
  return undefined
}

/**
 * Build a match from an id and arguments produced elsewhere (the LLM router). Returns undefined for an unknown id or
 * a missing/invalid argument, so callers never act on a half-formed command.
 */
export function makeMatch(id, args = {}, target) {
  const cmd = COMMANDS.find((x) => x.id === id)
  if (!cmd) return undefined
  const out = { ...route(cmd), args: {}, ...(target ? { target } : {}), ...(cmd.confirm ? { confirm: true } : {}) }
  if (cmd.arg === 'text') {
    const text = String(args.text ?? '').trim()
    if (!text) return undefined
    out.args = { text }
  } else if (cmd.arg === 'number') {
    if (!Number.isInteger(args.number) || args.number < 1 || args.number > 99) return undefined
    out.args = { number: args.number }
  } else if (cmd.arg === 'preset') {
    if (!PRESETS.some((p) => p.preset === args.preset)) return undefined
    out.args = { preset: args.preset }
    if (args.preset === 'danger-full-access') out.confirm = true
  }
  return out
}

/** A short spoken description of what a match will do, for the acknowledgement and the confirmation read-back. */
export function describeMatch(match, title) {
  const where = title ? ` in ${title}` : ''
  const a = match.args ?? {}
  switch (match.id) {
    case 'cancel': return title ? `Stopping ${title}` : 'Stopping'
    case 'approve': return `Approving${where}`
    case 'deny': return `Denying${where}`
    case 'option': return `Choosing option ${a.number}${where}`
    case 'session-new': return 'Starting a new session'
    case 'session-fork': return `Forking session${title ? ' ' + title : ''}`
    case 'session-rename': return `Renaming${title ? ' ' + title : ' the session'} to ${a.text}`
    case 'session-switch': return `Now talking to ${title ?? a.text}`
    case 'model-select': return `Selecting model ${a.text}${where}`
    case 'compact': return `Compacting${title ? ' ' + title : ''}`
    case 'plan': return `Toggling plan mode${where}`
    case 'goal': return `Setting the goal${where} to: ${a.text}`
    case 'feedback': return `Recording feedback${where}${a.text ? ': ' + a.text : ''}`
    case 'export': return `Exporting${title ? ' ' + title : ' the session'}`
    case 'permission': return `Switching permission to ${a.preset}${where}`
    default: return match.id
  }
}

/** One line per command for the router's prompt. */
export function commandCatalog() {
  return COMMANDS.map((c) => {
    const arg = c.arg === 'text' ? ' args: {"text": string}' : c.arg === 'number' ? ' args: {"number": 1-99}' : c.arg === 'preset' ? ' args: {"preset": "danger-full-access"|"workspace-write"}' : ''
    return `- ${c.id}: e.g. "${c.en[0]}" / "${c.zh[0]}"${arg}`
  }).join('\n')
}
