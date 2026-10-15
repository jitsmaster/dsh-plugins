/**
 * One-time import of the legacy shared state (docs/hub.md section 12), run by the first hub start that finds no hub/queue.json:
 * queue.json (v1) is copied to hub/queue.v1-import-<ts>.json and loaded into hub/queue.json (v2): open questions and permission
 * requests become session-ended (their promises died with the old process), completed / pr-merged / todo stay open as orphans
 * without an owner, resolved items keep their retention. vapid.json is copied to hub/vapid.json so push subscriptions stay valid, and a
 * push.json (phones registered with a pre-hub build) to hub/push.json: those phones keep their pushes as legacy devices without a token.
 * The old files are never written (an older plugin build may still use them). Counts only in the log, never item text or keys.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readText, writeAtomic } from './atomic-file.js'
import { QUEUE_VERSION } from './hub-store.js'

const ENDED = new Set(['question', 'permission'])
const usable = (i) => i && typeof i.id === 'string' && typeof i.type === 'string'

/** One private legacy file copied into the hub folder, once (an existing hub copy is kept). */
function copyPrivate(stateDir, hubDir, name, log) {
  const target = join(hubDir, name)
  const text = readText(join(stateDir, name))
  if (text === undefined || existsSync(target)) return false
  writeAtomic(target, text, { mode: 0o600 })
  log(name + ' copied into the hub folder')
  return true
}

/** @returns {{ queue: 'imported' | 'skipped' | 'none' | 'unreadable', items: number, ended: number, vapid: boolean, push: boolean }} */
export function migrateLegacy({ stateDir, hubDir = join(stateDir, 'hub'), now = Date.now, log = () => {} }) {
  const result = { queue: 'none', items: 0, ended: 0, vapid: false, push: false }
  for (const [name, key] of [['vapid.json', 'vapid'], ['push.json', 'push']]) {
    try { result[key] = copyPrivate(stateDir, hubDir, name, log) } catch (error) { log(name + ' not copied: ' + String(error?.code ?? error?.name ?? 'error')) }
  }

  const target = join(hubDir, 'queue.json')
  if (existsSync(target) || existsSync(target + '.bak')) return { ...result, queue: 'skipped' }
  const legacy = readText(join(stateDir, 'queue.json'))
  if (legacy === undefined) return result

  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  writeAtomic(join(hubDir, 'queue.v1-import-' + stamp + '.json'), legacy)
  let data
  try {
    const parsed = JSON.parse(legacy)
    if (parsed && parsed.v === 1 && Array.isArray(parsed.items)) data = parsed
  } catch { /* handled below */ }
  const items = (data?.items ?? []).filter(usable).map((item) => {
    if (item.status !== 'open' || !ENDED.has(item.type)) return item
    result.ended++
    return { ...item, status: 'resolved', resolvedAt: now(), resolution: { kind: 'session-ended', by: 'hub', reason: 'migration' } }
  })
  const seq = Math.max(Number.isFinite(data?.seq) ? data.seq : 0, ...items.map((i) => (Number.isFinite(i.seq) ? i.seq : 0)))
  writeAtomic(target, JSON.stringify({ v: QUEUE_VERSION, epoch: randomUUID().slice(0, 12), seq, rev: 0, items, instances: [] }))
  if (!data) { log('legacy queue.json is not a readable v1 file: not imported'); return { ...result, queue: 'unreadable' } }
  log('legacy queue imported: ' + items.length + ' items, ' + result.ended + ' ended')
  return { ...result, queue: 'imported', items: items.length }
}
