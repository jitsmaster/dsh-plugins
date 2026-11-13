// Slice 1: the overlay list drawn group by group (header above each multi-item session group); flat when the module is not loaded.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './client-todo-helpers.mjs'
import * as ui from '../lib/groups-ui.js'

const el = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })
const { T } = loadClient({ react: { createElement: el } })
const it = (id, groupId, createdAt) => ({ id, groupId, sessionId: groupId, type: 'completed', status: 'open', sessionTitle: 'W', createdAt })
const card = (i) => ({ card: i.id })

test('groupedList puts a header before the cards of each multi-item group, cards oldest first', () => {
  const open = [it('a1', 's1', 1), it('b1', 's2', 2), it('a2', 's1', 3)]
  const out = T.groupedList(ui, open, [], 10, card)
  assert.deepEqual([...out.map((n) => (n.card ? n.card : 'head:' + n.props['data-group']))], ['head:s1', 'a1', 'a2', 'b1'])
})

test('groupOrder flattens in the order the cards are drawn, so j/k and advance follow the screen', () => {
  const open = [it('a1', 's1', 1), it('b1', 's2', 2), it('a2', 's1', 3)]
  assert.deepEqual([...T.groupOrder(ui, open).map((i) => i.id)], ['a1', 'a2', 'b1'])
  assert.deepEqual([...T.groupOrder(undefined, open).map((i) => i.id)], ['a1', 'b1', 'a2'])
})

test('groupedList builds a card model only for multi-item groups and groups the same list once', () => {
  let models = 0
  let groupings = 0
  const spy = { groupCardModel: (...a) => { models++; return ui.groupCardModel(...a) }, groupsOfOpen: (o) => { groupings++; return ui.groupsOfOpen(o) } }
  const open = [it('a1', 's1', 1), it('b1', 's2', 2), it('a2', 's1', 3), it('c1', 's3', 4)]
  const resolved = []
  T.groupedList(spy, open, resolved, 10, card)
  T.groupedList(spy, open, resolved, 11, card)
  assert.equal(models, 1, 'the one multi-item group is modelled once, not per render (same open and resolved lists)')
  assert.equal(groupings, 1, 'the same open list is grouped once')
})

test('groupOrder and groupedList share one grouping pass, and the resolved list is indexed once', () => {
  let groupings = 0
  let indexes = 0
  const spy = { ...ui, groupsOfOpen: (o) => { groupings++; return ui.groupsOfOpen(o) }, indexResolved: (r) => { indexes++; return ui.indexResolved(r) } }
  const open = [it('a1', 's1', 1), it('b1', 's2', 2), it('a2', 's1', 3), it('c1', 's3', 4)]
  const ordered = T.groupOrder(spy, open)
  const resolved = []
  T.groupedList(spy, ordered, resolved, 10, card)
  T.groupedList(spy, ordered, resolved, 11, card)
  assert.equal(groupings, 1)
  assert.equal(indexes, 1)
})

test('without the module, or without items, the list is flat or empty', () => {
  const open = [it('a1', 's1', 1), it('a2', 's1', 3)]
  assert.deepEqual([...T.groupedList(undefined, open, [], 10, card).map((n) => n.card)], ['a1', 'a2'])
  assert.equal(T.groupedList(ui, [], [], 10, card).length, 0)
})
