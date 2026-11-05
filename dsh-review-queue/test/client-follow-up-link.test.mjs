import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './client-todo-helpers.mjs'

// The follow-up card says who sent it and how it will arrive (session link): desktop (todoLine, todoSendLabel) and phone (todoCardModel).
const { mod } = loadClient()
const core = mod.shared
const plain = (x) => JSON.parse(JSON.stringify(x))
const fu = (over = {}) => ({ id: 'f1', type: 'todo', kind: 'followup', text: 'hi', query: 'engine', state: 'awaiting-confirm', status: 'open', candidates: [{ sessionId: 's1', title: 'One' }], suggested: { sessionId: 's1', title: 'One' }, ...over })
const LINKED = { source: { sessionId: 'me', title: 'Me' }, mode: 'steer' }
const model = () => import('../lib/mobile/model.js')

test('desktop line names the sender and the steer mode after the original sentence', () => {
  const plainLine = core.todoLine(fu(), undefined, [])
  const line = core.todoLine(fu(LINKED), undefined, [])
  assert.ok(line.startsWith(plainLine))
  assert.ok(line.includes('From session Me (me)'))
  assert.ok(line.includes('Will be inserted into the running turn'))
  assert.ok(line.includes(plainLine + ' — '))
})
test('a sender without a title shows its session id; no steer means no steer sentence', () => {
  const line = core.todoLine(fu({ source: { sessionId: 'abc-1' } }), undefined, [])
  assert.ok(line.includes('From session abc-1'))
  assert.ok(!line.includes('Will be inserted'))
})
test('a card without source or mode is unchanged', () => {
  const line = core.todoLine(fu(), undefined, [])
  assert.ok(!line.includes('From session'))
  assert.ok(!line.includes('Will be inserted'))
})
test('desktop Send button label', () => {
  assert.equal(core.todoSendLabel(fu(LINKED)), 'Send (steer)')
  assert.equal(core.todoSendLabel(fu()), 'Send')
  assert.equal(core.todoSendLabel(fu({ ...LINKED, state: 'failed', status: 'open', error: 'x' })), 'Retry')
})
test('phone card model: startLabel, sourceLine and modeLine', async () => {
  const m = plain((await model()).todoCardModel(core, fu(LINKED), []))
  assert.equal(m.startLabel, 'Send (steer)')
  assert.equal(m.sourceLine, 'From session Me (me)')
  assert.equal(m.modeLine, 'Will be inserted into the running turn')
  const q = plain((await model()).todoCardModel(core, fu(), []))
  assert.equal(q.startLabel, 'Send')
  assert.equal(q.sourceLine, '')
  assert.equal(q.modeLine, '')
  const failed = plain((await model()).todoCardModel(core, fu({ ...LINKED, state: 'failed', error: 'x' }), []))
  assert.equal(failed.startLabel, 'Retry')
})
