import assert from 'node:assert/strict'
import test from 'node:test'
import { COMMANDS, describeMatch, makeMatch, matchCommand, parseNumber, resolveConfirmation, resolveSession } from '../voice/commands.js'

const id = (text) => matchCommand(text)?.id

test('every registry entry has an id, an action, and English and Chinese phrases', () => {
  const ids = new Set()
  for (const c of COMMANDS) {
    assert.ok(c.id && c.action, c.id)
    assert.ok(!ids.has(c.id), 'duplicate ' + c.id)
    ids.add(c.id)
    assert.ok(c.en.length > 0 && c.zh.length > 0, c.id + ' needs both languages')
  }
})

test('plain commands match in English and Chinese, ignoring case and punctuation', () => {
  assert.equal(id('Stop.'), 'cancel')
  assert.equal(id('停止'), 'cancel')
  assert.equal(id('Approve!'), 'approve')
  assert.equal(id('批准'), 'approve')
  assert.equal(id('deny'), 'deny')
  assert.equal(id('拒绝'), 'deny')
  assert.equal(id('new session'), 'session-new')
  assert.equal(id('新会话'), 'session-new')
  assert.equal(id('compact'), 'compact')
  assert.equal(id('export'), 'export')
})

test('known recognizer misses still match: denied/denies -> deny', () => {
  assert.equal(id('denied'), 'deny')
  assert.equal(id('Denies'), 'deny')
})

test('light fuzzy matching tolerates one wrong letter in longer words only', () => {
  assert.equal(id('aprove'), 'approve')
  assert.equal(id('cancle'), 'cancel')
  assert.equal(id('no'), 'deny')
  assert.equal(id('nu'), undefined)
})

test('extra words make it dictation, not a command', () => {
  assert.equal(matchCommand('stop using callbacks in this module'), undefined)
  assert.equal(matchCommand('please approve the new design doc'), undefined)
  assert.equal(matchCommand(''), undefined)
  assert.equal(matchCommand('   '), undefined)
})

test('commands with a free-text argument capture it', () => {
  assert.deepEqual(matchCommand('goal ship the voice client'), { ...matchCommand('goal ship the voice client'), id: 'goal', args: { text: 'ship the voice client' } })
  assert.equal(matchCommand('rename session to Voice Work').args.text, 'Voice Work')
  assert.equal(matchCommand('feedback this was great').args.text, 'this was great')
  assert.equal(matchCommand('目标 完成语音客户端').args.text, '完成语音客户端')
})

test('a bare argument command without its argument is not a match', () => {
  assert.equal(matchCommand('goal'), undefined)
  assert.equal(matchCommand('rename session'), undefined)
})

test('permission presets and plan mode', () => {
  assert.equal(matchCommand('permission full access').args.preset, 'danger-full-access')
  assert.equal(matchCommand('permission workspace write').args.preset, 'workspace-write')
  assert.equal(id('plan mode'), 'plan')
  assert.equal(id('leave plan mode'), 'plan')
})

test('destructive commands require confirmation', () => {
  assert.equal(matchCommand('permission full access').confirm, true)
  assert.equal(matchCommand('approve').confirm, undefined)
  assert.equal(matchCommand('new session').confirm, undefined)
  assert.equal(matchCommand('fork session').confirm, true)
})

test('option selection takes spoken and digit numbers', () => {
  assert.equal(matchCommand('option two').args.number, 2)
  assert.equal(matchCommand('choose 3').args.number, 3)
  assert.equal(matchCommand('选项二').args.number, 2)
  assert.equal(matchCommand('选择 三').args.number, 3)
})

test('parseNumber handles digits, English words and Chinese numerals', () => {
  assert.equal(parseNumber('7'), 7)
  assert.equal(parseNumber('ten'), 10)
  assert.equal(parseNumber('too'), 2)
  assert.equal(parseNumber('for'), 4)
  assert.equal(parseNumber('十'), 10)
  assert.equal(parseNumber('两'), 2)
  assert.equal(parseNumber('banana'), undefined)
})

test('a trailing target clause is split off and kept as the raw session name', () => {
  assert.deepEqual(matchCommand('approve in voice work').target, 'voice work')
  assert.equal(matchCommand('stop on the tts session').target, 'tts session')
  assert.equal(matchCommand('在语音会话 批准').target, '语音会话')
  assert.equal(matchCommand('approve').target, undefined)
})

test('switch session takes its name as the target', () => {
  const m = matchCommand('switch to voice work')
  assert.equal(m.id, 'session-switch')
  assert.equal(m.args.text, 'voice work')
  assert.equal(matchCommand('切换到语音').args.text, '语音')
})

test('resolveConfirmation reads yes/no, including recognizer variants', () => {
  assert.equal(resolveConfirmation('yes'), 'yes')
  assert.equal(resolveConfirmation('Confirm.'), 'yes')
  assert.equal(resolveConfirmation('确认'), 'yes')
  assert.equal(resolveConfirmation('no'), 'no')
  assert.equal(resolveConfirmation('denied'), 'no')
  assert.equal(resolveConfirmation('cancel'), 'no')
  assert.equal(resolveConfirmation('取消'), 'no')
  assert.equal(resolveConfirmation('maybe later'), undefined)
})

test('resolveSession: named partial match, else the last alerted session', () => {
  const sessions = [
    { id: 'a', title: 'Voice Work' },
    { id: 'b', title: 'TTS hooks cleanup' },
    { id: 'c', title: 'Voice Control Design' },
  ]
  assert.equal(resolveSession('tts', sessions, 'a').id, 'b')
  assert.equal(resolveSession('voice work', sessions, 'b').id, 'a')
  assert.equal(resolveSession(undefined, sessions, 'b').id, 'b')
  assert.equal(resolveSession('hooks cleanup', sessions, 'a').id, 'b')
  assert.equal(resolveSession('nothing like it', sessions, 'a'), undefined)
  assert.equal(resolveSession(undefined, sessions, 'zzz'), undefined)
})

test('resolveSession: an ambiguous name returns every candidate instead of guessing', () => {
  const sessions = [{ id: 'a', title: 'Voice Work' }, { id: 'c', title: 'Voice Control Design' }]
  const r = resolveSession('voice', sessions, 'a')
  assert.equal(r.ambiguous.length, 2)
})

test('makeMatch builds the same shape matchCommand returns', () => {
  assert.deepEqual(makeMatch('cancel', {}, 'voice work'), matchCommand('stop in voice work'))
  assert.deepEqual(makeMatch('goal', { text: 'ship it' }), matchCommand('goal ship it'))
  assert.deepEqual(makeMatch('permission', { preset: 'danger-full-access' }), matchCommand('permission full access'))
  assert.deepEqual(makeMatch('option', { number: 2 }), matchCommand('option two'))
})

test('makeMatch rejects unknown ids and missing or bad arguments', () => {
  assert.equal(makeMatch('format-disk'), undefined)
  assert.equal(makeMatch('goal', {}), undefined)
  assert.equal(makeMatch('goal', { text: '  ' }), undefined)
  assert.equal(makeMatch('option', { number: 0 }), undefined)
  assert.equal(makeMatch('option', { number: 'two' }), undefined)
  assert.equal(makeMatch('permission', { preset: 'root' }), undefined)
})

test('describeMatch gives a short spoken description of what will happen', () => {
  assert.equal(describeMatch(matchCommand('stop'), 'Voice Work'), 'Stopping Voice Work')
  assert.equal(describeMatch(matchCommand('approve'), 'TTS hooks'), 'Approving in TTS hooks')
  assert.equal(describeMatch(matchCommand('option two'), 'A'), 'Choosing option 2 in A')
  assert.equal(describeMatch(matchCommand('new session')), 'Starting a new session')
  assert.equal(describeMatch(matchCommand('goal ship the client'), 'A'), 'Setting the goal in A to: ship the client')
})
