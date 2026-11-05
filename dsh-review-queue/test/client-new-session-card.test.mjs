import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './client-todo-helpers.mjs'

const { mod } = loadClient()
const core = mod.shared
const plain = (x) => JSON.parse(JSON.stringify(x))
const model = () => import('../lib/mobile/model.js')
const WS = [{ id: 'w1', title: 'Alpha' }, { id: 'w2', title: 'Beta' }]
const todo = (over = {}) => ({ id: 't1', type: 'todo', text: 'Do it', state: 'awaiting-confirm', status: 'open', suggested: { workspaceId: 'w1', title: 'Alpha', reason: 'asked for' }, source: { sessionId: 'me', title: 'Me' }, ...over })

test('desktop: a waiting new-session card says who requested it, keeps the suggested workspace and Start', () => {
  const item = todo()
  const line = core.todoLine(item, undefined, WS)
  assert.ok(line.startsWith('Start in Alpha — asked for'))
  assert.ok(line.includes('Requested by session Me (me)'))
  assert.ok(!line.includes('From session'))
  assert.equal(core.todoTarget(item, undefined), 'w1')
  assert.equal(core.todoSendLabel(item), 'Send')
})
test('desktop: a sender without a title shows its id; a plain todo without source is unchanged', () => {
  assert.ok(core.todoLine(todo({ source: { sessionId: 'abc-1' } }), undefined, WS).includes('Requested by session abc-1'))
  assert.equal(core.todoLine(todo({ source: undefined }), undefined, WS), 'Start in Alpha — asked for')
})
test('phone: sourceLine reads Requested by for a plain todo and keeps the normal line, Start label and workspace select', async () => {
  const m = plain((await model()).todoCardModel(core, todo(), WS))
  assert.equal(m.sourceLine, 'Requested by session Me (me)')
  assert.equal(m.line, 'Start in Alpha — asked for')
  assert.equal(m.startLabel, 'Start')
  assert.equal(m.selected, 'w1')
  assert.equal(m.canStart, true)
})
test('phone: a follow-up still reads From session; a plain todo without source has no source line', async () => {
  const fu = { id: 'f', type: 'todo', kind: 'followup', text: 'x', state: 'awaiting-confirm', status: 'open', candidates: [], source: { sessionId: 'me', title: 'Me' } }
  assert.equal(plain((await model()).todoCardModel(core, fu, [])).sourceLine, 'From session Me (me)')
  assert.equal(plain((await model()).todoCardModel(core, todo({ source: undefined }), WS)).sourceLine, '')
})
test('the sender title is followed by the first 8 characters of its session id, on desktop and phone', async () => {
  const source = { sessionId: '0123456789abcdef', title: 'Planner' }
  assert.ok(core.todoLine(todo({ source }), undefined, WS).includes('Requested by session Planner (01234567)'))
  assert.equal(plain((await model()).todoCardModel(core, todo({ source }), WS)).sourceLine, 'Requested by session Planner (01234567)')
  const fu = { id: 'f', type: 'todo', kind: 'followup', text: 'x', state: 'awaiting-confirm', status: 'open', candidates: [], source }
  assert.ok(core.todoLine(fu, undefined, []).includes('From session Planner (01234567)'))
  assert.equal(plain((await model()).todoCardModel(core, fu, [])).sourceLine, 'From session Planner (01234567)')
})
test('an empty or blank title shows the full session id only', async () => {
  const source = { sessionId: '0123456789abcdef', title: '' }
  assert.ok(core.todoLine(todo({ source }), undefined, WS).endsWith('Requested by session 0123456789abcdef'))
  assert.equal(plain((await model()).todoCardModel(core, todo({ source }), WS)).sourceLine, 'Requested by session 0123456789abcdef')
})
