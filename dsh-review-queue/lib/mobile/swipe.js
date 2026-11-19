/**
 * Swipe right on a Waiting row = open the item and press Reviewed (docs/mobile.md "Swipe to review"). Pure rules, so they are testable
 * without a browser: which rows swipe, whether a touch is a swipe or a scroll, whether a release commits, and the Undo toast record.
 */
/** The finger must travel this far (px) before the touch is judged a swipe or a scroll. */
export const SWIPE_START_PX = 10
/** A release commits (reviews) from this distance to the right (px): well past tap jitter. */
export const SWIPE_COMMIT_PX = 96
/** How slanted a swipe may be: vertical travel at most this fraction of the horizontal travel. */
export const SWIPE_MAX_SLOPE = 0.6
/** How long the Undo toast stays (ms). */
export const UNDO_MS = 6000

/** Only the cards that have a Reviewed or Keep session button: done, archive-ask and PR merged. */
export function isSwipeable(item) {
  return !!item && (item.type === 'completed' || item.type === 'archive' || item.type === 'pr-merged')
}

/** What a touch that moved (dx, dy) from where it started is: 'pending' (too small to tell), 'swipe' (mostly to the right) or 'scroll' (anything else: leave the row alone). */
export function swipeIntent(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'pending'
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_START_PX) return 'pending'
  if (dx >= SWIPE_START_PX && Math.abs(dy) <= dx * SWIPE_MAX_SLOPE) return 'swipe'
  return 'scroll'
}

/** 0..1: how far along the commit distance the row is dragged (drives the hint behind it). */
export function swipeProgress(dx) {
  if (!Number.isFinite(dx) || dx <= 0) return 0
  return Math.min(1, dx / SWIPE_COMMIT_PX)
}

/** True when a release at (dx, dy) reviews the item: far enough to the right and not too slanted. */
export function swipeCommitted(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false
  return dx >= SWIPE_COMMIT_PX && Math.abs(dy) <= dx * SWIPE_MAX_SLOPE
}

/** The Undo toast of a swipe review made at `now`: the item id, its title and when it expires. */
export function undoToast(item, now) {
  const until = now + UNDO_MS
  return { id: item.id, title: item.title, until }
}
