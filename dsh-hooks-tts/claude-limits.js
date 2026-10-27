/**
 * Claude plan limits from the reading the `claude-code` LLM provider
 * (`@deepseek-ai/dsh-llm-claude-code`, option `rateLimitFile`) saves after each call.
 * Nothing here talks to Anthropic: the reading is a side effect of ordinary Claude Code runs.
 *
 * File shape: `{ updatedAt, fiveHour?: { utilization, resetsAt }, sevenDay?: { utilization, resetsAt } }`
 * with `utilization` a 0..1 fraction and `resetsAt` epoch SECONDS.
 */

const WINDOWS = [
  ['fiveHour', 'session', 'Current session'],
  ['sevenDay', 'weekly_all', 'Current week (all models)'],
]

/**
 * Map a saved reading to the widget's `limits` shape.
 * A window whose reset time has passed is shown at 0% without a reset time, because the stored figure is stale.
 * @param {unknown} data - parsed file content.
 * @param {number} now - current time in epoch milliseconds.
 * @returns {{ kind: string, label: string, percent: number, resetsAt?: string, severity: string }[]}
 */
export function limitsFromReading(data, now = Date.now()) {
  const limits = []
  if (typeof data !== 'object' || data === null) return limits
  for (const [key, kind, label] of WINDOWS) {
    const window = data[key]
    if (typeof window !== 'object' || window === null) continue
    const { utilization, resetsAt } = window
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) continue
    if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) continue
    const expired = resetsAt * 1000 <= now
    const percent = expired ? 0 : Math.max(0, Math.min(100, Math.round(utilization * 100)))
    limits.push({
      kind,
      label,
      percent,
      ...expired ? {} : { resetsAt: new Date(resetsAt * 1000).toISOString() },
      severity: percent >= 90 ? 'high' : 'normal',
    })
  }
  return limits
}
