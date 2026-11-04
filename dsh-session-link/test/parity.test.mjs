import test from 'node:test'
import assert from 'node:assert/strict'
import { suggestSessionByRef } from '../../dsh-review-queue/follow-up-shared.js'
import { matchSessions } from '../match.js'

const C = [
  { sessionId: 'a1', title: 'Fix: stopped experiment - 25883' },
  { sessionId: 'c3', title: 'PR 6681 comment polling' },
  { sessionId: 'x', title: 'Report 2026-10-20 done' },
  { sessionId: 'y1', title: 'Thing 777 one' },
  { sessionId: 'y2', title: 'Other 777 two' },
]
for (const q of ['AB#25883', 'PR 6681', 'PR 668', '#10', 'ticket 777', 'pull request #6681']) {
  test('same ticket rule as the review queue for: ' + q, () => {
    const queue = suggestSessionByRef(q, C)
    const mine = matchSessions(q, C)
    if (queue) { assert.equal(mine.kind, 'one'); assert.equal(mine.matches[0].session.sessionId, queue.sessionId) }
    else assert.notEqual(mine.kind, 'one')
  })
}
