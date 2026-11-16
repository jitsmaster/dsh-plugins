// Group card redesign: a question that absorbed repeats says so on its card.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './client-todo-helpers.mjs'

const el = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })
const { T } = loadClient({ react: { createElement: el } })

test('mergedNote says how many repeats a question absorbed', () => {
  assert.equal(T.mergedNote({ merged: { count: 3 } }), 'Merged 3 similar questions')
  assert.equal(T.mergedNote({ merged: { count: 2 } }), 'Merged 2 similar questions')
})

test('no merge, or a bad count, gives no note', () => {
  assert.equal(T.mergedNote({}), undefined)
  assert.equal(T.mergedNote({ merged: { count: 1 } }), undefined)
  assert.equal(T.mergedNote({ merged: { count: 'x' } }), undefined)
  assert.equal(T.mergedNote(undefined), undefined)
})

test('a done card says messages, not questions', () => {
  assert.equal(T.mergedNote({ type: 'completed', merged: { count: 2 } }), 'Merged 2 similar messages')
})
