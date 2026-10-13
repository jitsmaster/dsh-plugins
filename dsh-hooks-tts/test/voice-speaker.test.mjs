// Spec: docs/voice-two-stage-flow.md §0 D1, §2 (voice/speaker.js createSpeakWorker, scripts/speak-worker.ps1 protocol), §7 S1–S6.
// Shapes chosen where the spec is open (implementer: follow these):
// - createSpeakWorker({ spawn, root, env, log, setTimer, clearTimer, now, requestTimeoutMs = 45000, maxRespawns = 3 })
//   (now = clock dep, default Date.now; it measures the 60 s respawn window and the latencies below).
// - Spawn: spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
//   join(root, 'scripts', 'speak-worker.ps1')], { stdio: ['pipe', 'pipe', <any>], windowsHide: true, env }); NOT detached.
// - Worker spawned lazily by the first speak() or by warm(); warm() writes nothing (no warm-up audio); one worker serves
//   every line. Requests are NOT held back until {"ready":true} (stdin buffers them).
// - Request line (exact): JSON.stringify({ id, text, gender, priority }) + '\n'; id = number, 1, 2, 3 ... per speaker
//   instance (keeps counting across respawns). opts default to { gender: 'female', priority: 'High' } (§0 D3).
// - Worker stdout lines: {"ready":true} | {"id":n,"event":"start"} | {"id":n,"status":"done"|"failed","ms":n}; chunks may
//   split a line; non-JSON lines are ignored.
// - speak() never rejects. It resolves:
//     worker status  -> { status, ms: <worker ms> } plus startMs = now()@start event - now()@speak() when a start event came;
//     worker exit / kill / spawn throw -> { status: 'failed', ms: now() - now()@speak() };
//     no status within requestTimeoutMs (injected setTimer) -> { status: 'timeout', ms: now() - now()@speak() }, and the
//     hung worker is killed; the next line goes to a new worker.
// - Respawn limit: the 4th unexpected worker exit within 60 s (a 4th respawn would be needed; maxRespawns = 3) switches to
//   one-shot mode: every speak() spawns its own process, writes its single request line and ends stdin (EOF).
// - stop(): kills the worker; its 'exit' fails pending lines; no respawn follows the stop. Child events used: 'exit'.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import * as speakerModule from '../voice/speaker.js'

const VOICE = { priority: 'High', gender: 'female' }
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(setImmediate) }
const line = (id, text, gender = 'female', priority = 'High') => JSON.stringify({ id, text, gender, priority }) + '\n'

let pids = 4000
function fakeChild() {
  const child = new EventEmitter()
  child.pid = ++pids
  child.input = ''
  child.ended = false
  child.killed = false
  child.stdin = new Writable({
    write(chunk, _enc, cb) { child.input += chunk.toString(); cb() },
    final(cb) { child.ended = true; cb() },
  })
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', null, 'SIGTERM')); return true }
  child.send = async (obj) => { child.stdout.write(typeof obj === 'string' ? obj : JSON.stringify(obj) + '\n'); await tick() }
  child.die = async (code = 1) => { child.emit('exit', code, null); await tick() }
  return child
}

function harness(over = {}) {
  const h = { spawns: [], logs: [], timers: [], unlinks: [], writes: [], t: 1000 }
  let tid = 0
  h.speaker = speakerModule.createSpeakWorker({
    spawn: (cmd, args, opts) => { const child = fakeChild(); h.spawns.push({ cmd, args, opts, child }); return child },
    root: 'R',
    env: { A: '1' },
    log: (stage, data) => { h.logs.push({ stage, data }) },
    setTimer: (fn, ms) => { const id = ++tid; h.timers.push({ id, fn, ms }); return id },
    clearTimer: (id) => { h.timers = h.timers.filter((t) => t.id !== id) },
    now: () => h.t,
    unlink: (p) => { h.unlinks.push(p) }, // never touch the real priority flag from a test
    writeFile: (p, c) => { h.writes.push([p, String(c)]) }, // nor the real stop flag / cancel marker
    ...over,
  })
  h.child = () => h.spawns.at(-1)?.child
  h.speak = async (text, opts = VOICE) => { const p = h.speaker.speak(text, opts); await tick(); return p }
  return h
}

/** 'pending' or the resolved value (speak() must never reject). */
async function peek(p) {
  let s = 'pending'
  p.then((v) => { s = v }, (e) => { s = 'rejected: ' + e })
  await tick()
  return s
}

test('S1 one persistent worker serves many lines; each request is one JSON line in the female High voice', async () => {
  const h = harness()
  h.speaker.warm()
  h.speaker.warm()
  assert.equal(h.spawns.length, 1)
  const { cmd, args, opts, child } = h.spawns[0]
  // The absolute Windows PowerShell path (no PATH lookup of a bare name that a writable directory could shadow).
  assert.equal(cmd, join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join('R', 'scripts', 'speak-worker.ps1')])
  assert.equal(opts.windowsHide, true)
  assert.notEqual(opts.detached, true)
  assert.deepEqual(opts.env, { A: '1' })
  assert.equal(opts.stdio[0], 'pipe')
  assert.equal(opts.stdio[1], 'pipe')
  assert.equal(child.input, '', 'warm() plays no warm-up audio')
  await child.send({ ready: true })
  h.speak('I heard: fix the parser. Is that right?', VOICE)
  h.speak('Deciding with LLM.', VOICE)
  h.speak('我听到了')
  await tick()
  assert.equal(h.spawns.length, 1)
  assert.equal(child.input,
    line(1, 'I heard: fix the parser. Is that right?') + line(2, 'Deciding with LLM.') + line(3, '我听到了'))
  assert.equal(child.ended, false)
})

test('S1 the first speak() spawns the worker when warm() was never called', async () => {
  const h = harness()
  h.speak('Hello there', VOICE)
  await tick()
  assert.equal(h.spawns.length, 1)
  assert.equal(h.child().input, line(1, 'Hello there'))
})

test('S2 each line resolves on its own {id,status} line with the worker ms and the playback-start latency', async () => {
  const h = harness()
  const p1 = h.speaker.speak('one', VOICE)
  const p2 = h.speaker.speak('two', VOICE)
  await tick()
  const c = h.child()
  await c.send({ ready: true })
  await c.send('WARNING: not a protocol line\n')
  await c.send({ id: 2, status: 'done', ms: 40 })
  assert.deepEqual(await peek(p2), { status: 'done', ms: 40 })
  assert.equal(await peek(p1), 'pending', 'a status for another id does not resolve this line')
  h.t = 1120
  await c.send({ id: 1, event: 'start' })
  assert.equal(await peek(p1), 'pending', 'the start event alone does not resolve the line')
  h.t = 1950
  c.stdout.write('{"id":1,"sta')
  await tick()
  await c.send('tus":"done","ms":812}\n')
  assert.deepEqual(await peek(p1), { status: 'done', startMs: 120, ms: 812 })
})

test('S2 a failed status from the worker is passed through', async () => {
  const h = harness()
  const p = h.speaker.speak('x', VOICE)
  await tick()
  await h.child().send({ id: 1, status: 'failed', ms: 30 })
  assert.deepEqual(await peek(p), { status: 'failed', ms: 30 })
})

test('S3 a worker exit fails every pending line and the next line goes to a respawned worker', async () => {
  const h = harness()
  const p1 = h.speaker.speak('one', VOICE)
  const p2 = h.speaker.speak('two', VOICE)
  await tick()
  const first = h.child()
  h.t = 1300
  await first.die(1)
  assert.deepEqual(await peek(p1), { status: 'failed', ms: 300 })
  assert.deepEqual(await peek(p2), { status: 'failed', ms: 300 })
  const p3 = h.speaker.speak('three', VOICE)
  await tick()
  assert.equal(h.spawns.length, 2)
  const second = h.child()
  assert.notEqual(second, first)
  assert.equal(second.input, line(3, 'three'))
  assert.equal(first.input, line(1, 'one') + line(2, 'two'), 'nothing is written to the dead worker')
  await second.send({ id: 3, status: 'done', ms: 5 })
  assert.deepEqual(await peek(p3), { status: 'done', ms: 5 })
})

test('S3 a spawn that throws resolves the line as failed instead of throwing', async () => {
  const h = harness({ spawn: () => { throw new Error('ENOENT powershell.exe') } })
  let p
  assert.doesNotThrow(() => { p = h.speaker.speak('x', VOICE) })
  assert.deepEqual(await peek(p), { status: 'failed', ms: 0 })
})

test('S4 a line without an answer times out after 45 s, kills the hung worker and the next line respawns it', async () => {
  const h = harness()
  const p = h.speaker.speak('x', VOICE)
  await tick()
  const hung = h.child()
  const timer = h.timers.find((t) => t.ms === 45000)
  assert.ok(timer, 'a 45000 ms request timer is armed')
  h.t += 45000
  h.timers = h.timers.filter((t) => t !== timer)
  timer.fn()
  await tick()
  assert.deepEqual(await peek(p), { status: 'timeout', ms: 45000 })
  assert.equal(hung.killed, true)
  const p2 = h.speaker.speak('y', VOICE)
  await tick()
  assert.equal(h.spawns.length, 2)
  assert.equal(h.child().input, line(2, 'y'))
  await h.child().send({ id: 2, status: 'done', ms: 7 })
  assert.deepEqual(await peek(p2), { status: 'done', ms: 7 })
  for (const t of h.timers.filter((x) => x.ms === 45000)) t.fn()
  await tick()
  assert.equal(h.child().killed, false, "an answered line's timer never kills the worker")
  assert.equal(h.spawns.length, 2)
})

test('S4 requestTimeoutMs is configurable', async () => {
  const h = harness({ requestTimeoutMs: 5000 })
  h.speaker.speak('x', VOICE)
  await tick()
  assert.deepEqual(h.timers.map((t) => t.ms), [5000])
})

async function killWorkers(h, n, stepMs = 0) {
  for (let i = 0; i < n; i++) {
    const p = h.speaker.speak('line ' + i, VOICE)
    await tick()
    await h.child().die(1)
    assert.equal((await peek(p)).status, 'failed')
    h.t += stepMs
  }
}

test('S5 more than 3 respawns within 60 s switch to one-shot mode: one process per line, one line then EOF', async () => {
  const h = harness()
  await killWorkers(h, 4)
  assert.equal(h.spawns.length, 4)
  const p5 = h.speaker.speak('one shot', VOICE)
  await tick()
  assert.equal(h.spawns.length, 5)
  const c5 = h.child()
  assert.equal(c5.input, line(5, 'one shot'))
  assert.equal(c5.ended, true, 'one-shot stdin is closed after the single line')
  await c5.send({ ready: true })
  await c5.send({ id: 5, event: 'start' })
  await c5.send({ id: 5, status: 'done', ms: 9 })
  await c5.die(0)
  assert.deepEqual(await peek(p5), { status: 'done', startMs: 0, ms: 9 })
  const p6 = h.speaker.speak('another', VOICE)
  await tick()
  assert.equal(h.spawns.length, 6)
  assert.equal(h.child().input, line(6, 'another'))
  assert.equal(h.child().ended, true)
  await h.child().send({ id: 6, status: 'done', ms: 3 })
  assert.deepEqual(await peek(p6), { status: 'done', ms: 3 })
})

test('S5 worker deaths spread over more than 60 s keep the persistent worker', async () => {
  const h = harness()
  await killWorkers(h, 4, 61000)
  h.speaker.speak('a', VOICE)
  h.speaker.speak('b', VOICE)
  await tick()
  assert.equal(h.spawns.length, 5)
  assert.equal(h.child().input, line(5, 'a') + line(6, 'b'))
  assert.equal(h.child().ended, false)
})

test('S6 stop() kills the worker, fails its pending line and does not respawn', async () => {
  const h = harness()
  h.speaker.warm()
  const p = h.speaker.speak('x', VOICE)
  await tick()
  const c = h.child()
  h.speaker.stop()
  await tick()
  assert.equal(c.killed, true)
  assert.deepEqual(await peek(p), { status: 'failed', ms: 0 })
  assert.equal(h.spawns.length, 1, 'no respawn after stop()')
})

test('S7 a worker that exits after the line started playing (hotkey cut) resolves cut and is not counted as a death', async () => {
  const h = harness()
  for (let i = 0; i < 5; i++) {
    const p = h.speaker.speak('cut ' + i, VOICE)
    await tick()
    const c = h.child()
    h.t += 100
    await c.send({ id: i + 1, event: 'start' })
    h.t += 400
    await c.die(1)
    assert.deepEqual(await peek(p), { status: 'cut', startMs: 100, ms: 500 }, 'a line cut short is told apart from one played in full (D2)')
  }
  assert.equal(h.logs.some((l) => l.stage === 'worker.one-shot'), false, 'cut lines never force one-shot mode')
  h.speaker.speak('next', VOICE)
  await tick()
  assert.equal(h.child().ended, false, 'still a persistent worker')
})

test('S7 a worker exit before the start event still fails the line', async () => {
  const h = harness()
  const p = h.speaker.speak('x', VOICE)
  await tick()
  h.t += 50
  await h.child().die(1)
  assert.deepEqual(await peek(p), { status: 'failed', ms: 50 })
})

test('S0 speaker.js exports the one frozen voice-flow voice (female, High)', () => {
  assert.deepEqual(speakerModule.VOICE, VOICE)
  assert.ok(Object.isFrozen(speakerModule.VOICE))
})

/** Fires (and removes) the active timer with that duration. */
async function fireTimer(h, ms) {
  const t = h.timers.find((x) => x.ms === ms)
  assert.ok(t, 'an active ' + ms + ' ms timer')
  h.timers = h.timers.filter((x) => x !== t)
  t.fn()
  await tick()
}

test('S8 the request timeout covers only the wait for playback; on start it re-arms with the WAV duration + 5 s', async () => {
  const h = harness()
  const p = h.speaker.speak('a very long read-back', VOICE)
  await tick()
  const c = h.child()
  assert.deepEqual(h.timers.map((t) => t.ms), [45000])
  h.t += 40000
  await c.send({ id: 1, event: 'start', durationMs: 32000 })
  assert.deepEqual(h.timers.map((t) => t.ms), [37000], 'the pre-start timer is replaced by the playback budget')
  h.t += 33000 // 73 s after the line was sent: past the old 45 s limit, still playing
  assert.equal(await peek(p), 'pending')
  assert.equal(c.killed, false)
  await c.send({ id: 1, status: 'done', ms: 73000 })
  assert.deepEqual(await peek(p), { status: 'done', startMs: 40000, ms: 73000 })
  assert.deepEqual(h.timers, [])
})

test('S8 playback that overruns its budget times out and kills the worker', async () => {
  const h = harness()
  const p = h.speaker.speak('x', VOICE)
  await tick()
  await h.child().send({ id: 1, event: 'start', durationMs: 2000 })
  h.t += 7000
  await fireTimer(h, 7000)
  assert.deepEqual(await peek(p), { status: 'timeout', ms: 7000 })
  assert.equal(h.child().killed, true)
})

test('S8 a start event without durationMs gets the generous fallback playback budget', async () => {
  const h = harness()
  h.speaker.speak('x', VOICE)
  await tick()
  await h.child().send({ id: 1, event: 'start' })
  assert.deepEqual(h.timers.map((t) => t.ms), [120000])
})

test('S8 a queued line starts its wait timer only when the line ahead of it has finished', async () => {
  const h = harness()
  const p1 = h.speaker.speak('one', VOICE)
  const p2 = h.speaker.speak('two', VOICE)
  await tick()
  const c = h.child()
  assert.deepEqual(h.timers.map((t) => t.ms), [45000], 'only the head line waits on a timer')
  await c.send({ id: 1, event: 'start', durationMs: 50000 })
  assert.deepEqual(h.timers.map((t) => t.ms), [55000])
  h.t += 50000
  await c.send({ id: 1, status: 'done', ms: 50000 })
  assert.deepEqual(await peek(p1), { status: 'done', startMs: 0, ms: 50000 })
  assert.deepEqual(h.timers.map((t) => t.ms), [45000], 'the next line now waits for its own start')
  assert.equal(await peek(p2), 'pending')
})

test('S9 a worker killed mid-line (timeout) has its leftover priority flag removed once it exited', async () => {
  const h = harness({ env: { DSH_TTS_STATE_DIR: 'SD' } })
  h.speaker.speak('x', VOICE)
  await tick()
  h.t += 45000
  await fireTimer(h, 45000)
  assert.deepEqual(h.unlinks, [join('SD', 'tts-priority-pending.flag')])
})

test('S9 stop() during a line removes the priority flag; stop() of an idle worker leaves it alone', async () => {
  const h = harness({ env: { DSH_TTS_STATE_DIR: 'SD' } })
  h.speaker.warm()
  h.speaker.stop()
  await tick()
  assert.deepEqual(h.unlinks, [], 'an idle worker owns no flag')
  h.speaker.speak('x', VOICE)
  await tick()
  h.speaker.stop()
  await tick()
  assert.deepEqual(h.unlinks, [join('SD', 'tts-priority-pending.flag')])
})

test('S9 a failing unlink never breaks the speaker', async () => {
  const h = harness({ env: { DSH_TTS_STATE_DIR: 'SD' }, unlink: () => { throw new Error('ENOENT') } })
  const p = h.speaker.speak('x', VOICE)
  await tick()
  h.speaker.stop()
  await tick()
  assert.deepEqual(await peek(p), { status: 'failed', ms: 0 })
  const h2 = harness({ env: { DSH_TTS_STATE_DIR: 'SD' }, unlink: async () => { throw new Error('EBUSY') } })
  h2.speaker.speak('x', VOICE)
  await tick()
  h2.speaker.stop()
  await tick()
})

test('S6 stop() without a worker is a no-op', () => {
  const h = harness()
  assert.doesNotThrow(() => h.speaker.stop())
  assert.equal(h.spawns.length, 0)
})

// --- cancel(): a barge-in must silence what the worker still has to say (finding: stale lines played into the open mic).
// Shapes chosen: requests stay written at once (S1/S2), so queued lines cannot be recalled from stdin. cancel() therefore
// (1) resolves every queued line (not the head, which is in flight in the worker) { status: 'cancelled' } at once,
// (2) writes <state dir>\tts-voice-cancel.json {"before": <next request id>} - the worker answers every line it has not
//     begun with an id below that as 'cancelled' without speaking - and then
// (3) writes <state dir>\tts-stop.flag, which Invoke-KokoroTts polls to cut the line in flight.
// It writes nothing when no line is outstanding (the flag would cut an unrelated hook read-out) and never kills the worker.
// One marker per worker process (named after the worker's PID): two DSH hosts share the state dir and their request ids
// both restart at 1, so a shared marker would cancel the other host's lines.
const CANCEL = (child) => join('SD', 'tts-voice-cancel-' + child.pid + '.json')
const STOP = join('SD', 'tts-stop.flag')

test('S10 cancel() resolves queued lines cancelled at once, leaves the line in flight, then writes the cancel marker and the stop flag', async () => {
  const h = harness({ env: { DSH_TTS_STATE_DIR: 'SD' } })
  const p1 = h.speaker.speak('in flight', VOICE)
  const p2 = h.speaker.speak('queued one', VOICE)
  const p3 = h.speaker.speak('queued two', VOICE)
  await tick()
  const c = h.child()
  h.t += 70
  h.speaker.cancel()
  assert.deepEqual(await peek(p2), { status: 'cancelled', ms: 70 })
  assert.deepEqual(await peek(p3), { status: 'cancelled', ms: 70 })
  assert.equal(await peek(p1), 'pending', 'the head line is already in the worker; the flag cuts it, its own status resolves it')
  assert.deepEqual(h.writes.map(([p]) => p), [CANCEL(c), STOP], 'marker first, so a following queued line is skipped, then the cut')
  assert.deepEqual(JSON.parse(h.writes[0][1]), { before: 4 })
  assert.equal(c.killed, false, 'the worker survives a cancel')
  await c.send({ id: 1, status: 'done', ms: 30 })
  assert.deepEqual(await peek(p1), { status: 'done', ms: 30 })
  const p4 = h.speaker.speak('after the cancel', VOICE)
  await tick()
  assert.equal(c.input, line(1, 'in flight') + line(2, 'queued one') + line(3, 'queued two') + line(4, 'after the cancel'))
  assert.equal(h.spawns.length, 1)
  await c.send({ id: 4, status: 'done', ms: 5 })
  assert.deepEqual(await peek(p4), { status: 'done', ms: 5 })
})

test('S10 cancel() leaves a started line alone but still cancels the lines queued behind it', async () => {
  const h = harness({ env: { DSH_TTS_STATE_DIR: 'SD' } })
  const p1 = h.speaker.speak('playing', VOICE)
  const p2 = h.speaker.speak('queued', VOICE)
  await tick()
  await h.child().send({ id: 1, event: 'start', durationMs: 4000 })
  h.speaker.cancel()
  assert.equal((await peek(p2)).status, 'cancelled')
  assert.equal(await peek(p1), 'pending')
  assert.deepEqual(h.timers.map((t) => t.ms), [9000], 'the started line keeps its playback timer')
  assert.deepEqual(h.writes.map(([p]) => p), [CANCEL(h.child()), STOP])
})

test('S10 cancel() with nothing outstanding writes nothing (an idle speaker must not cut another process)', async () => {
  const h = harness({ env: { DSH_TTS_STATE_DIR: 'SD' } })
  assert.doesNotThrow(() => h.speaker.cancel())
  h.speaker.warm()
  h.speaker.cancel()
  const p = h.speaker.speak('x', VOICE)
  await tick()
  await h.child().send({ id: 1, status: 'done', ms: 1 })
  await peek(p)
  h.speaker.cancel()
  assert.deepEqual(h.writes, [])
  assert.equal(h.spawns.length, 1)
})

test('S10 the state dir of the cancel files follows DSH_TTS_STATE_DIR, else TEMP\\dsh-tts', async () => {
  const h = harness({ env: { TEMP: 'T' } })
  h.speaker.speak('x', VOICE)
  await tick()
  h.speaker.cancel()
  assert.deepEqual(h.writes.map(([p]) => p), [join('T', 'dsh-tts', 'tts-voice-cancel-' + h.child().pid + '.json'), join('T', 'dsh-tts', 'tts-stop.flag')])
})

test('S10 a failing or rejecting writeFile never breaks cancel()', async () => {
  const h = harness({ env: { DSH_TTS_STATE_DIR: 'SD' }, writeFile: () => { throw new Error('EPERM') } })
  h.speaker.speak('a', VOICE)
  const q = h.speaker.speak('b', VOICE)
  await tick()
  assert.doesNotThrow(() => h.speaker.cancel())
  assert.equal((await peek(q)).status, 'cancelled')
  const g = harness({ env: { DSH_TTS_STATE_DIR: 'SD' }, writeFile: async () => { throw new Error('EBUSY') } })
  g.speaker.speak('a', VOICE)
  await tick()
  assert.doesNotThrow(() => g.speaker.cancel())
  await tick()
})

test('S10 a cancelled status from the worker (it skipped the line) resolves the line cancelled', async () => {
  const h = harness()
  const p = h.speaker.speak('x', VOICE)
  await tick()
  await h.child().send({ id: 1, status: 'cancelled', ms: 2 })
  assert.deepEqual(await peek(p), { status: 'cancelled', ms: 2 })
})

test('S11 a worker status cut (the stop flag ended the line early) resolves the line cut', async () => {
  const h = harness()
  const p = h.speaker.speak('x', VOICE)
  await tick()
  await h.child().send({ id: 1, event: 'start', durationMs: 4000 })
  await h.child().send({ id: 1, status: 'cut', ms: 900 })
  assert.deepEqual(await peek(p), { status: 'cut', startMs: 0, ms: 900 })
})

test('S12 every worker gets its own cancel marker named after its PID; each is removed once its worker exited', async () => {
  const h = harness({ env: { DSH_TTS_STATE_DIR: 'SD' }, maxRespawns: 0 })
  h.speaker.speak('a', VOICE)
  await tick()
  const first = h.child()
  h.speaker.cancel()
  assert.deepEqual(h.writes.map(([p]) => p), [CANCEL(first), STOP])
  await first.die(1) // unexpected exit: a respawn follows (and one-shot mode with maxRespawns 0)
  await tick()
  assert.ok(h.unlinks.includes(CANCEL(first)), 'the dead worker\'s marker is removed')
  h.speaker.speak('b', VOICE)
  await tick()
  const second = h.child()
  assert.notEqual(second.pid, first.pid)
  h.writes.length = 0
  h.speaker.cancel()
  assert.deepEqual(h.writes.map(([p]) => p), [CANCEL(second), STOP], 'the next worker never reuses the previous marker')
})

test('S12 no marker is written for a worker that has nothing outstanding, and none is removed for it', async () => {
  const h = harness({ env: { DSH_TTS_STATE_DIR: 'SD' } })
  h.speaker.warm()
  const c = h.child()
  await c.die(1)
  assert.deepEqual(h.unlinks, [])
  assert.deepEqual(h.writes, [])
})
