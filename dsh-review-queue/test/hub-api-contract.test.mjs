// The overlay's API is provably unchanged: the SAME cases of server.test.mjs and phone-approve.test.mjs run against two targets built from
// the real plugin (createReviewQueuePlugin): today's standalone path (hub: false) and the path through the hub (the instance proxy forwarding to a real hub).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeWorld, startPlugin, waitFor } from './plugin-helpers.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const JSON_HEADERS = { 'content-type': 'application/json' }

/** A speaker like the real reader's contract: speak() answers { ok } or an error, stop() ends the speech. */
function fakeSpeaker() {
  const s = { result: undefined, end: undefined }
  s.speak = (chunks, opts) => { if (s.result) return s.result; s.end = opts.onEnd; return { ok: true } }
  s.stop = () => { const e = s.end; s.end = undefined; e?.() }
  return s
}

async function makeTarget(t, viaHub) {
  const world = await makeWorld(t)
  const speaker = fakeSpeaker()
  const prompts = []
  const services = { sessionController: { prompt: async (p) => { prompts.push(p); return {} } } }
  if (viaHub) {
    world.hubOptions = { roleOf: (req) => req.headers['x-test-role'] ?? 'desktop' }
    await world.startHub()
  }
  // The real plugin either way; with the hub off it is today's standalone path.
  const plugin = await startPlugin(t, world, { label: 'T', webPort: 12001, services, config: { hub: viaHub, speaker } })
  if (viaHub) await plugin.inState('hub', 5000)
  const target = {
    viaHub, world, plugin, speaker, prompts, base: plugin.base,
    snap: async () => (await fetch(plugin.base + '/v1/snapshot')).json(),
    post: (path, body, headers = JSON_HEADERS) => fetch(plugin.base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    // an item that reached wherever the list is kept
    async settle(id) { if (viaHub) { await waitFor(() => world.hub.store.get(id), 5000, 'item at the hub'); await waitFor(() => plugin.mirrored(id), 5000, 'item in the mirror') } },
    async completed(over = {}) {
      const item = plugin.store.add({ type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'Did X.', payload: { reply: 'r' }, ...over })
      await target.settle(item.id)
      return item
    },
    async permission(sessionId, command) { const p = await plugin.permission(sessionId, command); await target.settle(p.id); return p },
    async question(sessionId) { const q = plugin.question(sessionId); await target.settle(q.id); return q },
    // the phone: a device credential at the hub; standalone has no phone, the service is asked directly as before
    async phoneApprove(id, opts) {
      if (!viaHub) return plugin.queue.approve(id, { via: 'phone', ...opts })
      const res = await fetch('http://127.0.0.1:' + world.hubPort + '/review-queue/v1/approve', { method: 'POST', headers: { ...JSON_HEADERS, 'x-test-role': 'device' }, body: JSON.stringify({ id, ...opts }) })
      return res.json()
    },
    async phoneApproveSimilar(id, opts) {
      if (!viaHub) return plugin.queue.approveSimilar(id, { via: 'phone', ...opts })
      const res = await fetch('http://127.0.0.1:' + world.hubPort + '/review-queue/v1/approve-similar', { method: 'POST', headers: { ...JSON_HEADERS, 'x-test-role': 'device' }, body: JSON.stringify({ id, ...opts }) })
      return res.json()
    },
    // what the pending request resolved with, or undefined while it is still waiting
    decided: (p) => Promise.race([p.outcome, sleep(150).then(() => undefined)]),
  }
  return target
}

const tokenOf = (s) => s.snapshotId + '|' + (s.focusId ?? '') + '|' + (s.reading ?? '') + '|' + (s.ui?.seq ?? 0)

for (const viaHub of [false, true]) {
  const T = (name, fn) => test((viaHub ? 'via the hub: ' : 'standalone: ') + name, async (t) => fn(await makeTarget(t, viaHub), t))

  T('GET /v1/snapshot returns open items with positions and spoken text', async (g) => {
    await g.completed()
    const res = await fetch(g.base + '/v1/snapshot')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('cache-control'), /no-store/)
    const snap = await res.json()
    assert.equal(snap.open.length, 1)
    assert.equal(snap.open[0].position, 1)
    assert.ok(snap.open[0].spoken.headline)
    assert.equal(snap.notice, undefined)
  })

  T('snapshot with a current since id and no wait answers unchanged at once', async (g) => {
    await g.completed()
    const snap = await g.snap()
    assert.deepEqual(await (await fetch(g.base + '/v1/snapshot?since=' + encodeURIComponent(tokenOf(snap)))).json(), { unchanged: true, snapshotId: snap.snapshotId })
  })

  T('long poll returns as soon as something changes, and gives up quietly when nothing does', async (g) => {
    const snap = await g.snap()
    const started = Date.now()
    const pending = fetch(g.base + '/v1/snapshot?wait=5000&since=' + encodeURIComponent(tokenOf(snap))).then((r) => r.json())
    setTimeout(() => void g.completed({ sessionId: 'later' }), 50)
    const res = await pending
    assert.ok(Date.now() - started < 3000)
    assert.ok(res.open.some((i) => i.sessionId === 'later'))
    const quiet = await (await fetch(g.base + '/v1/snapshot?wait=100&since=' + encodeURIComponent(tokenOf(res)))).json()
    assert.equal(quiet.unchanged, true)
  })

  T('actions need JSON content type, valid JSON and a small body', async (g) => {
    assert.equal((await g.post('/v1/reviewed', { id: 'x' }, { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await g.post('/v1/reviewed', '{nope')).status, 400)
    assert.equal((await g.post('/v1/reply', { id: 'x', text: 'y'.repeat(100_000) })).status, 413)
  })

  T('reviewed resolves a completed item; a repeat is a 409 not-open', async (g) => {
    const c = await g.completed({ sessionId: 'r1' })
    assert.equal((await g.post('/v1/reviewed', { id: c.id })).status, 200)
    await waitFor(async () => (await g.snap()).resolved.some((i) => i.id === c.id), 5000, 'resolved in the snapshot')
    const again = await g.post('/v1/reviewed', { id: c.id })
    assert.equal(again.status, 409)
    assert.equal((await again.json()).error, 'not-open')
    assert.equal((await g.post('/v1/reopen', { id: c.id })).status, 200)
    const twice = await g.post('/v1/reopen', { id: c.id })
    assert.equal(twice.status, 409)
    assert.deepEqual(await twice.json(), { ok: false, error: 'not-reopenable' })
  })

  T('answer, approve, deny and reply reach the session that waits for them', async (g) => {
    const q = await g.question('sq')
    assert.equal((await g.post('/v1/answer', { id: q.id, answers: [] })).status, 400)
    assert.equal((await g.post('/v1/answer', { id: q.id, answers: [{ id: 'q1', selected: ['A'] }] })).status, 200)
    assert.ok(await g.decided(q))
    const ok = await g.permission('sp1')
    assert.equal((await g.post('/v1/approve', { id: ok.id })).status, 200)
    assert.equal(await g.decided(ok), 'allowed-once')
    const no = await g.permission('sp2')
    assert.equal((await g.post('/v1/deny', { id: no.id })).status, 200)
    assert.ok(await g.decided(no))
    const c = await g.completed({ sessionId: 'rep' })
    assert.equal((await g.post('/v1/reply', { id: c.id, text: 'go on' })).status, 200)
    assert.equal(g.prompts.length, 1)
    assert.equal((await g.post('/v1/reply', { id: c.id, text: '' })).status, 409)
  })

  T('approve-similar approves the identical open requests of the session', async (g) => {
    const p = await g.permission('sx', 'ls')
    const res = await g.post('/v1/approve-similar', { id: p.id })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).count, 1)
    assert.equal(await g.decided(p), 'allowed-once')
  })

  T('focus can be set and cleared; an unknown item is a 409', async (g) => {
    const c = await g.completed({ sessionId: 'f' })
    assert.equal((await g.post('/v1/focus', { id: c.id })).status, 200)
    assert.equal((await g.snap()).focusId, c.id)
    assert.equal((await g.post('/v1/focus', { id: null })).status, 200)
    assert.equal((await g.snap()).focusId, undefined)
    assert.equal((await g.post('/v1/focus', { id: 'ghost' })).status, 409)
  })

  T('unknown routes are 404, wrong methods 405, and dev routes do not exist unless enabled', async (g) => {
    assert.equal((await fetch(g.base + '/v1/nope')).status, 404)
    assert.equal((await fetch(g.base + '/v1/reviewed')).status, 405)
    assert.equal((await g.post('/v1/dev/ask', {})).status, 404)
  })

  T('read and stop drive the speaker; reading shows in the snapshot and wakes the long poll; a muted speaker is a 409', async (g) => {
    const item = await g.completed({ payload: { reply: 'Read me.' } })
    const before = await g.snap()
    const pending = fetch(g.base + '/v1/snapshot?wait=5000&since=' + encodeURIComponent(tokenOf(before))).then((r) => r.json())
    await sleep(30)
    assert.equal((await g.post('/v1/read', { id: item.id })).status, 200)
    assert.equal((await pending).reading, item.id)
    assert.equal((await g.post('/v1/stop', {})).status, 200)
    assert.equal((await g.snap()).reading, undefined)
    g.speaker.result = { ok: false, error: 'muted' }
    const muted = await g.post('/v1/read', { id: item.id })
    assert.equal(muted.status, 409)
    assert.deepEqual(await muted.json(), { ok: false, error: 'muted' })
    g.speaker.result = undefined
    assert.equal((await g.post('/v1/read', { id: 'nope' })).status, 409)
  })

  T('ui show and hide land in the snapshot, wake a waiting long poll, and anything else is a 400', async (g) => {
    const before = (await g.snap()).ui
    const res = await g.post('/v1/ui', { cmd: 'show' })
    assert.deepEqual(await res.json(), { ok: true, seq: before.seq + 1 })
    assert.deepEqual((await g.snap()).ui, { seq: before.seq + 1, cmd: 'show' })
    const bad = await g.post('/v1/ui', { cmd: 'explode' })
    assert.equal(bad.status, 400)
    assert.deepEqual(await bad.json(), { ok: false, error: 'bad-command' })
    assert.equal((await fetch(g.base + '/v1/ui')).status, 405)
    const snap = await g.snap()
    const pending = fetch(g.base + '/v1/snapshot?wait=5000&since=' + encodeURIComponent(tokenOf(snap))).then((r) => r.json())
    await sleep(30)
    assert.equal((await g.post('/v1/ui', { cmd: 'hide' })).status, 200)
    const woke = await pending
    assert.equal(woke.unchanged, undefined)
    assert.deepEqual([woke.ui.cmd, woke.ui.seq], ['hide', snap.ui.seq + 1])
    const stale = await (await fetch(g.base + '/v1/snapshot?since=' + encodeURIComponent(woke.snapshotId + '|||' + (woke.ui.seq - 1)))).json()
    assert.equal(stale.unchanged, undefined)
    assert.deepEqual(await (await fetch(g.base + '/v1/snapshot?since=' + encodeURIComponent(tokenOf(woke)))).json(), { unchanged: true, snapshotId: woke.snapshotId })
  })

  // phone-approve.test.mjs: from the phone an approve says it went through the confirm sheet, a risky one also the press-and-hold
  T('desktop approve (no via) is unchanged, risky or not', async (g) => {
    const safe = await g.permission('s1', 'ls')
    const risky = await g.permission('s2', 'git push --force origin main')
    assert.equal((await g.post('/v1/approve', { id: safe.id })).status, 200)
    assert.equal((await g.post('/v1/approve', { id: risky.id })).status, 200)
    assert.deepEqual([await g.decided(safe), await g.decided(risky)], ['allowed-once', 'allowed-once'])
  })

  T('phone approve without the confirm sheet is refused and nothing is decided', async (g) => {
    const safe = await g.permission('s1', 'ls')
    assert.deepEqual(await g.phoneApprove(safe.id, {}), { ok: false, error: 'needs-confirm' })
    assert.deepEqual(await g.phoneApprove(safe.id, { confirmed: false }), { ok: false, error: 'needs-confirm' })
    assert.equal(await g.decided(safe), undefined)
    assert.deepEqual(await g.phoneApprove(safe.id, { confirmed: true }), { ok: true })
    assert.equal(await g.decided(safe), 'allowed-once')
  })

  T('a risky request also needs the press-and-hold from the phone', async (g) => {
    const risky = await g.permission('s2', 'git push --force origin main')
    assert.deepEqual(await g.phoneApprove(risky.id, { confirmed: true }), { ok: false, error: 'needs-hold' })
    assert.equal(await g.decided(risky), undefined)
    assert.deepEqual(await g.phoneApprove(risky.id, { confirmed: true, held: true }), { ok: true })
    assert.equal(await g.decided(risky), 'allowed-once')
  })

  T('deny needs no confirmation; approve all identical from the phone needs the confirm sheet', async (g) => {
    const risky = await g.permission('s2', 'git push --force origin main')
    assert.equal((await g.post('/v1/deny', { id: risky.id })).status, 200)
    assert.ok(await g.decided(risky))
    const safe = await g.permission('s1', 'ls')
    assert.deepEqual(await g.phoneApproveSimilar(safe.id, {}), { ok: false, error: 'needs-confirm' })
    assert.equal((await g.phoneApproveSimilar(safe.id, { confirmed: true })).ok, true)
  })
}

test('through the hub the instance cannot be talked into a phone approve: via in the body is ignored', async (t) => {
  const g = await makeTarget(t, true)
  const risky = await g.permission('s2', 'git push --force origin main')
  assert.equal((await g.post('/v1/approve', { id: risky.id, via: 'phone', confirmed: false })).status, 200, 'the proxy is the desktop (D8): the hub derives via from the credential')
  assert.equal(await g.decided(risky), 'allowed-once')
})

test('through the hub the local-only routes never reach the hub and the rest carries the agent credentials', async (t) => {
  const g = await makeTarget(t, true)
  const seen = []
  const orig = g.world.hub.act
  g.world.hub.act = (kind, body, ctx) => { seen.push([kind, ctx.role, ctx.caller]); return orig(kind, body, ctx) }
  const c = await g.completed()
  await g.post('/v1/focus', { id: c.id })
  await g.post('/v1/reviewed', { id: c.id })
  assert.deepEqual(seen, [['reviewed', 'desktop', g.plugin.agent.instanceId]])
})
