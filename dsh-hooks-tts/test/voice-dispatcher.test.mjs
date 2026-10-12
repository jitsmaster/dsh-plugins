import assert from 'node:assert/strict'
import test from 'node:test'
import { createDispatcher } from '../voice/dispatcher.js'

const SESSIONS = [
  { id: 'a', title: 'Voice Work' },
  { id: 'b', title: 'TTS hooks cleanup' },
]

function harness(extra = {}) {
  const calls = []
  const spoken = []
  let t = 1000
  const rec = (name) => async (arg) => { calls.push([name, arg]); return {} }
  const d = createDispatcher({
    sessions: () => SESSIONS,
    lastAlerted: () => 'b',
    session: { cancel: rec('cancel'), create: rec('create'), fork: rec('fork'), rename: rec('rename'), selectModel: rec('selectModel'), prompt: rec('prompt') },
    approvals: { answer: rec('answer') },
    slash: rec('slash'),
    ui: { switchTo: rec('switchTo') },
    speak: (s) => spoken.push(s),
    now: () => t,
    minConfidence: 0.3,
    confirmTtlMs: 15000,
    ...extra,
  })
  return { d, calls, spoken, advance: (ms) => { t += ms } }
}
const say = (text, extra = {}) => ({ type: 'transcript', id: 1, text, confidence: 0.9, ...extra })

test('non-transcript events, empty text and low confidence are ignored', async () => {
  const h = harness()
  assert.equal((await h.d.handle({ type: 'listening' })).kind, 'ignored')
  assert.equal((await h.d.handle(say('   '))).kind, 'ignored')
  assert.equal((await h.d.handle(say('stop', { confidence: 0.1 }))).kind, 'ignored')
  assert.deepEqual(h.calls, [])
})

test('dictation goes to the context session as a queued prompt', async () => {
  const h = harness()
  const r = await h.d.handle(say('please refactor the parser', { context: 'a' }))
  assert.equal(r.kind, 'dictation')
  assert.equal(h.calls[0][0], 'prompt')
  assert.equal(h.calls[0][1].sessionId, 'a')
  assert.equal(h.calls[0][1].mode, 'queue')
  assert.deepEqual(h.calls[0][1].content, [{ type: 'text', text: 'please refactor the parser' }])
  assert.match(h.calls[0][1].requestId, /^voice-/)
})

test('dictation without context goes to the last alerted session', async () => {
  const h = harness()
  await h.d.handle(say('keep going'))
  assert.equal(h.calls[0][1].sessionId, 'b')
})

test('stop cancels the last alerted session; a spoken target overrides it', async () => {
  const h = harness()
  await h.d.handle(say('stop'))
  assert.deepEqual(h.calls[0], ['cancel', { sessionId: 'b' }])
  await h.d.handle(say('stop in voice work'))
  assert.deepEqual(h.calls[1], ['cancel', { sessionId: 'a' }])
})

test('approve and option answer the approval of the resolved session', async () => {
  const h = harness()
  await h.d.handle(say('approve'))
  assert.deepEqual(h.calls[0], ['answer', { sessionId: 'b', decision: 'approve' }])
  await h.d.handle(say('option two'))
  assert.deepEqual(h.calls[1], ['answer', { sessionId: 'b', decision: 'option', number: 2 }])
})

test('slash commands run with their raw input', async () => {
  const h = harness()
  await h.d.handle(say('goal ship the client'))
  assert.deepEqual(h.calls[0], ['slash', { sessionId: 'b', name: 'goal', input: ' ship the client' }])
  await h.d.handle(say('compact'))
  assert.deepEqual(h.calls[1], ['slash', { sessionId: 'b', name: 'compact', input: '' }])
  await h.d.handle(say('permission workspace write'))
  assert.deepEqual(h.calls[2], ['slash', { sessionId: 'b', name: 'permission', input: ' workspace-write' }])
})

test('rename, new, and switch use their own arguments', async () => {
  const h = harness()
  await h.d.handle(say('rename session to Parser Work'))
  assert.deepEqual(h.calls[0], ['rename', { sessionId: 'b', title: 'Parser Work' }])
  await h.d.handle(say('new session'))
  assert.equal(h.calls[1][0], 'create')
  await h.d.handle(say('switch to voice'))
  assert.deepEqual(h.calls[2], ['switchTo', { sessionId: 'a' }])
})

test('an ambiguous or unknown target speaks instead of acting', async () => {
  const h = harness({ sessions: () => [{ id: 'a', title: 'Voice Work' }, { id: 'c', title: 'Voice Control' }] })
  const r = await h.d.handle(say('stop in voice'))
  assert.equal(r.kind, 'ambiguous')
  assert.match(h.spoken.at(-1), /Voice Work/)
  assert.match(h.spoken.at(-1), /Voice Control/)
  const r2 = await h.d.handle(say('stop in zebra'))
  assert.equal(r2.kind, 'no-session')
  assert.deepEqual(h.calls, [])
})

test('no known session at all is reported, not guessed', async () => {
  const h = harness({ lastAlerted: () => undefined })
  const r = await h.d.handle(say('stop'))
  assert.equal(r.kind, 'no-session')
  assert.deepEqual(h.calls, [])
})

test('confirm-flagged commands read back first and run only on yes', async () => {
  const h = harness()
  const r = await h.d.handle(say('fork session'))
  assert.equal(r.kind, 'confirming')
  assert.deepEqual(h.calls, [])
  assert.match(h.spoken.at(-1), /fork/i)
  assert.match(h.spoken.at(-1), /TTS hooks cleanup/)
  const r2 = await h.d.handle(say('yes'))
  assert.equal(r2.kind, 'executed')
  assert.deepEqual(h.calls, [['fork', { sessionId: 'b' }]])
})

test('no, or an unrelated reply, drops the pending command', async () => {
  const h = harness()
  await h.d.handle(say('fork session'))
  assert.equal((await h.d.handle(say('no'))).kind, 'cancelled')
  assert.deepEqual(h.calls, [])
  await h.d.handle(say('fork session'))
  const r = await h.d.handle(say('something else entirely', { context: 'a' }))
  assert.equal(r.kind, 'dictation')
  assert.equal(h.calls.filter((c) => c[0] === 'fork').length, 0)
})

test('a read-back expires: a late yes is just the approve command', async () => {
  const h = harness()
  await h.d.handle(say('fork session'))
  h.advance(20000)
  const r = await h.d.handle(say('yes'))
  assert.equal(r.kind, 'executed')
  assert.deepEqual(h.calls, [['answer', { sessionId: 'b', decision: 'approve' }]])
})

test('a failing action is spoken and reported, never thrown', async () => {
  const h = harness({ session: { cancel: async () => { throw new Error('boom') }, prompt: async () => ({}) } })
  const r = await h.d.handle(say('stop'))
  assert.equal(r.kind, 'failed')
  assert.match(h.spoken.at(-1), /failed|could not/i)
})

test('a low-confidence approve is never executed; the user is asked to repeat', async () => {
  const h = harness()
  const r = await h.d.handle(say('approve', { confidence: 0.5 }))
  assert.equal(r.kind, 'unsure')
  assert.deepEqual(h.calls, [])
  assert.match(h.spoken.at(-1), /again/i)
  await h.d.handle(say('deny', { confidence: 0.5 }))
  assert.deepEqual(h.calls, [['answer', { sessionId: 'b', decision: 'deny' }]])
})

test('a confident approve still runs', async () => {
  const h = harness()
  await h.d.handle(say('approve', { confidence: 0.9 }))
  assert.equal(h.calls[0][0], 'answer')
})

test('a transcript with no confidence field is treated as unsure for approve', async () => {
  const h = harness()
  const r = await h.d.handle({ type: 'transcript', id: 1, text: 'approve' })
  assert.equal(r.kind, 'unsure')
})

test('every action is acknowledged out loud before it runs', async () => {
  const order = []
  const h = harness({ speak: (s) => order.push('speak:' + s), session: { cancel: async () => { order.push('cancel') }, prompt: async () => { order.push('prompt') } } })
  await h.d.handle(say('stop'))
  assert.deepEqual(order, ['speak:Heard "stop". Stopping TTS hooks cleanup.', 'cancel'])
  await h.d.handle(say('keep refactoring the parser please', { context: 'a' }))
  assert.match(order.at(-2), /^speak:Heard\. Sending to Voice Work/)
  assert.equal(order.at(-1), 'prompt')
})

test('acknowledgement can be switched off', async () => {
  const h = harness({ ack: false })
  await h.d.handle(say('stop'))
  assert.deepEqual(h.spoken, [])
})

test('anything the grammar does not match goes to the router; a command it returns is run', async () => {
  const routed = []
  const h = harness({ router: async (text, ctx) => { routed.push([text, ctx.sessions.length]); return { id: 'cancel', action: 'session', method: 'cancel', args: {}, target: 'voice work', viaLlm: true } } })
  const r = await h.d.handle(say('hey can you kill the voice session'))
  assert.deepEqual(routed, [['hey can you kill the voice session', 2]])
  assert.equal(r.kind, 'confirming')
  await h.d.handle(say('yes'))
  assert.deepEqual(h.calls, [['cancel', { sessionId: 'a' }]])
})

test('a router command that only observes or answers does not need a read-back', async () => {
  const h = harness({ router: async () => ({ id: 'deny', action: 'approval', decision: 'deny', args: {}, viaLlm: true }) })
  const r = await h.d.handle(say('nope do not let it'))
  assert.equal(r.kind, 'executed')
  assert.deepEqual(h.calls, [['answer', { sessionId: 'b', decision: 'deny' }]])
})

test('router says dictation: the text is sent as a prompt', async () => {
  const h = harness({ router: async () => ({ kind: 'dictation' }) })
  const r = await h.d.handle(say('please refactor the parser', { context: 'a' }))
  assert.equal(r.kind, 'dictation')
  assert.equal(h.calls[0][1].sessionId, 'a')
})

test('router unavailable: the user is told, and nothing is sent', async () => {
  const h = harness({ router: async () => undefined })
  const r = await h.d.handle(say('do something clever'))
  assert.equal(r.kind, 'unroutable')
  assert.deepEqual(h.calls, [])
  assert.match(h.spoken.at(-1), /could not|couldn't/i)
})

test('a long utterance is dictation without asking the router', async () => {
  let asked = 0
  const h = harness({ router: async () => { asked++; return undefined } })
  const long = Array.from({ length: 30 }, (_, i) => 'word' + i).join(' ')
  const r = await h.d.handle(say(long, { context: 'a' }))
  assert.equal(r.kind, 'dictation')
  assert.equal(asked, 0)
})

test('grammar matches never wait for the router', async () => {
  let asked = 0
  const h = harness({ router: async () => { asked++; return undefined } })
  await h.d.handle(say('stop'))
  assert.equal(asked, 0)
})
