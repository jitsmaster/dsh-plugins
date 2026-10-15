// Helpers of the agent-bridge tests: a hub on a temp dir with a fake clock and a fixed secret, and a bare HTTP "agent".
import { createHub } from '../hub/hub.js'
import { PROTOCOL } from '../hub/protocol.js'
import { fakeClock, postJson, raw, tmpDir } from './hub-helpers.mjs'

export const SECRET = 'S'.repeat(43)
export const P = '/review-queue'

export async function startHub(t, over = {}) {
  const dir = over.dir ?? tmpDir(t)
  const logs = []
  const clock = over.clock ?? fakeClock()
  const hub = createHub({ stateDir: dir, port: 0, tickMs: 0, secret: SECRET, now: clock.now, log: (line) => logs.push(line), ...over })
  await hub.start()
  t.after(() => hub.stop())
  return { hub, dir, logs, clock, port: hub.port }
}

/** One agent speaking raw HTTP; ops are numbered by send(). */
export function agentOf(port, { id = 'aaaa1111', key = 'k1', label = 'DSH :1', secret = SECRET, protocol = PROTOCOL } = {}) {
  const headers = { ...(secret === undefined ? {} : { authorization: 'Bearer ' + secret }), ...(protocol === undefined ? {} : { 'x-rq-protocol': String(protocol) }) }
  const a = {
    id, key, headers, n: 0,
    post: (name, body = {}) => postJson(port, '/hub/v1/agent/' + name, { instanceId: id, ...body }, headers),
    get: (name, query = {}) => raw({ port, path: '/hub/v1/agent/' + name + '?' + new URLSearchParams({ instanceId: id, ...query }), headers }),
    register: (extra = {}) => a.post('register', { instanceKey: key, label, ...extra }),
    ops: (ops) => a.post('ops', { ops }),
    send: (...ops) => a.ops(ops.map((op) => ({ n: ++a.n, ...op }))),
    poll: (after = 0, wait = 0) => a.get('commands', { after, wait }),
    result: (cid, result) => a.post('result', { cid, result }),
    itemId: (n = 1) => id.slice(0, 4) + '-' + String(n).padStart(12, '0'),
    add: (n, over = {}) => ({ op: 'add', item: { id: a.itemId(n), type: 'completed', sessionId: 's' + n, payload: { reply: 'r' }, ...over } }),
  }
  return a
}

export const sync = (over = {}) => ({ n: 0, openItems: [], resolvedItems: [], workspaces: [], sessionIds: [], ...over })
