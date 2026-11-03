// Slice 5 of the AI triage plan (RED): the pure helpers of the desktop "AI rules" view, exported through exports.shared and exports.__test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient, el } from './client-todo-helpers.mjs'

const { T, mod } = loadClient({ react: { createElement: el } })
const need = (name) => assert.equal(typeof T[name], 'function', name + ' is exported through exports.__test')
const LAST = Date.UTC(2026, 9, 31, 23, 30)

test('recordText: "agreed A of T" for a record, "no record yet" when empty', () => {
  need('recordText')
  assert.equal(T.recordText({ agreed: 18, overruled: 2 }), 'agreed 18 of 20')
  assert.equal(T.recordText({ agreed: 0, overruled: 3 }), 'agreed 0 of 3')
  assert.equal(T.recordText({ agreed: 0, overruled: 0 }), 'no record yet')
})

test('recordText: missing or non-numeric parts count as no record; negative and NaN count as 0', () => {
  need('recordText')
  for (const bad of [undefined, null, 'x', 5, {}, { agreed: 'a', overruled: 'b' }, { agreed: NaN, overruled: NaN }, { agreed: -3, overruled: -1 }]) {
    assert.equal(T.recordText(bad), 'no record yet', JSON.stringify(bad))
  }
  assert.equal(T.recordText({ agreed: -5, overruled: 4 }), 'agreed 0 of 4')
  assert.equal(T.recordText({ agreed: NaN, overruled: 2 }), 'agreed 0 of 2')
})

const rule = (mode, current, older = { agreed: 0, overruled: 0 }) => ({ id: 'r1', mode, record: { current, older } })

test('promotionHint: a suggestion for an observe rule whose current record is good (>= 10 judged, >= 90% agreed)', () => {
  need('promotionHint')
  const hint = T.promotionHint(rule('observe', { agreed: 18, overruled: 2 }))
  assert.equal(typeof hint, 'string')
  assert.match(hint, /Record is good: you could try auto/)
  assert.equal(typeof T.promotionHint(rule('observe', { agreed: 9, overruled: 1 })), 'string', 'exactly 10 and exactly 90% qualify')
})

test('promotionHint: nothing below 10 judged or below 90%', () => {
  need('promotionHint')
  assert.equal(T.promotionHint(rule('observe', { agreed: 9, overruled: 0 })), undefined, '9 judged is too few')
  assert.equal(T.promotionHint(rule('observe', { agreed: 17, overruled: 3 })), undefined, '85%')
  assert.equal(T.promotionHint(rule('observe', { agreed: 0, overruled: 0 })), undefined)
})

test('promotionHint: never for auto or off, never from the older record, never from garbage', () => {
  need('promotionHint')
  const good = { agreed: 20, overruled: 0 }
  assert.equal(T.promotionHint(rule('auto', good)), undefined)
  assert.equal(T.promotionHint(rule('off', good)), undefined)
  assert.equal(T.promotionHint(rule('observe', { agreed: 0, overruled: 0 }, good)), undefined, 'the older record does not count')
  assert.equal(T.promotionHint(rule('observe', { agreed: 1, overruled: 5 }, good)), undefined)
  for (const bad of [undefined, null, {}, { mode: 'observe' }, { mode: 'observe', record: {} }, { mode: 'observe', record: { current: 'x' } }]) {
    assert.doesNotThrow(() => T.promotionHint(bad))
    assert.equal(T.promotionHint(bad), undefined)
  }
})

test('ruleModeLabel: Off / Observe (note only) / Auto; unknown is Off', () => {
  need('ruleModeLabel')
  assert.equal(T.ruleModeLabel('off'), 'Off')
  assert.equal(T.ruleModeLabel('observe'), 'Observe (note only)')
  assert.equal(T.ruleModeLabel('auto'), 'Auto')
  for (const x of ['nope', undefined, null, 3, '']) assert.equal(T.ruleModeLabel(x), 'Off')
})

test('lessonLine: "<title> (overruled N times, last YYYY-MM-DD)" with the UTC date', () => {
  need('lessonLine')
  assert.equal(T.lessonLine({ title: 'Do not auto-run rm', count: 3, lastAt: LAST }), 'Do not auto-run rm (overruled 3 times, last 2026-10-31)')
})

test('lessonLine: a count of 1 says "overruled once"; a missing lastAt omits the date', () => {
  need('lessonLine')
  assert.equal(T.lessonLine({ title: 'T', count: 1, lastAt: LAST }), 'T (overruled once, last 2026-10-31)')
  assert.equal(T.lessonLine({ title: 'T', count: 2 }), 'T (overruled 2 times)')
  assert.equal(T.lessonLine({ title: 'T', count: 1 }), 'T (overruled once)')
})

test('lessonLine: a non-string title is "Untitled lesson"; garbage does not throw', () => {
  need('lessonLine')
  assert.match(T.lessonLine({ title: 5, count: 2, lastAt: LAST }), /^Untitled lesson \(overruled 2 times/)
  assert.match(T.lessonLine({ count: 2 }), /^Untitled lesson/)
  for (const bad of [undefined, null, 'x']) { assert.doesNotThrow(() => T.lessonLine(bad)); assert.match(T.lessonLine(bad), /^Untitled lesson/) }
})

test('the helpers are also in exports.shared (the phone will reuse them)', () => {
  for (const name of ['recordText', 'promotionHint', 'ruleModeLabel', 'lessonLine']) assert.equal(typeof mod.shared[name], 'function', name + ' in exports.shared')
})
