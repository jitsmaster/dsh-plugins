import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createReviewQueue } from '../service.js'
import { createTipper } from '../tip.js'
import { createRouter } from '../server.js'
import { createServer } from 'node:http'

// The tip in the service snapshot (only while the list is empty), the topics that steer it, and reading it aloud (readTip, reading === 'tip:<id>').
const TIP = { id: 'tip1', title: 'Bloom filters', body: 'A Bloom filter is a bit array. It never gives a false negative.', category: 'algorithms', at: 1, source: 'model' }
function setup({ tips = fakeTips(), speaker = fakeSpeaker(), llm } = {}) {
  let t = 1000
  const store = createStore({ now: () => ++t })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => undefined, tips, speaker, now: () => 5000 })
  return { store, queue, tips, speaker }
}
function fakeTips(tip = TIP) {
  const tips = { asked: 0, peeked: 0, tip: tip ?? undefined, current() { tips.asked++; return tips.tip }, peek() { tips.peeked++; return tips.tip } }
  return tips
}
function fakeSpeaker({ result = { ok: true } } = {}) {
  const s = { spoken: [], stops: 0, result, ends: [], speak(chunks, opts) { s.spoken.push(chunks); s.ends.push(opts?.onEnd); return s.result }, stop() { s.stops++ } }
  return s
}
const completed = () => ({ type: 'completed', sessionId: 's1', sessionTitle: 'One', summary: 'Did X.', payload: { reply: 'r' } })

test('an empty list carries the tip, and the snapshot asks the generator for it', () => {
  const { queue, tips } = setup()
  const snap = queue.snapshot({ tip: true })
  assert.deepEqual(snap.tip, TIP)
  assert.equal(tips.asked, 1)
})

test('no tip while any item is open, and the generator is not asked (so it generates nothing)', () => {
  const { store, queue, tips } = setup()
  store.add(completed())
  const snap = queue.snapshot({ tip: true })
  assert.equal(snap.tip, undefined)
  assert.ok(!('tip' in snap))
  assert.equal(tips.asked, 0)
})

test('resolved items alone do not hide the tip; paused and starting todos count as open items', () => {
  const { store, queue } = setup()
  const item = store.add(completed())
  store.resolve(item.id, { kind: 'reviewed', by: 'card' })
  assert.equal(queue.snapshot({ tip: true }).tip.id, 'tip1')
  store.add({ type: 'paused', sessionId: 'p', payload: {} })
  assert.equal(queue.snapshot({ tip: true }).tip, undefined)
})

test('a generator that has nothing yet (undefined) leaves the snapshot without a tip', () => {
  const { queue } = setup({ tips: fakeTips(null) })
  assert.ok(!('tip' in queue.snapshot({ tip: true })))
})

test('a service without a generator has no tip (the hub and the mirror view)', () => {
  let t = 0
  const store = createStore({ now: () => ++t })
  const queue = createReviewQueue({ store, capture: {}, controllerOf: () => undefined })
  assert.ok(!('tip' in queue.snapshot({ tip: true })))
  assert.equal(queue.tip(), undefined)
})

test('tip() asks for the current tip whatever the local store holds (the proxy uses it for the merged list)', () => {
  const { store, queue, tips } = setup()
  store.add(completed())
  assert.equal(queue.tip().id, 'tip1')
  assert.equal(tips.asked, 1)
})

test('a generator that throws never breaks the snapshot', () => {
  const tips = { current() { throw new Error('boom') }, peek() { return undefined } }
  const { queue } = setup({ tips })
  assert.doesNotThrow(() => queue.snapshot({ tip: true }))
  assert.ok(!('tip' in queue.snapshot({ tip: true })))
})

test('a tip that is ready later wakes the listeners (the long poll)', () => {
  let onChange
  const tips = { current: () => undefined, peek: () => undefined, onChange: (l) => { onChange = l; return () => {} } }
  const { queue } = setup({ tips })
  let n = 0
  queue.onChange(() => { n++ })
  onChange()
  assert.equal(n, 1)
})

// ---- readTip ----------------------------------------------------------------------------------------------------------------------------

test('readTip speaks the title and the body and shows reading as tip:<id>', () => {
  const { queue, speaker } = setup()
  assert.deepEqual(queue.readTip('tip1'), { ok: true })
  const spoken = speaker.spoken[0].join(' ')
  assert.match(spoken, /Bloom filters/)
  assert.match(spoken, /bit array/)
  assert.equal(queue.snapshot().reading, 'tip:tip1')
})

test('reading ends by itself when the speech ends, and stop() ends it at once', () => {
  const { queue, speaker } = setup()
  queue.readTip('tip1')
  speaker.ends[0]()
  assert.equal(queue.snapshot().reading, undefined)
  queue.readTip('tip1')
  assert.equal(queue.snapshot().reading, 'tip:tip1')
  assert.deepEqual(queue.stop(), { ok: true })
  assert.equal(queue.snapshot().reading, undefined)
  assert.ok(speaker.stops >= 1)
})

test('a read that was replaced does not clear its successor', () => {
  const { queue, speaker } = setup()
  queue.readTip('tip1')
  queue.readTip('tip1')
  speaker.ends[0]()
  assert.equal(queue.snapshot().reading, 'tip:tip1')
})

test('readTip refuses an id that is not the current tip, and a missing tip', () => {
  const { queue, speaker } = setup()
  assert.deepEqual(queue.readTip('other'), { ok: false, error: 'not-found' })
  assert.deepEqual(queue.readTip(undefined), { ok: false, error: 'not-found' })
  const none = setup({ tips: fakeTips(null) })
  assert.deepEqual(none.queue.readTip('tip1'), { ok: false, error: 'not-found' })
  assert.deepEqual(speaker.spoken, [])
})

test('readTip without a speaker says no-speaker; a muted voice is the existing muted error', () => {
  const { queue } = setup({ speaker: null })
  assert.deepEqual(queue.readTip('tip1'), { ok: false, error: 'no-speaker' })
  const muted = setup({ speaker: fakeSpeaker({ result: { ok: false, error: 'muted' } }) })
  assert.deepEqual(muted.queue.readTip('tip1'), { ok: false, error: 'muted' })
  assert.equal(muted.queue.snapshot().reading, undefined)
  const odd = setup({ speaker: fakeSpeaker({ result: null }) })
  assert.deepEqual(odd.queue.readTip('tip1'), { ok: false, error: 'no-speaker' })
})

test('reading the tip again is allowed (the card toggles through stop, a repeat just restarts)', () => {
  const { queue, speaker } = setup()
  queue.readTip('tip1')
  assert.deepEqual(queue.readTip('tip1'), { ok: true })
  assert.equal(speaker.spoken.length, 2)
})

test('the tip is read on the tip that is current: a newer tip cannot be read by the old id', () => {
  const tips = fakeTips()
  const { queue } = setup({ tips })
  tips.tip = { ...TIP, id: 'tip2' }
  assert.deepEqual(queue.readTip('tip1'), { ok: false, error: 'not-found' })
  assert.deepEqual(queue.readTip('tip2'), { ok: true })
})

test('a new item stops the reading of the tip (the tip is gone from the screen)', () => {
  const { store, queue, speaker } = setup()
  queue.readTip('tip1')
  const before = speaker.stops
  store.add(completed())
  assert.equal(queue.snapshot().reading, undefined)
  assert.ok(speaker.stops > before)
})

test('an item changing while the tip is read does not stop it when the list stays empty', () => {
  const { store, queue } = setup()
  queue.readTip('tip1')
  const item = store.add(completed())
  store.resolve(item.id, { kind: 'reviewed', by: 'card' })
  // the list is empty again, but the first add already ended the tip's reading
  assert.equal(queue.snapshot().reading, undefined)
})

test('reading an ordinary item is unchanged next to the tip code', () => {
  const { store, queue, speaker } = setup()
  const item = store.add(completed())
  assert.deepEqual(queue.read(item.id), { ok: true })
  assert.equal(queue.snapshot().reading, item.id)
  assert.equal(speaker.spoken.length, 1)
})

// ---- with the real generator ------------------------------------------------------------------------------------------------------------

test('with the real generator and no model, the snapshot carries a built-in tip that can be read', () => {
  const tips = createTipper({ now: () => 5000 })
  const { queue, speaker } = setup({ tips })
  const tip = queue.snapshot({ tip: true }).tip
  assert.equal(tip.source, 'builtin')
  assert.deepEqual(queue.readTip(tip.id), { ok: true })
  assert.match(speaker.spoken[0].join(' '), new RegExp(tip.title.slice(0, 10).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

// ---- the HTTP route ---------------------------------------------------------------------------------------------------------------------

async function serve(t, queue) {
  const server = createServer(createRouter({ queue }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const base = 'http://127.0.0.1:' + server.address().port
  return (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }))
}

test('POST /v1/read-tip { id } reads the tip; the answer codes follow /v1/read', async (t) => {
  const { queue, speaker } = setup()
  const post = await serve(t, queue)
  assert.deepEqual(await post('/v1/read-tip', { id: 'tip1' }), { status: 200, json: { ok: true } })
  assert.equal(speaker.spoken.length, 1)
  assert.deepEqual(await post('/v1/read-tip', { id: 'nope' }), { status: 409, json: { ok: false, error: 'not-found' } })
  assert.deepEqual(await post('/v1/read-tip', {}), { status: 409, json: { ok: false, error: 'not-found' } })
  const muted = setup({ speaker: fakeSpeaker({ result: { ok: false, error: 'muted' } }) })
  const post2 = await serve(t, muted.queue)
  assert.deepEqual(await post2('/v1/read-tip', { id: 'tip1' }), { status: 409, json: { ok: false, error: 'muted' } })
  const none = setup({ speaker: null })
  const post3 = await serve(t, none.queue)
  assert.deepEqual(await post3('/v1/read-tip', { id: 'tip1' }), { status: 409, json: { ok: false, error: 'no-speaker' } })
})

test('the read-tip route is POST only and the snapshot over HTTP carries the tip', async (t) => {
  const { queue } = setup()
  const server = createServer(createRouter({ queue }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const base = 'http://127.0.0.1:' + server.address().port
  assert.equal((await fetch(base + '/v1/read-tip')).status, 405)
  const snap = await (await fetch(base + '/v1/snapshot?tip=1')).json()
  assert.equal(snap.tip.id, 'tip1')
})

test('the tip is opt-in: without tip=1 (overlay closed, the phone, any other caller) none is attached and none is generated', async (t) => {
  const { queue, tips } = setup()
  assert.ok(!('tip' in queue.snapshot()))
  assert.ok(!('tip' in queue.snapshot({ tip: false })))
  assert.equal(tips.asked, 0)
  const server = createServer(createRouter({ queue }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const base = 'http://127.0.0.1:' + server.address().port
  for (const q of ['', '?client=phone', '?tip=0', '?wait=0&since=' + encodeURIComponent('e:1|||0')]) {
    const snap = await (await fetch(base + '/v1/snapshot' + q)).json()
    assert.ok(!('tip' in snap), q)
  }
  assert.equal(tips.asked, 0)
  const desktop = await (await fetch(base + '/v1/snapshot?tip=1')).json()
  assert.equal(desktop.tip.id, 'tip1')
  assert.equal(tips.asked, 1)
})

test('a long poll with tip=1 that wakes asks again; without tip=1 it never does', async (t) => {
  const { queue, tips } = setup()
  const server = createServer(createRouter({ queue }))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }))
  const base = 'http://127.0.0.1:' + server.address().port
  const first = await (await fetch(base + '/v1/snapshot?tip=1')).json()
  const since = encodeURIComponent(first.snapshotId + '|||0||tip1')
  assert.deepEqual(await (await fetch(base + '/v1/snapshot?wait=0&tip=1&since=' + since)).json(), { unchanged: true, snapshotId: first.snapshotId })
  assert.equal(tips.asked, 2)
  const before = tips.asked
  await fetch(base + '/v1/snapshot?wait=0&since=' + since)
  assert.equal(tips.asked, before)
})

test('speaking is shared: reading an item and reading the tip replace each other and clear only their own state', () => {
  const { store, queue, speaker } = setup()
  const item = store.add(completed())
  queue.read(item.id)
  queue.readTip('tip1')
  speaker.ends[0]()
  assert.equal(queue.snapshot().reading, 'tip:tip1', 'the replaced item read does not clear the tip')
})

test('stopTip stops only a tip being read', () => {
  const { store, queue, speaker } = setup()
  assert.deepEqual(queue.stopTip(), { ok: true, stopped: false })
  const item = store.add(completed())
  queue.read(item.id)
  const stops = speaker.stops
  assert.deepEqual(queue.stopTip(), { ok: true, stopped: false })
  assert.equal(speaker.stops, stops)
  queue.stop()
  store.resolve(item.id, { kind: 'reviewed', by: 'card' })
  queue.readTip('tip1')
  assert.deepEqual(queue.stopTip(), { ok: true, stopped: true })
  assert.equal(queue.snapshot().reading, undefined)
})

test('readTip hands the speaker the title and then ONE chunk per sentence (never several sentences in one chunk)', () => {
  const tips = fakeTips({ ...TIP, title: 'Bloom filters', body: 'A Bloom filter is a bit array. It never gives a false negative. Lookups cost k hashes.' })
  const { queue, speaker } = setup({ tips })
  assert.deepEqual(queue.readTip('tip1'), { ok: true })
  assert.deepEqual(speaker.spoken[0], ['Bloom filters.', 'A Bloom filter is a bit array.', 'It never gives a false negative.', 'Lookups cost k hashes.'])
})

test('a title that already ends in punctuation gets no second one', () => {
  const tips = fakeTips({ ...TIP, title: 'Why hash?', body: 'Speed.' })
  const { queue, speaker } = setup({ tips })
  queue.readTip('tip1')
  assert.deepEqual(speaker.spoken[0], ['Why hash?', 'Speed.'])
})

// ---- nextTip: "Another tip" -------------------------------------------------------------------------------------------------------------

test('nextTip asks the generator for another tip and answers with it; reading of the old tip ends', async () => {
  const tips = fakeTips()
  tips.next = async () => { tips.tip = { ...TIP, id: 'tip2', title: 'Other' }; return tips.tip }
  const { queue, speaker } = setup({ tips })
  queue.readTip('tip1')
  assert.deepEqual(await queue.nextTip('tip1'), { ok: true, tip: { ...TIP, id: 'tip2', title: 'Other' } })
  assert.ok(speaker.stops >= 1)
})

test('nextTip without a generator, or with one that throws, is a plain error', async () => {
  const none = setup({ tips: null })
  assert.deepEqual(await none.queue.nextTip('x'), { ok: false, error: 'no model available' })
  const tips = fakeTips(); tips.next = async () => { throw new Error('secret endpoint') }
  const { queue } = setup({ tips })
  assert.deepEqual(await queue.nextTip('tip1'), { ok: false, error: 'LLM error' })
})

test('POST /v1/tip-next answers with the new tip (200), and an error with 409', async (t2) => {
  const tips = fakeTips(); tips.next = async () => { tips.tip = { ...TIP, id: 'tip9' }; return tips.tip }
  const { queue } = setup({ tips })
  const post = await serve(t2, queue)
  const res = await post('/v1/tip-next', { id: 'tip1' })
  assert.equal(res.status, 200)
  assert.equal(res.json.tip.id, 'tip9')
  const none = setup({ tips: null })
  const post2 = await serve(t2, none.queue)
  assert.equal((await post2('/v1/tip-next', {})).status, 409)
})
