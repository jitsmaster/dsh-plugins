import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SWIPE_START_PX, SWIPE_COMMIT_PX, SWIPE_MAX_SLOPE, UNDO_MS, isSwipeable, swipeIntent, swipeCommitted, swipeProgress, undoToast } from '../lib/mobile/swipe.js'

// Swipe right on a Waiting row = open the item and press Reviewed (docs/mobile.md "Swipe to review"). Pure rules only; the wiring is in mobile-swipe-wiring.

test('only the cards that have a Reviewed or Keep session button can be swiped: done, archive-ask and PR merged', () => {
  for (const type of ['completed', 'archive', 'pr-merged']) assert.equal(isSwipeable({ type }), true, type)
  for (const type of ['question', 'permission', 'todo', 'paused', 'onhold']) assert.equal(isSwipeable({ type }), false, type)
  assert.equal(isSwipeable(undefined), false)
  assert.equal(isSwipeable(null), false)
})

test('a touch that has barely moved is still pending', () => {
  assert.equal(swipeIntent(0, 0), 'pending')
  assert.equal(swipeIntent(SWIPE_START_PX - 1, 2), 'pending')
  assert.equal(swipeIntent(-(SWIPE_START_PX - 1), 0), 'pending')
})

test('a move that is mostly to the right is a swipe', () => {
  assert.equal(swipeIntent(SWIPE_START_PX + 5, 3), 'swipe')
  assert.equal(swipeIntent(120, 40), 'swipe')
})

test('a move up or down is a scroll, and the row is left alone for the rest of the touch', () => {
  assert.equal(swipeIntent(5, SWIPE_START_PX + 5), 'scroll')
  assert.equal(swipeIntent(30, 60), 'scroll')
})

test('a move to the left is not a swipe (only right reviews)', () => {
  assert.equal(swipeIntent(-100, 2), 'scroll')
})

test('progress goes from 0 to 1 over the commit distance and never leaves that range', () => {
  assert.equal(swipeProgress(0), 0)
  assert.equal(swipeProgress(-50), 0)
  assert.equal(swipeProgress(SWIPE_COMMIT_PX / 2), 0.5)
  assert.equal(swipeProgress(SWIPE_COMMIT_PX), 1)
  assert.equal(swipeProgress(SWIPE_COMMIT_PX * 5), 1)
  assert.equal(swipeProgress(NaN), 0)
})

test('a release commits only when far enough to the right and not too slanted', () => {
  assert.equal(swipeCommitted(SWIPE_COMMIT_PX, 0), true)
  assert.equal(swipeCommitted(SWIPE_COMMIT_PX - 1, 0), false)
  assert.equal(swipeCommitted(SWIPE_COMMIT_PX * 2, SWIPE_COMMIT_PX * 2 * SWIPE_MAX_SLOPE), true)
  assert.equal(swipeCommitted(SWIPE_COMMIT_PX * 2, SWIPE_COMMIT_PX * 2 * SWIPE_MAX_SLOPE + 1), false)
  assert.equal(swipeCommitted(SWIPE_COMMIT_PX * 2, -(SWIPE_COMMIT_PX * 2 * SWIPE_MAX_SLOPE + 1)), false)
  assert.equal(swipeCommitted(-200, 0), false)
})

test('the commit distance is further than the start distance, so a tap with a little jitter never reviews', () => {
  assert.ok(SWIPE_COMMIT_PX > SWIPE_START_PX * 3)
  assert.equal(swipeCommitted(SWIPE_START_PX + 5, 0), false)
})

test('the undo toast is plain data: the item id, its title and when it expires (UNDO_MS later)', () => {
  const t = undoToast({ id: 'a1', title: 'Fix the thing' }, 1000)
  assert.deepEqual(t, { id: 'a1', title: 'Fix the thing', until: 1000 + UNDO_MS })
})

test('the undo window is a few seconds, long enough to read and short enough not to linger', () => {
  assert.ok(UNDO_MS >= 4000 && UNDO_MS <= 10000)
})
