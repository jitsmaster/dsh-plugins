import { test } from 'node:test'
import assert from 'node:assert/strict'

// tip-survey.js limits: running surveys, Tasks per app run, the bounded log read buffer, the error code shape.
const load = () => import('../tip-survey.js')
const BASE = 'https://dev.azure.com/ingeniuxdev/Ingeniux'
const WS = [1, 2, 3, 4].map((n) => ({ id: 'w' + n, title: 'ws ' + n, path: 'D:/dev/w' + n }))
const json = (places) => '```json\n' + JSON.stringify({ places }) + '\n```'
const turn = (text) => ({ records: [{ type: 'turn/start', data: {} }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }], torn: false })

async function make(over = {}) {
  const { createTipSurveys } = await load()
  const state = { tips: new Map(), items: new Map(), logs: {}, added: [], tasks: [] }
  let n = 0
  let ids = 0
  const deps = {
    todos: { add() { n += 1; const id = 'td' + n; state.added.push(id); state.items.set(id, { id, state: 'starting' }); return { ok: true, id } } },
    todoItemOf: (id) => state.items.get(id),
    readLog: async (sid) => state.logs[sid],
    workspacesOf: () => WS,
    tipOf: (id) => state.tips.get(id),
    adoBaseOf: async () => BASE,
    createTask: async (base) => { state.tasks.push(base); return { ok: true, id: 1000 + state.tasks.length } },
    timers: { set: () => 1, clear: () => {} },
    uuid: () => 'id' + (++ids),
    ...over,
  }
  const tip = (id) => { state.tips.set(id, { id, title: 'Tip ' + id, body: 'body ' + id }); return id }
  const session = (todoId) => { const sid = 's-' + todoId; state.items.set(todoId, { id: todoId, state: 'started', sessionId: sid }); return sid }
  return { surveys: createTipSurveys(deps), state, tip, session }
}

test('running surveys: a 4th running survey is refused with too-many-running and adds no todo', async () => {
  const m = await make()
  const t = m.tip('t1')
  for (const w of ['w1', 'w2', 'w3']) assert.equal(m.surveys.start(t, w).ok, true)
  assert.equal(m.state.added.length, 3)
  assert.deepEqual(m.surveys.start(t, 'w4'), { ok: false, error: 'too-many-running' })
  assert.equal(m.state.added.length, 3, 'no todo for the refused survey')
  assert.equal(m.surveys.state().length, 3)
  assert.equal(m.surveys.start(t, 'w1').existing, true, 'a running pair still returns the existing survey')
})

test('running surveys: a finished record is replaced and a finished one makes room', async () => {
  const m = await make({ createTask: undefined })
  const t = m.tip('t1')
  const first = m.surveys.start(t, 'w1')
  m.state.logs[m.session(first.survey.todoId)] = turn(json([]))
  await m.surveys.poll()
  assert.equal(m.surveys.state()[0].state, 'none')
  for (const w of ['w2', 'w3']) assert.equal(m.surveys.start(t, w).ok, true)
  assert.equal(m.surveys.start(t, 'w1').ok, true, 'two running plus the replaced finished one of the same pair')
  assert.equal(m.surveys.start(t, 'w4').error, 'too-many-running')
  assert.equal(m.surveys.state().filter((r) => r.state === 'running').length, 3)
})

test('tickets: at most 30 Tasks per app run across all tips; the 31st place gets ticket-cap', async () => {
  const m = await make()
  let created = 0
  for (let i = 0; i < 8; i++) {
    const t = m.tip('tip' + i)
    const r = m.surveys.start(t, 'w1')
    assert.equal(r.ok, true, JSON.stringify(r))
    const places = [0, 1, 2, 3, 4].map((p) => ({ path: 'src/f' + i + '_' + p + '.js', what: 'Place ' + p + ' would gain.' }))
    m.state.logs[m.session(r.survey.todoId)] = turn(json(places))
    await m.surveys.poll()
    created = m.state.tasks.length
  }
  assert.equal(m.state.tasks.length, 30, 'no 31st Task (created ' + created + ')')
  const last = m.surveys.state().find((r) => r.tipId === 'tip7')
  assert.ok(last.places.every((p) => p.ticket.error === 'ticket-cap'), JSON.stringify(last.places))
  const sixth = m.surveys.state().find((r) => r.tipId === 'tip5')
  assert.equal(sixth.places.length, 5)
})

const places5 = (i) => [0, 1, 2, 3, 4].map((p) => ({ path: 'src/f' + i + '_' + p + '.js', what: 'Place ' + p + ' would gain.' }))
async function survey(m, tipId, ws, i) {
  const r = m.surveys.start(m.tip(tipId), ws)
  assert.equal(r.ok, true, JSON.stringify(r))
  m.state.logs[m.session(r.survey.todoId)] = turn(json(places5(i)))
}

test('tickets: concurrent surveys near the ceiling never make more than 30 createTask calls', async () => {
  let calls = 0
  const m = await make({ createTask: async () => { calls += 1; const id = 1000 + calls; await new Promise((r) => setImmediate(r)); return { ok: true, id } } })
  for (let i = 0; i < 5; i++) { await survey(m, 'seq' + i, 'w1', i); await m.surveys.poll() }
  assert.equal(calls, 25)
  for (const [i, ws] of ['w1', 'w2', 'w3'].entries()) await survey(m, 'con' + i, ws, 10 + i)
  await m.surveys.poll()
  assert.equal(calls, 30, 'createTask calls ' + calls)
})

test('tickets: failed creations count toward the ceiling; after 30 attempts the rest get ticket-cap', async () => {
  let calls = 0
  const m = await make({ createTask: async () => { calls += 1; return { ok: false, error: 'http-error' } } })
  for (let i = 0; i < 8; i++) { await survey(m, 'f' + i, 'w1', i); await m.surveys.poll() }
  assert.equal(calls, 30, 'createTask calls ' + calls)
  const last = m.surveys.state().find((r) => r.tipId === 'f7')
  assert.ok(last.places.every((p) => p.ticket.error === 'ticket-cap'), JSON.stringify(last.places))
})

test('survey log reader: a read that never returns times out to undefined and the next read still works', async () => {
  const { createSurveyLogReader } = await load()
  const { rm } = await import('node:fs/promises')
  const root = await twoLogs('tip-to-')
  try {
    let n = 0
    const readFile = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve(Buffer.from('x')))
    const clock = { t: 1_000_000 }
    const reader = createSurveyLogReader({ root, now: () => clock.t, readTimeoutMs: 30, io: { readFile, parse: () => ({ records: [{ ok: 1 }], torn: false }) } })
    await settle(reader, clock, 'a', 'b')
    const p1 = reader('a')
    const p2 = reader('b')
    assert.equal(await p1, undefined)
    assert.deepEqual(await p2, { records: [{ ok: 1 }], torn: false })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('survey log reader: a late result of an abandoned read is ignored without an unhandled rejection', async () => {
  const { createSurveyLogReader } = await load()
  const { rm } = await import('node:fs/promises')
  const root = await twoLogs('tip-late-')
  const bad = []
  const onBad = (e) => bad.push(e)
  process.on('unhandledRejection', onBad)
  try {
    let fail
    const readFile = () => new Promise((_, reject) => { fail = reject })
    const clock = { t: 1_000_000 }
    const reader = createSurveyLogReader({ root, now: () => clock.t, readTimeoutMs: 20, io: { readFile, parse: () => ({ records: [], torn: false }) } })
    await settle(reader, clock, 'a')
    assert.equal(await reader('a'), undefined)
    fail(new Error('late'))
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(bad, [])
  } finally { process.off('unhandledRejection', onBad); await rm(root, { recursive: true, force: true }) }
})

test('survey log reader: the timeout timer is cleared after a normal read', async () => {
  const { createSurveyLogReader } = await load()
  const { rm } = await import('node:fs/promises')
  const root = await twoLogs('tip-clr-')
  try {
    const set = []
    const cleared = []
    const timers = { set: (fn, ms) => { set.push(ms); return set.length }, clear: (h) => cleared.push(h) }
    const reader = createSurveyLogReader({ root, timers, readTimeoutMs: 1234, io: { readFile: async () => Buffer.from('x'), parse: () => ({ records: [], torn: false }) } })
    await reader('a')
    assert.deepEqual(set, [1234])
    assert.deepEqual(cleared, [1])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('error codes: http-error is a valid code and reaches the place', async () => {
  const m = await make({ createTask: async () => ({ ok: false, error: 'http-error' }) })
  const r = m.surveys.start(m.tip('t1'), 'w1')
  m.state.logs[m.session(r.survey.todoId)] = turn(json([{ path: 'src/a.js', what: 'Would gain.' }]))
  await m.surveys.poll()
  assert.deepEqual(m.surveys.state()[0].places[0].ticket, { error: 'http-error' })
})

test('survey log reader: a log under the cap parses and one over it is tooLarge', async () => {
  const { createSurveyLogReader } = await load()
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { SESSION_LOG } = await import('../paused.js')
  const root = await mkdtemp(join(tmpdir(), 'tip-lim-'))
  try {
    for (const s of ['a', 'b', 'c']) await mkdir(join(root, 'p', s), { recursive: true })
    await writeFile(join(root, 'p', 'a', SESSION_LOG), 'x'.repeat(100))
    await writeFile(join(root, 'p', 'b', SESSION_LOG), 'x'.repeat(101))
    await writeFile(join(root, 'p', 'c', SESSION_LOG), 'x'.repeat(500))
    const clock = { t: 1_000_000 }
    const reader = createSurveyLogReader({ root, maxBytes: 100, now: () => clock.t, io: { parse: (buf) => ({ records: [{ len: buf.length }], torn: false }) } })
    await settle(reader, clock, 'a')
    assert.deepEqual(await reader('a'), { records: [{ len: 100 }], torn: false })
    assert.deepEqual(await reader('b'), { tooLarge: true })
    assert.deepEqual(await reader('c'), { tooLarge: true })
    // a stat that lies (small) while the file is over the cap: the read itself detects it
    const lyingClock = { t: 1_000_000 }
    const lying = createSurveyLogReader({ root, maxBytes: 100, now: () => lyingClock.t, io: { stat: async () => ({ size: 1, mtimeMs: 1 }), parse: () => ({ records: [], torn: false }) } })
    await settle(lying, lyingClock, 'c')
    assert.deepEqual(await lying('c'), { tooLarge: true })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('survey log reader: the read buffer is bounded by the file size, not by the 64 MB cap', async () => {
  const { createSurveyLogReader, SURVEY_LOG_BYTES } = await load()
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { SESSION_LOG } = await import('../paused.js')
  const root = await mkdtemp(join(tmpdir(), 'tip-lim2-'))
  const real = Buffer.allocUnsafe
  const sizes = []
  try {
    await mkdir(join(root, 'p', 'a'), { recursive: true })
    await writeFile(join(root, 'p', 'a', SESSION_LOG), 'x'.repeat(300))
    const clock = { t: 1_000_000 }
    const reader = createSurveyLogReader({ root, now: () => clock.t, io: { parse: (buf) => ({ records: [{ len: buf.length }], torn: false }) } })
    await settle(reader, clock, 'a')
    Buffer.allocUnsafe = (size, ...rest) => { sizes.push(size); return real(size, ...rest) }
    const out = await reader('a')
    Buffer.allocUnsafe = real
    assert.deepEqual(out, { records: [{ len: 300 }], torn: false })
    assert.ok(sizes.length > 0 && sizes.every((s) => s <= 1000), 'allocations: ' + sizes.join(',') + ' (cap ' + SURVEY_LOG_BYTES + ')')
  } finally { Buffer.allocUnsafe = real; await rm(root, { recursive: true, force: true }) }
})

test('survey log reader: the default cap is 16 MB and a log over it is tooLarge', async () => {
  const { createSurveyLogReader, SURVEY_LOG_BYTES } = await load()
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { SESSION_LOG } = await import('../paused.js')
  assert.equal(SURVEY_LOG_BYTES, 16 * 1024 * 1024)
  const root = await mkdtemp(join(tmpdir(), 'tip-lim3-'))
  try {
    await mkdir(join(root, 'p', 'a'), { recursive: true })
    await writeFile(join(root, 'p', 'a', SESSION_LOG), Buffer.alloc(SURVEY_LOG_BYTES + 1, 120))
    const reader = createSurveyLogReader({ root, io: { parse: () => { throw new Error('must not parse') } } })
    assert.deepEqual(await reader('a'), { tooLarge: true })
  } finally { await rm(root, { recursive: true, force: true }) }
})

/** The reader parses a log only after it stayed unchanged for 30 s: look once at each, then let 30 s pass. */
async function settle(reader, clock, ...ids) {
  for (const id of ids) await reader(id)
  clock.t += 30_000
}

async function twoLogs(prefix) {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { SESSION_LOG } = await import('../paused.js')
  const root = await mkdtemp(join(tmpdir(), prefix))
  for (const s of ['a', 'b']) { await mkdir(join(root, 'p', s), { recursive: true }); await writeFile(join(root, 'p', s, SESSION_LOG), 'x'.repeat(10)) }
  return root
}

test('survey log reader: reads for different sessions run one at a time, in call order', async () => {
  const { createSurveyLogReader } = await load()
  const { rm } = await import('node:fs/promises')
  const root = await twoLogs('tip-ser-')
  try {
    const events = []
    let release
    const gate = new Promise((r) => { release = r })
    let n = 0
    const readFile = async () => { const id = ++n; events.push('start' + id); if (id === 1) await gate; events.push('end' + id); return Buffer.from('x') }
    const clock = { t: 1_000_000 }
    const reader = createSurveyLogReader({ root, now: () => clock.t, io: { readFile, parse: () => ({ records: [], torn: false }) } })
    await settle(reader, clock, 'a', 'b')
    const p1 = reader('a')
    const p2 = reader('b')
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(events, ['start1'], 'the second read waits for the first')
    release()
    assert.deepEqual([await p1, await p2], [{ records: [], torn: false }, { records: [], torn: false }])
    assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('survey log reader: a failing first read does not stop the second', async () => {
  const { createSurveyLogReader } = await load()
  const { rm } = await import('node:fs/promises')
  const root = await twoLogs('tip-ser2-')
  try {
    let n = 0
    const readFile = async () => { if (++n === 1) throw new Error('boom'); return Buffer.from('x') }
    const clock = { t: 1_000_000 }
    const reader = createSurveyLogReader({ root, now: () => clock.t, io: { readFile, parse: () => ({ records: [{ ok: 1 }], torn: false }) } })
    await settle(reader, clock, 'a', 'b')
    const p1 = reader('a')
    const p2 = reader('b')
    assert.equal(await p1, undefined)
    assert.deepEqual(await p2, { records: [{ ok: 1 }], torn: false })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('parsePlaces: only the last 64 KB is scanned', async () => {
  const { parsePlaces } = await load()
  const block = json([{ path: 'src/a.js', what: 'Would gain.' }])
  assert.deepEqual(parsePlaces('y'.repeat(100_000) + '\n' + block), [{ path: 'src/a.js', what: 'Would gain.' }], 'a block at the end after a long preamble still parses')
  // a block that starts before the last 64 KB window is cut off, so it is not parsed (the JSON block must come last)
  assert.deepEqual(parsePlaces(block + '\n' + 'y'.repeat(70_000)), [])
})

test('parsePlaces: 200 KB of unmatched fence openers is rejected quickly', async () => {
  const { parsePlaces } = await load()
  const reply = '```json\n'.repeat(25_000)
  assert.ok(reply.length >= 200_000)
  const start = Date.now()
  assert.deepEqual(parsePlaces(reply), [])
  assert.ok(Date.now() - start < 2000, 'took ' + (Date.now() - start) + ' ms')
})

test('survey log reader: a read abandoned by the timeout does not mark the log parsed, so the next look reads it again', async () => {
  const { createSurveyLogReader } = await load()
  const { rm } = await import('node:fs/promises')
  const root = await twoLogs('tip-aband-')
  try {
    let n = 0
    let finish
    const readFile = () => (++n === 1 ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(Buffer.from('x')))
    const clock = { t: 1_000_000 }
    const timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }
    const reader = createSurveyLogReader({ root, now: () => clock.t, timers, readTimeoutMs: 20, io: { readFile, parse: () => ({ records: [{ ok: 1 }], torn: false }) } })
    await settle(reader, clock, 'a')
    assert.equal(await reader('a'), undefined, 'the first read timed out')
    finish(Buffer.from('x'))
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(await reader('a'), { records: [{ ok: 1 }], torn: false }, 'the late result must not make the log look parsed')
    assert.equal(n, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('survey log reader: a read that finishes after the timeout is not parsed (its result is dropped anyway)', async () => {
  const { createSurveyLogReader } = await load()
  const { rm } = await import('node:fs/promises')
  const root = await twoLogs('tip-noparse-')
  try {
    let finish
    let parses = 0
    const readFile = () => new Promise((resolve) => { finish = resolve })
    const clock = { t: 1_000_000 }
    const timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }
    const reader = createSurveyLogReader({ root, now: () => clock.t, timers, readTimeoutMs: 20, io: { readFile, parse: () => { parses += 1; return { records: [], torn: false } } } })
    await settle(reader, clock, 'a')
    assert.equal(await reader('a'), undefined)
    finish(Buffer.from('x'))
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(parses, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})