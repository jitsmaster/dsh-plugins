/**
 * AI triage, the PURE part (phase 2 of the plan in the vault note "Review Queue AI Triage Design Spec"): no model call, no store, no I/O.
 * The LLM scores every item (attention 0-100, higher = needs the user). An item can be processed only when that score is at or below the rule's
 * threshold: the score is a NECESSARY gate, never a sufficient one. Every hard veto (rule, class, user marks, risk flags, code-computed safety
 * facts, admissible evidence) still wins over a low score, because text the judged agent wrote can steer the model.
 */
import { recommendedOf } from './speech.js'

/** Items scoring at or below this are candidates for processing (a rule may set its own, never above MAX_THRESHOLD). */
export const DEFAULT_THRESHOLD = 25
/** A rule cannot raise its threshold above this, so a big threshold is not a way to pass everything. */
export const MAX_THRESHOLD = 50
const MIN_QUOTE_CHARS = 8

const CLASS_OF = { question: 'question', permission: 'permission', completed: 'done', paused: 'idle' }
/** The rule class an item type belongs to (a rule's class must equal it); undefined for a type triage never touches. */
export const classOf = (item) => (item && typeof item.type === 'string' ? CLASS_OF[item.type] : undefined)

/** A score as a number 0-100; anything else is undefined (the caller asks the user). */
export function clampAttention(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, value))
}

/** Whitespace, tabs and line wraps collapsed to single spaces, so a quote survives re-wrapping. */
export const normalizeQuote = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '')

/**
 * The id of the USER-AUTHORED source that holds the quote verbatim (after normalising), else undefined. Sources the user did not write
 * (the item body, earlier assistant turns) never count: the judged agent could plant its own basis there.
 * @param {string} quote
 * @param {{ id: string, text: string, userAuthored?: boolean }[]} sources
 */
export function quoteSource(quote, sources) {
  const q = normalizeQuote(quote)
  if (q.length < MIN_QUOTE_CHARS || !Array.isArray(sources)) return undefined
  for (const s of sources) if (s && s.userAuthored === true && normalizeQuote(s.text).includes(q)) return s.id
  return undefined
}

// --- read-only command parser -------------------------------------------------------------------------------------------------------
const PLAIN = new Set(['pwd', 'ls', 'cat', 'rg', 'grep', 'head', 'tail', 'wc'])
const GIT_READ = new Set(['status', 'diff', 'log', 'show'])
const SHELL_SYNTAX = /[;&|`$(){}<>\r\n"'\\*?!]/
const GIT_BAD_FLAG = /^--(output|exec-path|open-files-in-pager|ext-diff|textconv|upload-pack|receive-pack)/
const RG_BAD_FLAG = /^--(pre|hostname-bin)/
const PROTECTED = [/(^|\/)\.env/i, /(^|\/)\.git(\/|$)/i, /^~/, /(^|\/)\.(ssh|aws|dsh|claude|gnupg)(\/|$)/i, /id_(rsa|ed25519|ecdsa|dsa)/i, /\.(pem|key|p12|pfx)$/i, /(credentials|secrets?)(\.|$|\/)/i]
const fail = (reason) => ({ ok: false, reason })

/**
 * Strict allowlist: ONE plain command from a short list (git only status/diff/log/show), no operators, no redirects, no quotes, no
 * substitution, no `..`, no protected path (reading `.env` counts as touching it). Containment inside the workspace is checked separately in code.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function parseReadOnlyCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return fail('empty')
  if (SHELL_SYNTAX.test(command)) return fail('shell syntax')
  const tokens = command.trim().split(/\s+/)
  const bin = tokens[0]
  let args
  if (bin === 'git') {
    if (!GIT_READ.has(tokens[1])) return fail('git subcommand not allowed')
    args = tokens.slice(2)
    if (args.some((t) => GIT_BAD_FLAG.test(t))) return fail('git flag not allowed')
  } else if (PLAIN.has(bin)) {
    args = tokens.slice(1)
    if (bin === 'rg' && args.some((t) => RG_BAD_FLAG.test(t))) return fail('rg flag not allowed')
  } else return fail('command not on the allowlist')
  for (const t of args) {
    const p = t.replace(/\\/g, '/')
    if (p.split('/').includes('..')) return fail('path leaves the directory')
    if (PROTECTED.some((re) => re.test(p))) return fail('protected path')
  }
  return { ok: true }
}

// --- the verdict --------------------------------------------------------------------------------------------------------------------
const thresholdOf = (rule) => (typeof rule?.threshold === 'number' && Number.isFinite(rule.threshold) && rule.threshold >= 0 ? Math.min(rule.threshold, MAX_THRESHOLD) : DEFAULT_THRESHOLD)

const labelOf = (o) => String(o?.label ?? o ?? '').trim().toLowerCase()

/** An answer to a question that offers options must be one of them (case and surrounding spaces ignored); a free-text question has nothing to check. */
function isOffered(answer, item) {
  const options = item?.payload?.questions?.[0]?.options
  if (!Array.isArray(options) || !options.length) return true
  return typeof answer === 'string' && options.some((o) => labelOf(o) === answer.trim().toLowerCase())
}

/** Auto only: the answer is EXACTLY one offered label (case and spaces as on the card); a question without options never qualifies. */
function isOfferedExactly(answer, item) {
  const options = item?.payload?.questions?.[0]?.options
  return typeof answer === 'string' && Array.isArray(options) && options.some((o) => o?.label === answer)
}

function questionBasis(judgment, rule, sources, reasons, item) {
  const auto = rule.mode === 'auto'
  const basis = judgment.answer_basis
  if (basis === 'closed-set') {
    if (!Array.isArray(rule.closedSet) || !rule.closedSet.includes(judgment.answer)) reasons.push('answer-not-in-set')
    if (auto) reasons.push('inadmissible-evidence') // auto answers only from a quote the user wrote
  } else if (basis === 'quoted-source') {
    const found = quoteSource(judgment.evidence_quote, sources)
    if (found === undefined || found !== judgment.evidence_source) reasons.push('inadmissible-evidence')
  } else { reasons.push('no-basis'); return }
  if (!(auto ? isOfferedExactly(judgment.answer, item) : isOffered(judgment.answer, item))) reasons.push('answer-not-an-option')
  // Auto only: when the card marks a recommended option, that is the only one the AI may answer.
  else if (auto) {
    const rec = recommendedOf(item?.payload?.questions?.[0])
    if (rec !== undefined && judgment.answer !== rec) reasons.push('answer-not-recommended')
  }
}

/**
 * @param {{ item: object, judgment?: object, rule?: object, facts?: object, sources?: object[], marks?: object }} input
 *   facts: what CODE computed (riskFlags[], safe, readOnly?, outsideWorkspace?, reversible?, needsUser? (strict), needsUserObserve? (weaker, observe-mode only), sessionContinues?); sources: evidence sources by id;
 *   relax: { sessionFinished?: true } lifts the session-finished veto only for an observe-mode rule of the done class (fails closed for auto or any other mode; never applies to questions).
 *   A question rule's answer must also be one of the offered options (reason 'answer-not-an-option'); a question without options skips that check.
 * @returns {{ verdict: 'handle' | 'ask', act: boolean, score?: number, threshold: number, reasons: string[] }}
 *   act is true only for a handled item whose rule is in `auto`; `observe` handles on paper only. reasons lists EVERY veto that applied.
 */
export function triageOutcome({ item, judgment, rule, facts, sources = [], marks = {}, relax = {} }) {
  const reasons = []
  const threshold = thresholdOf(rule)
  const j = judgment && typeof judgment === 'object' ? judgment : undefined
  const score = j ? clampAttention(j.attention) : undefined
  if (score === undefined) reasons.push('bad-judgment')
  if (!rule || !j?.matched_rule) reasons.push('no-rule')
  else if (j.matched_rule !== rule.id) reasons.push('rule-mismatch')
  if (rule) {
    if (rule.class !== classOf(item)) reasons.push('class-mismatch')
    if (rule.mode === 'off') reasons.push('rule-off')
    if (rule.enabled === false) reasons.push('rule-disabled')
  }
  if (marks.onHold || marks.neverAuto) reasons.push('user-mark')
  if (!facts) reasons.push('unsafe')
  else {
    if (Array.isArray(facts.riskFlags) && facts.riskFlags.length) reasons.push('risk')
    if (facts.safe !== true) reasons.push('unsafe')
  }
  if (j) {
    if (j.needs_decision !== false) reasons.push('needs-decision')
    // The model's own safety claims are advisory: a disagreement with what code computed is a veto.
    if (facts && ((j.read_only !== undefined && facts.readOnly !== undefined && j.read_only !== facts.readOnly)
      || (j.touches_outside_workspace !== undefined && facts.outsideWorkspace !== undefined && j.touches_outside_workspace !== facts.outsideWorkspace)
      || (j.reversible !== undefined && facts.reversible !== undefined && j.reversible !== facts.reversible))) reasons.push('advisory-disagrees')
    if (rule && rule.class === 'question') {
      // Auto only: one plain option question that can be answered through its live request; missing facts fail closed.
      if (rule.mode === 'auto' && facts?.questionSimple !== true) reasons.push('question-not-simple')
      questionBasis(j, rule, sources, reasons, item)
    }
  }
  if (rule && rule.class === 'done' && facts) {
    // The weaker check may only gate observe; any other mode (auto, off, unknown) fails closed on the strict one.
    const needs = rule.mode === 'observe' ? (facts.needsUserObserve ?? facts.needsUser) : facts.needsUser
    if (needs !== false) reasons.push('needs-user')
    if (facts.sessionContinues !== true && !(relax?.sessionFinished === true && rule.class === 'done' && rule.mode === 'observe')) reasons.push('session-finished')
    // Auto only: a done card with an action item, or whose summary the summarizer has not settled yet, is never cleared. Missing facts fail closed.
    if (rule.mode === 'auto') {
      if (facts.actionItem !== false) reasons.push('action-item')
      if (facts.summaryPending !== false) reasons.push('summary-pending')
    }
  }
  // Auto only, permission class: the command must have been captured whole and every path argument must resolve (real path) inside the workspace. Missing facts fail closed.
  if (rule && rule.class === 'permission' && rule.mode === 'auto') {
    if (facts?.commandIntact !== true) reasons.push('command-truncated')
    if (facts?.pathsContained !== true) reasons.push('outside-workspace-real')
  }
  if (score !== undefined && score > threshold) reasons.push('score-above-threshold')
  const verdict = reasons.length ? 'ask' : 'handle'
  return { verdict, act: verdict === 'handle' && rule?.mode === 'auto', ...(score === undefined ? {} : { score }), threshold, reasons }
}
