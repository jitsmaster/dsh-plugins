import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../store.js'
import { createDismissals, createPausedTracker } from '../paused.js'
import { createIdleResumer } from '../idle-resume.js'

// A session on hold is parked on purpose: the paused-session scan does not call it cut off and the idle check does not resume it.
const memIo = () => { const io = { text: undefined, read: () => io.text, write: (t) => { io.text = t } }; return io }
const cand = (id) => ({ sessionId: id, cwd: 'D:/w', title: 'T ' + id, lastWrite: 1000, kinds: ['open-turn'], reason: 'cut', turn: 1, danglingCalls: [], pending: 0, lastUser: 'x', lastAssistant: 'y' })

test('the paused scan adds no item for a held session, and closes the paused card it already had', async () => {
  const store = createStore()
  const held = new Set()
  const tracker = createPausedTracker({ store, dismissals: createDismissals({ io: memIo() }), heldIds: () => held, scan: async () => ({ ok: true, candidates: [cand('a'), cand('b')] }) })
  held.add('b')
  assert.deepEqual(await tracker.scan(), { ok: true, added: 1, updated: 0, resolved: 0, total: 1 })
  assert.deepEqual(store.snapshot().open.map((i) => i.sessionId), ['a'])
  held.add('a')
  assert.deepEqual(await tracker.scan(), { ok: true, added: 0, updated: 0, resolved: 1, total: 0 })
})

test('the idle check never reads or resumes a held session', async () => {
  const read = []
  const prompts = []
  const resumer = createIdleResumer({
    controllerOf: () => ({ list: async () => ({ items: [{ sessionId: 'held-1', updatedAt: 1000, running: false }] }), prompt: async (r) => { prompts.push(r) } }),
    readLog: async (id) => { read.push(id); return undefined },
    judge: async () => ({ resume: true }),
    heldIds: () => new Set(['held-1']),
    now: () => 10 * 3600_000, idleMs: 60_000, maxAgeMs: 24 * 3600_000,
  })
  const r = await resumer.check()
  assert.equal(r.ok, true)
  assert.deepEqual([read, prompts.length, r.checked], [[], 0, 0])
})

test('index.js wires the hold queue: the service gets onHold, the paused scan and the idle check get heldIds, and a timer runs the ticket check', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  for (const needle of ['createOnHold', 'onHold', 'heldIds', 'onHoldCheckMs', 'fetchTicketState']) assert.ok(src.includes(needle), needle)
  assert.ok(src.includes('onHold?.heldSessionIds()'), 'the held ids come from onhold.js heldSessionIds (there is no heldIds on it)')
  assert.ok(!src.includes('onHold?.heldIds()'))
})
