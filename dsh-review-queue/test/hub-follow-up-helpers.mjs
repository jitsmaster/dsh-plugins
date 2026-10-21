// Shared by the hub follow-up tests (hub-follow-up*.test.mjs): raw agents that answer the follow-up commands, and the items a follow-up leaves in the hub.
import assert from 'node:assert/strict'
import { postJson } from './hub-helpers.mjs'
import { P, agentOf, startHub, sync } from './hub-agent-helpers.mjs'

export const act = (port, kind, body, headers) => postJson(port, P + '/v1/' + kind, body, headers)
/** A session as an app lists it. */
export const sess = (id, updatedAt, over = {}) => ({ sessionId: id, title: 'Title ' + id, updatedAt, running: false, ...over })
export const ws = (id, title, path) => ({ id, title, path })
export const nothingQueued = async (agent) => assert.deepEqual((await agent.poll(0, 0)).json.commands, [])

/** Two registered apps: a (aaaa1111) and b (bbbb2222). */
export async function twoApps(t, over = {}) {
  const ctx = await startHub(t, over)
  const a = agentOf(ctx.port)
  const b = agentOf(ctx.port, { id: 'bbbb2222', key: 'k2', label: 'DSH :2' })
  await a.register({ sync: sync({ workspaces: [ws('w1', 'alpha', 'D:/a')] }) })
  await b.register({ sync: sync({ workspaces: [ws('w1', 'beta', 'D:/b')] }) })
  return { ...ctx, a, b }
}

/**
 * An agent that answers every command it polls with handler(cmd) until the test ends; a handler that returns undefined leaves the command
 * unanswered (the hub's own timeout then answers). Returns the commands it saw, in order.
 */
export function autopilot(t, agent, handler) {
  const seen = []
  let after = 0
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      let got
      try { got = await agent.poll(after, 100) } catch { return }
      for (const cmd of got.json?.commands ?? []) {
        after = Math.max(after, cmd.seq)
        seen.push(cmd)
        const result = await handler(cmd)
        if (result !== undefined) await agent.result(cmd.cid, result).catch(() => {})
      }
    }
  })()
  t.after(async () => { stopped = true; await loop })
  return seen
}
export const kinds = (seen) => seen.map((c) => c.kind)

/** The answer of an app to the follow-up commands: its sessions to sessions-list, an accepted item to followup-suggest. */
export const answers = (agent, sessions, extra = () => undefined) => (cmd) => {
  if (cmd.kind === 'sessions-list') return { ok: true, sessions }
  if (cmd.kind === 'followup-suggest') return { ok: true, id: agent.itemId(9), state: 'awaiting-confirm' }
  return extra(cmd) ?? { ok: false, error: 'unexpected-' + cmd.kind }
}

/** The follow-up item an app holds while the user has to confirm (what todo-follow-up.js stores). */
export const followItem = (agent, n, { candidates, suggested, ...over } = {}) => agent.add(n, {
  type: 'todo', kind: 'followup', text: 'also the null case', query: 'the PR review', state: 'awaiting-confirm', suggesting: false, candidates, ...(suggested ? { suggested } : {}), ...over,
})
