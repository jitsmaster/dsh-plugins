import { test } from 'node:test'
import assert from 'node:assert/strict'
import { needsUser } from '../actionable.js'

// All replies are invented. needsUser looks only at the tail (the last two paragraphs, code removed) and can only veto a hide.
const para = (n, word = 'Filler') => Array.from({ length: n }, (_, i) => word + ' paragraph ' + i + '.').join('\n\n')

const STATUS = [
	['still waiting on a subagent', "I'm still waiting for the helper process to report back. I will continue as soon as it does."],
	['a review running in the background', 'Review 1 is done and the fix subagent is running; I will continue when it reports.'],
	['logging done', 'I logged the change in today\'s daily note.'],
	['finished work with commit and tests', 'Renamed the helper and updated its callers. All 120 tests pass. Committed as abc1234.'],
	['review as a plain topic in the tail', 'Reviewed the review module and the review notes; the review section of the docs is up to date.'],
	['error and failure as topics in the tail', 'Added an error banner and a failure counter to the dashboard. The error message text is now shorter.'],
	['dropped words only before the tail', [para(3, 'Review of the error handling, a warning about a regression, a workaround, a risk; I recommend and suggest and propose and consider this. Note that it is incomplete and partial. Next steps and a todo follow-up. Alternatively there is a trade-off. Heads-up, skipped.'), 'Renamed the helper.', 'All tests pass and everything is committed.'].join('\n\n')],
	['a question mark in an early paragraph only', ['Why is the cache stale? I traced it to the ttl.', 'Fixed the ttl in the loader.', 'Tests pass and the change is committed.'].join('\n\n')],
	['a question inside a code block', 'Added the check.\n\n```js\nconst ok = a ? b : c\nthrow new Error("failed?")\n```\n\nAll tests pass.'],
	['error text inside inline code', 'Renamed `onError` to `handleFailure?` and committed.'],
	['the clean phrases', 'Ran the suite: 0 failures, no errors, zero warnings, without regressions, nothing failed.'],
	['a bare work word without a user ask', 'Cleaned up the remaining imports and removed the partial file; the workaround is gone.'],
]

const NEEDS = [
	['a question in the tail', 'I found two causes.\n\nWhich port should the server use?'],
	['a question mark in the last paragraph only', 'Fixed it. Does that match what you saw?'],
	['please', 'The change is ready. Please check the page in your browser.'],
	['could you', 'Could you share the log?'],
	['do you', 'Do you prefer the short name'],
	['will we', 'Will we keep the old endpoint'],
	['want me to', 'I can also add docs if you want me to.'],
	['let me know', 'Updated the config. Let me know if the old behaviour should come back.'],
	['your call', 'Both options work. Your call.'],
	['up to you', 'It is up to you whether to ship it.'],
	['you need to', 'The fix is in. You need to restart the service.'],
	["you'll have to", "You'll have to rerun the installer."],
	['you can', 'Pushed. You can open the page now.'],
	['need your', 'This needs your approval before I go on.'],
	['before you', 'Read the notes before you merge.'],
	['once you', 'I will carry on once you confirm.'],
	['decide', 'Someone has to decide between the two layouts.'],
	['approval', 'Waiting for approval of the plan.'],
	['sign-off', 'The change needs a sign-off.'],
	['confirm that', 'Confirm that the build is green on your side.'],
	['double-check whether', 'Double-check whether the path exists.'],
	['test it', 'Test it on the staging box.'],
	['by hand', 'The last step has to be done by hand.'],
	['manually', 'Copy the file over manually.'],
	['restart the', 'Restart the server to pick it up.'],
	['reload', 'Reload the tab.'],
	['blocked on you', 'Blocked on you: the key is missing.'],
	['blocked by', 'The job is blocked by a missing credential.'],
	['stuck', 'I am stuck on the login step.'],
	['waiting on the user', 'Waiting on the user to supply the token.'],
	['waiting for you', 'Waiting for you to pick a branch.'],
	['unable to', 'I was unable to reach the server.'],
	['cannot', 'The tool cannot read that file.'],
	["can't", "I can't find the config."],
	['could not', 'I could not run the migration.'],
	["wasn't able", "I wasn't able to build the image."],
	['still failing', 'Two tests are still failing in the parser suite.'],
	['remaining broken', 'The remaining broken cases are in the importer.'],
	['still open', 'One item is still open.'],
	['not yet fixed', 'The flaky test is not yet fixed.'],
	['not working', 'Sorting is not working on mobile.'],
	['unresolved', 'There is one unresolved conflict.'],
	['outstanding', 'Nothing else is outstanding except the license text.'],
	['open question', 'An open question remains about caching.'],
	['open issue', 'There is an open issue with the exporter.'],
	['a handoff in the tail', 'All done. Wrote the handoff for the next session.'],
	['a hand-off in the tail', 'Wrote the hand-off note.'],
	['a PR in the tail', 'Opened PR 123 against develop.'],
	['a pull request in the tail', 'The pull request is up.'],
	['a PR-WAIT heartbeat', 'PR-WAIT: 6541'],
	['a pr wait heartbeat after a status line', 'Nothing new on the thread.\n\npr-wait 123'],
	['a ticket in the tail', 'Closed the ticket.'],
	['a work item in the tail', 'Linked the work item to the change.'],
	['an AB id in the tail', 'Updated AB#2025 with the results.'],
	['a question in the second to last paragraph', ['Early note.', 'Is the schema final?', 'Tests pass and it is committed.'].join('\n\n')],
	['a question that follows a code block', 'Result:\n\n```\nok\n```\n\nShould I merge it?'],
	['still failing after the clean phrase is removed', 'Ran it: 0 failures in the first suite, but two tests are still failing in the second.'],
]

for (const [label, reply] of STATUS) test('needsUser lets a status or finished-work reply through: ' + label, () => assert.equal(needsUser(reply), false, reply))
for (const [label, reply] of NEEDS) test('needsUser keeps the reply that holds something for the user: ' + label, () => assert.equal(needsUser(reply), true, reply))

test('a question mark before the last two paragraphs does not veto, in the last two it does', () => {
	assert.equal(needsUser('Question?\n\nOne.\n\nTwo.'), false)
	assert.equal(needsUser('Question?\n\nOne.\n\nTwo.\n\n'), false)
	assert.equal(needsUser('One.\n\nQuestion?\n\nTwo.'), true)
})

test('paragraphs are split on blank lines (also with CRLF and trailing spaces)', () => {
	assert.equal(needsUser('Which one?\r\n\r\nFirst.\r\n  \r\nSecond.'), false)
	assert.equal(needsUser('First.\r\n\r\nWhich one?\r\n\r\nSecond.'), true)
})

test('code blocks do not count as a paragraph, so the real tail is still examined', () => {
	assert.equal(needsUser('Which one?\n\nA.\n\n```\ncode\n```\n\n```\nmore\n```\n\nB.'), false)
	assert.equal(needsUser('A.\n\nWhich one?\n\n```\ncode\n```\n\n```\nmore\n```'), true)
})

test('empty, blank and non-string replies are kept; a reply that is only code is kept too', () => {
	for (const reply of ['', '   \n ', undefined, null, 42, {}]) assert.equal(needsUser(reply), true)
	assert.equal(needsUser('```\nonly code\n```'), true)
})
