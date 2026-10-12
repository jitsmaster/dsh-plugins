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
    confirm: false,
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

test('router unavailable: the text falls back to dictation, still read back when confirm is on', async () => {
  const h = harness({ confirm: true, router: async () => undefined })
  const r = await h.d.handle(say('do something clever', { context: 'a' }))
  assert.equal(r.kind, 'confirming')
  assert.deepEqual(h.calls, [])
  await h.d.handle(say('yes'))
  assert.equal(h.calls[0][0], 'prompt')
})

test('clear(id) only drops a pending confirmation that targets that session', async () => {
  const h = harness({ confirm: true })
  await h.d.handle(say('compact', { context: 'a' }))
  h.d.clear('b')
  await h.d.handle(say('yes'))
  assert.equal(h.calls.filter((c) => c[0] === 'slash').length, 1)
  await h.d.handle(say('compact', { context: 'a' }))
  h.d.clear('a')
  await h.d.handle(say('yes'))
  assert.equal(h.calls.filter((c) => c[0] === 'slash').length, 1)
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

test('with confirm on, a dictation is read back and sent only on yes', async () => {
  const h = harness({ confirm: true })
  const r = await h.d.handle(say('please refactor the parser', { context: 'a' }))
  assert.equal(r.kind, 'confirming')
  assert.deepEqual(h.calls, [])
  assert.match(h.spoken.at(-1), /please refactor the parser/)
  assert.match(h.spoken.at(-1), /Voice Work/)
  assert.match(h.spoken.at(-1), /yes/i)
  const r2 = await h.d.handle(say('yes'))
  assert.equal(r2.kind, 'dictation')
  assert.equal(h.calls[0][0], 'prompt')
  assert.equal(h.calls[0][1].sessionId, 'a')
  assert.deepEqual(h.calls[0][1].content, [{ type: 'text', text: 'please refactor the parser' }])
})

test('with confirm on, a no cancels a pending dictation', async () => {
  const h = harness({ confirm: true })
  await h.d.handle(say('please refactor the parser', { context: 'a' }))
  assert.equal((await h.d.handle(say('no'))).kind, 'cancelled')
  assert.deepEqual(h.calls, [])
})

test('with confirm on, grammar commands are read back first', async () => {
  const h = harness({ confirm: true })
  const r = await h.d.handle(say('compact'))
  assert.equal(r.kind, 'confirming')
  assert.deepEqual(h.calls, [])
  await h.d.handle(say('yes'))
  assert.deepEqual(h.calls, [['slash', { sessionId: 'b', name: 'compact', input: '' }]])
})

test('with confirm on, stop and deny stay immediate', async () => {
  const h = harness({ confirm: true })
  assert.equal((await h.d.handle(say('stop'))).kind, 'executed')
  assert.equal((await h.d.handle(say('deny'))).kind, 'executed')
  assert.equal(h.calls.length, 2)
})

test('with confirm on, an approve is read back before it grants anything', async () => {
  const h = harness({ confirm: true })
  assert.equal((await h.d.handle(say('approve'))).kind, 'confirming')
  assert.deepEqual(h.calls, [])
  await h.d.handle(say('yes'))
  assert.deepEqual(h.calls, [['answer', { sessionId: 'b', decision: 'approve' }]])
})

test('with confirm on, a pending dictation expires and an unrelated reply replaces it', async () => {
  const h = harness({ confirm: true })
  await h.d.handle(say('first prompt text here', { context: 'a' }))
  const r = await h.d.handle(say('second prompt text here', { context: 'a' }))
  assert.equal(r.kind, 'confirming')
  await h.d.handle(say('yes'))
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0][1].content[0].text, 'second prompt text here')
})

test('confirm can be a live setting (function)', async () => {
  let on = true
  const h = harness({ confirm: () => on })
  assert.equal((await h.d.handle(say('compact'))).kind, 'confirming')
  on = false
  h.advance(20000)
  assert.equal((await h.d.handle(say('compact'))).kind, 'executed')
})

test('settings: voiceConfirm defaults on and is validated as boolean', async () => {
  const { createSettings } = await import('../settings.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const s = createSettings(mkdtempSync(join(tmpdir(), 'vc-')), {})
  assert.equal(s.get().voiceConfirm, true)
  assert.throws(() => s.set({ voiceConfirm: 'yes' }))
  s.set({ voiceConfirm: false })
  assert.equal(s.get().voiceConfirm, false)
})

test('the read-back contains the whole dictated text, not a truncated head', async () => {
  const h = harness({ confirm: true })
  const text = 'please ' + Array.from({ length: 25 }, (_, i) => 'word' + i).join(' ') + ' and finally delete nothing'
  await h.d.handle(say(text, { context: 'a' }))
  assert.ok(h.spoken.at(-1).includes('and finally delete nothing'))
})

test('a confirmed dictation reports the text that was sent', async () => {
  const h = harness({ confirm: true })
  await h.d.handle(say('please refactor the parser', { context: 'a' }))
  const r = await h.d.handle(say('yes'))
  assert.equal(r.text, 'please refactor the parser')
})

test('with confirm on, option answers stay immediate', async () => {
  const h = harness({ confirm: true })
  assert.equal((await h.d.handle(say('option two'))).kind, 'executed')
})

test('a pending dictation really expires after the ttl', async () => {
  const h = harness({ confirm: true })
  await h.d.handle(say('please refactor the parser', { context: 'a' }))
  h.advance(20000)
  await h.d.handle(say('yes'))
  assert.equal(h.calls.filter((c) => c[0] === 'prompt').length, 0)
})

test('security: an LLM-routed approve is always read back, even with confirm off', async () => {
  const h = harness({ confirm: false, router: async () => ({ id: 'approve', action: 'approval', decision: 'approve', args: {}, viaLlm: true }) })
  const r = await h.d.handle(say('sure go ahead then', { confidence: 0.9 }))
  assert.equal(r.kind, 'confirming')
  assert.deepEqual(h.calls, [])
})

test('security: the approve read-back names the tool and a changed request is refused', async () => {
  let current = { toolName: 'Bash', token: 1 }
  const h = harness({ confirm: true, approvals: { answer: async (a) => { h.calls.push(['answer', a]); return {} }, peek: () => current } })
  await h.d.handle(say('approve'))
  assert.match(h.spoken.at(-1), /Bash/)
  current = { toolName: 'Write', token: 2 }
  const r = await h.d.handle(say('yes'))
  assert.equal(r.kind, 'stale')
  assert.deepEqual(h.calls, [])
  assert.match(h.spoken.at(-1), /changed/i)
})

test('security: an unchanged request is approved on yes', async () => {
  const cur = { toolName: 'Bash', token: 1 }
  const h = harness({ confirm: true, approvals: { answer: async (a) => { h.calls.push(['answer', a]); return {} }, peek: () => cur } })
  await h.d.handle(say('approve'))
  assert.equal((await h.d.handle(say('yes'))).kind, 'executed')
})

test('security: a low-confidence yes does not confirm and keeps the question open', async () => {
  const h = harness({ confirm: true })
  await h.d.handle(say('compact'))
  const r = await h.d.handle(say('yes', { confidence: 0.5 }))
  assert.equal(r.kind, 'unsure')
  assert.deepEqual(h.calls, [])
  assert.equal((await h.d.handle(say('yes', { confidence: 0.9 }))).kind, 'executed')
})

test('security: stop runs instantly even while a confirmation is pending', async () => {
  const h = harness({ confirm: true })
  await h.d.handle(say('compact'))
  const r = await h.d.handle(say('stop'))
  assert.equal(r.kind, 'executed')
  assert.deepEqual(h.calls, [['cancel', { sessionId: 'b' }]])
  assert.equal((await h.d.handle(say('yes'))).kind, 'confirming') // pending was dropped; yes is the plain approve command, itself read back
  assert.equal(h.calls.filter((c) => c[0] === 'slash').length, 0)
})

test('security: clear() drops a pending confirmation', async () => {
  const h = harness({ confirm: true })
  await h.d.handle(say('compact'))
  h.d.clear()
  await h.d.handle(say('yes'))
  assert.equal(h.calls.filter((c) => c[0] === 'slash').length, 0)
})

test('security: feedback text is spoken in the read-back', async () => {
  const { describeMatch } = await import('../voice/commands.js')
  assert.match(describeMatch({ id: 'feedback', args: { text: 'the tool is slow' } }, 'X'), /the tool is slow/)
})

test('security: cancel/deny/reject dismiss a pending read-back instead of acting; stop still stops', async () => {
  const h = harness({ confirm: true })
  await h.d.handle(say('please refactor the parser', { context: 'a' }))
  assert.equal((await h.d.handle(say('cancel'))).kind, 'cancelled')
  await h.d.handle(say('please refactor the parser', { context: 'a' }))
  assert.equal((await h.d.handle(say('deny'))).kind, 'cancelled')
  assert.deepEqual(h.calls, [])
  await h.d.handle(say('please refactor the parser', { context: 'a' }))
  assert.equal((await h.d.handle(say('stop'))).kind, 'executed')
  assert.equal(h.calls[0][0], 'cancel')
})

test('security: a routed result is dropped when a newer transcript arrived meanwhile', async () => {
  let release
  const h = harness({ confirm: true, router: () => new Promise((r) => { release = r }) })
  const first = h.d.handle(say('do something clever for me', { context: 'a' }))
  await new Promise((r) => setImmediate(r))
  await h.d.handle(say('stop'))
  release({ kind: 'dictation' })
  assert.equal((await first).kind, 'superseded')
  assert.equal(h.calls.filter((c) => c[0] === 'prompt').length, 0)
})
