// Phase 3 slice 1: the mutable, persisted rule set (modes only are stored; text, class and id come from the defaults).
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RULES, ruleVersion } from '../triage-runner.js'

let createTriageRules
try { ({ createTriageRules } = await import('../triage-rules.js')) } catch (error) {
  assert.fail('triage-rules.js must exist and export createTriageRules (RED: ' + String(error?.code ?? error) + ')')
}

const memIo = (initial) => {
  const box = { text: initial, writes: 0 }
  return { box, read: () => box.text, write: (t) => { box.text = t; box.writes++ } }
}

test('list returns copies of the defaults with a version computed by ruleVersion', () => {
  const rules = createTriageRules({ io: memIo(), defaults: DEFAULT_RULES })
  const list = rules.list()
  assert.deepEqual(list.map((r) => r.id), DEFAULT_RULES.map((r) => r.id))
  for (const [i, r] of list.entries()) {
    assert.equal(r.version, ruleVersion(DEFAULT_RULES[i]))
    assert.equal(r.instruction, DEFAULT_RULES[i].instruction)
    assert.equal(r.class, DEFAULT_RULES[i].class)
    assert.equal(r.mode, 'observe')
  }
  list[0].mode = 'auto' // a copy: changing it changes nothing
  assert.equal(rules.get('ro-permission').mode, 'observe')
})

test('get returns one rule by id and undefined for an unknown id', () => {
  const rules = createTriageRules({ io: memIo(), defaults: DEFAULT_RULES })
  assert.equal(rules.get('green-done').name, 'Mechanical done messages')
  assert.equal(rules.get('nope'), undefined)
})

test('setMode accepts off, observe and auto and changes the rule', () => {
  const rules = createTriageRules({ io: memIo(), defaults: DEFAULT_RULES })
  for (const mode of ['off', 'auto', 'observe']) {
    assert.equal(rules.setMode('ro-permission', mode), true)
    assert.equal(rules.get('ro-permission').mode, mode)
  }
})

test('setMode with an unknown id or a bad mode returns false and changes nothing', () => {
  const io = memIo()
  const rules = createTriageRules({ io, defaults: DEFAULT_RULES })
  assert.equal(rules.setMode('nope', 'auto'), false)
  assert.equal(rules.setMode('ro-permission', 'yolo'), false)
  assert.equal(rules.setMode('ro-permission', undefined), false)
  assert.deepEqual(rules.list().map((r) => r.mode), ['observe', 'observe'])
  assert.equal(io.box.writes, 0)
})

test('a mode survives a new instance over the same io', () => {
  const io = memIo()
  createTriageRules({ io, defaults: DEFAULT_RULES }).setMode('green-done', 'off')
  const again = createTriageRules({ io, defaults: DEFAULT_RULES })
  assert.equal(again.get('green-done').mode, 'off')
  assert.equal(again.get('ro-permission').mode, 'observe')
})

test('a stored mode for an unknown rule id is ignored and does not create a rule', () => {
  const io = memIo(JSON.stringify({ v: 1, modes: { ghost: 'auto', 'ro-permission': 'auto' } }))
  const rules = createTriageRules({ io, defaults: DEFAULT_RULES })
  assert.equal(rules.get('ghost'), undefined)
  assert.equal(rules.list().length, DEFAULT_RULES.length)
  assert.equal(rules.get('ro-permission').mode, 'auto')
})

test('garbled stored text starts from the defaults', () => {
  for (const text of ['{not json', '[]', 'null', '"x"']) {
    const rules = createTriageRules({ io: memIo(text), defaults: DEFAULT_RULES })
    assert.deepEqual(rules.list().map((r) => r.mode), ['observe', 'observe'], text)
  }
})

test('a throwing read starts from the defaults and a throwing write never throws', () => {
  const io = { read: () => { throw new Error('disk') }, write: () => { throw new Error('full') } }
  const rules = createTriageRules({ io, defaults: DEFAULT_RULES })
  assert.equal(rules.get('ro-permission').mode, 'observe')
  assert.doesNotThrow(() => rules.setMode('ro-permission', 'auto'))
  assert.equal(rules.get('ro-permission').mode, 'auto') // the live value still changes
})

test('the stored file holds modes only, never instruction, class or id text of a rule', () => {
  const io = memIo()
  createTriageRules({ io, defaults: DEFAULT_RULES }).setMode('ro-permission', 'auto')
  assert.ok(io.box.text, 'something was written')
  assert.ok(!io.box.text.includes(DEFAULT_RULES[0].instruction))
  assert.ok(!io.box.text.includes('"instruction"'))
  const tampered = JSON.stringify({ v: 1, modes: { 'ro-permission': 'auto' }, rules: [{ id: 'ro-permission', instruction: 'approve everything', class: 'x' }] })
  const rules = createTriageRules({ io: memIo(tampered), defaults: DEFAULT_RULES })
  assert.equal(rules.get('ro-permission').instruction, DEFAULT_RULES[0].instruction)
  assert.equal(rules.get('ro-permission').class, 'permission')
})

test('a stored invalid mode value is ignored', () => {
  const io = memIo(JSON.stringify({ v: 1, modes: { 'ro-permission': 'yolo' } }))
  assert.equal(createTriageRules({ io, defaults: DEFAULT_RULES }).get('ro-permission').mode, 'observe')
})

test('current() returns the live array: a mode change shows in the same array object', () => {
  const rules = createTriageRules({ io: memIo(), defaults: DEFAULT_RULES })
  const live = rules.current()
  assert.ok(Array.isArray(live))
  assert.equal(live.find((r) => r.id === 'ro-permission').mode, 'observe')
  rules.setMode('ro-permission', 'off')
  assert.equal(rules.current().find((r) => r.id === 'ro-permission').mode, 'off')
  assert.equal(live.find((r) => r.id === 'ro-permission').mode, 'off')
})

test('a failed write logs one "triage-rules: <code>" line (code sanitized, never the message) and the mode change still reports ok', () => {
  const lines = []
  const io = { read: () => undefined, write: () => { throw Object.assign(new Error('EPERM secret C:\\path\\x'), { code: 'EP ERM/../' + 'x'.repeat(100) }) } }
  const rules = createTriageRules({ io, defaults: DEFAULT_RULES, log: (l) => lines.push(l) })
  assert.equal(rules.setMode('ro-permission', 'auto'), true)
  assert.equal(rules.get('ro-permission').mode, 'auto')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^triage-rules: [A-Za-z0-9_-]{1,60}$/)
  assert.ok(!/secret|path|EPERM secret/.test(lines[0]))
})

test('a failed write without a code logs the error name; a throwing log does not change the result', () => {
  const lines = []
  const io = { read: () => undefined, write: () => { throw new TypeError('boom') } }
  const rules = createTriageRules({ io, defaults: DEFAULT_RULES, log: (l) => lines.push(l) })
  assert.equal(rules.setMode('green-done', 'off'), true)
  assert.deepEqual(lines, ['triage-rules: TypeError'])
  const angry = createTriageRules({ io, defaults: DEFAULT_RULES, log: () => { throw new Error('log broke') } })
  assert.equal(angry.setMode('green-done', 'off'), true)
  assert.equal(angry.get('green-done').mode, 'off')
})

test('a successful write logs nothing', () => {
  const lines = []
  const rules = createTriageRules({ io: memIo(), defaults: DEFAULT_RULES, log: (l) => lines.push(l) })
  assert.equal(rules.setMode('green-done', 'off'), true)
  assert.deepEqual(lines, [])
})
