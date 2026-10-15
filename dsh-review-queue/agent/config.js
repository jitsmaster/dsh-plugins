/**
 * Small decisions of the hub wiring (docs/hub.md 7, 8): is the hub on, which key and label name this DSH app at the hub.
 * The key is the DSH home plus the web port, so the same app after a restart is recognised (its dead questions end, its other items
 * move over) and another app on another port is not. Without a port the key is made from the pid and the start time: never adopted.
 * The web port changes at every DSH start, so the key is only a shortcut: what really carries items over a restart is the adoption by
 * session id (docs/hub.md 6.3). The host may report the port after the plugin was applied, so awaitPort gives it a bounded time.
 */
import { createHash } from 'node:crypto'

const MAX_LABEL = 80

/** On by default; config hub:false or env DSH_RQ_HUB=0 keeps the plugin standalone exactly as before the hub existed. */
export function hubEnabled(config = {}, env = process.env) {
  return config.hub !== false && env.DSH_RQ_HUB !== '0'
}

/** @param {{ dshHome: string, port?: number, pid?: number, startedAt?: number }} opts */
export function instanceKeyOf({ dshHome, port, pid = process.pid, startedAt = Date.now() }) {
  if (Number.isInteger(port) && port > 0) return createHash('sha256').update(String(dshHome) + '\u0000' + port).digest('hex').slice(0, 32)
  return 'pid-' + pid + '-' + startedAt.toString(36)
}

export function instanceLabelOf(config = {}, port) {
  const own = typeof config.instanceLabel === 'string' ? config.instanceLabel.trim().slice(0, MAX_LABEL) : ''
  if (own) return own
  return Number.isInteger(port) && port > 0 ? 'DSH :' + port : 'DSH'
}

/**
 * Waits (at most timeoutMs) until portOf() answers a usable port; undefined when it never does, so the caller falls back to the pid key.
 * Answers at once when the port is already known. The timer does not keep the process alive.
 * @param {() => unknown} portOf
 */
export async function awaitPort(portOf, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const port = portOf()
    if (Number.isInteger(port) && port > 0) return port
    if (Date.now() >= end) return undefined
    await new Promise((resolve) => setTimeout(resolve, intervalMs).unref?.())
  }
}
