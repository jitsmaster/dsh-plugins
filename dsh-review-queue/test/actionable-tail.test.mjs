import { test } from 'node:test'
import assert from 'node:assert/strict'
import { needsUser, needsUserForTriage, questionAnywhere, mentionsBackgroundWork, problemAnywhere } from '../actionable.js'

const CODE_QUESTION_LABELS = new Set(['a question inside a code block', 'error text inside inline code'])

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

// Tails that only mention a pull request, a handoff or a ticket: needsUser keeps them, needsUserForTriage lets them through.
const NEEDS_PR_HANDOFF_TICKET = [
	['a handoff in the tail', 'All done. Wrote the handoff for the next session.'],
	['a hand-off in the tail', 'Wrote the hand-off note.'],
	['a PR in the tail', 'Opened PR 123 against develop.'],
	['a pull request in the tail', 'The pull request is up.'],
	['a PR-WAIT heartbeat', 'PR-WAIT: 6541'],
	['a pr wait heartbeat after a status line', 'Nothing new on the thread.\n\npr-wait 123'],
	['a ticket in the tail', 'Closed the ticket.'],
	['a work item in the tail', 'Linked the work item to the change.'],
	['an AB id in the tail', 'Updated AB#2025 with the results.'],
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
	['a question in the second to last paragraph', ['Early note.', 'Is the schema final?', 'Tests pass and it is committed.'].join('\n\n')],
	['a question that follows a code block', 'Result:\n\n```\nok\n```\n\nShould I merge it?'],
	['still failing after the clean phrase is removed', 'Ran it: 0 failures in the first suite, but two tests are still failing in the second.'],
]

for (const [label, reply] of STATUS) test('needsUser lets a status or finished-work reply through: ' + label, () => assert.equal(needsUser(reply), false, reply))
for (const [label, reply] of [...NEEDS, ...NEEDS_PR_HANDOFF_TICKET]) test('needsUser keeps the reply that holds something for the user: ' + label, () => assert.equal(needsUser(reply), true, reply))

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

// needsUserForTriage: like needsUser, but a tail that only mentions a pull request, a handoff or a ticket does not veto (AI triage only).
const forTriage = needsUserForTriage
const ONLY_PR_HANDOFF_TICKET = [
	['a PR number', 'Tests pass.\n\nPR #123 is open.'],
	['a pull request', 'The pull request is up against develop.'],
	['a PR-WAIT heartbeat', 'PR-WAIT: 6541'],
	['a handoff','Handoff written to the vault.'],
	['a hand-off', 'The hand-off note is saved.'],
	['an AB id', 'AB#25870 updated with the results.'],
	['a ticket', 'Closed the ticket.'],
	['a work item', 'Linked the work item to the change.'],
]
for (const [label, reply] of ONLY_PR_HANDOFF_TICKET) test('needsUserForTriage ignores a tail that only mentions ' + label + ' (needsUser still keeps it)', () => {
	assert.equal(needsUser(reply), true, reply)
	assert.equal(forTriage(reply), false, reply)
})

const REAL_NEEDS_WITH_PR = [
	['a question', 'PR #123 is open. Should I merge it?'],
	['please', 'PR #123 is open, please review it.'],
	['approve', 'The pull request needs your approval.'],
	['blocked on', 'Handoff written, but I am blocked on the ticket.'],
	['a manual step', 'AB#25870 updated. You will need to restart the server.'],
	['ready for your review', 'Done.\n\nPR #5 is ready for your review.'],
	['ready for review', 'Done.\n\nPR #5 is ready for review.'],
	['ready for merge', 'Done.\n\nThe pull request is ready for merge.'],
	['for your attention', 'Done.\n\nTicket AB#25577 filed for your attention.'],
	['awaiting your review', 'PR #5 is open and awaiting your review.'],
	['review requested', 'Review requested from you on PR 12.'],
	['pick it up next session', 'Handoff written to docs/handoff.md, pick it up next session.'],
	['take a look', 'Take a look at the PR when you can.'],
	['merge when ready', 'Merge when ready.'],
	['see the PR', 'Details are in the pull request, see the PR.'],
	['next step: merge', 'Next step: merge the PR.'],
	['open the PR and review the diff', 'Open the PR and review the diff.'],
	['awaiting review', 'PR 7 is up. Awaiting review.'],
]
for (const [label, reply] of REAL_NEEDS_WITH_PR) test('needsUserForTriage still vetoes ' + label + ' next to a PR, handoff or ticket', () => {
	assert.equal(needsUser(reply), true, reply)
	assert.equal(forTriage(reply), true, reply)
})

// Plain failure and hand-back wording with no PR, handoff or ticket mention: auto done cards rely on the weak check alone, so these must veto.
const FAILURE_OR_HAND_BACK = [
	['tests failed', '3 tests failed.'],
	['specs failing', 'Done editing. 12 specs are failing in the parser suite.'],
	['build failed with an error', 'Build failed with an error.'],
	['the build has failed', 'The build has failed on the CI box.'],
	['the migration failed', 'The migration failed halfway.'],
	['failed with', 'The run failed with exit code 2.'],
	['next step', 'Next step: merge the branch.'],
	['follow-up', 'There is a follow-up for the docs.'],
	['remaining work', 'I skipped the migration; the remaining work is the docs.'],
	['waiting for CI and a reviewer', 'Waiting for CI and a reviewer.'],
	['pending review', 'Change is pending review.'],
	['awaiting approval', 'Awaiting approval from the lead.'],
	['I recommend', 'I recommend merging.'],
	['I suggest', 'I suggest keeping the old name.'],
	['I propose', 'I propose a smaller change.'],
	['pick it up', 'Branch is pushed, pick it up when convenient.'],
]
for (const [label, reply] of FAILURE_OR_HAND_BACK) test('needsUserForTriage vetoes failure or hand-back wording: ' + label, () => assert.equal(forTriage(reply), true, reply))

const CLEAN_FINISHED = [
	['zero tests failed', 'Ran the suite: 0 tests failed.'],
	['no tests failing', 'Ran it, no tests failing, build is green.'],
	['all tests pass', 'All 120 tests pass. Committed as abc1234.'],
	['a failure counter topic', 'Added a failure counter to the dashboard.'],
]
for (const [label, reply] of CLEAN_FINISHED) test('needsUserForTriage lets a clean finished reply through: ' + label, () => assert.equal(forTriage(reply), false, reply))

test('needsUserForTriage keeps empty, non-string and code-only replies, and lets plain status through like needsUser', () => {
	for (const reply of ['', '   \n ', undefined, null, 42, {}]) { assert.equal(needsUser(reply), true); assert.equal(forTriage(reply), true) }
	assert.equal(forTriage('```\nonly code\n```'), true)
	// A "?" inside code is a veto for triage only (see below), so those two status replies are excluded here.
	for (const [label, reply] of STATUS) if (!CODE_QUESTION_LABELS.has(label)) assert.equal(forTriage(reply), false, reply)
	for (const [, reply] of NEEDS) assert.equal(forTriage(reply), true, reply)
})

test('needsUserForTriage treats a "?" inside inline or fenced code in the tail as needing the user; needsUser does not', () => {
	for (const reply of ['Renamed `onError` to `handleFailure?` and committed.', 'Added the check.\n\n```js\nconst ok = a ? b : c\n```\n\nAll tests pass.']) {
		assert.equal(needsUser(reply), false, reply)
		assert.equal(forTriage(reply), true, reply)
	}
	// a "?" in code before the last two paragraphs stays invisible
	assert.equal(forTriage('```\na ? b : c\n```\n\nOne.\n\nTwo.\n\nThree.'), false)
})

test('questionAnywhere: a question mark followed by space or the end, anywhere in the reply, code included; fails closed on a non-string', () => {
	assert.equal(questionAnywhere('Why is the cache stale? I traced it.\n\nOne.\n\nTwo.\n\nDone.'), true)
	assert.equal(questionAnywhere('Fixed.\n\n```\na ? b : c\n```'), true)
	assert.equal(questionAnywhere('Fixed it.\n\nShould I merge?'), true)
	for (const reply of ['Want me to push?...\n\nA.\n\nB.\n\nC.', 'Shall I go on?-\n\nA.\n\nB.\n\nC.', 'ok?/ fine', 'Should I push?.\n\nok', 'Ready?=yes']) assert.equal(questionAnywhere(reply), true, reply)
	assert.equal(questionAnywhere('Docs at https://example.test/a?b=1&c=2. See (https://x.test/p?q=%20). All pass.'), false)
	assert.equal(questionAnywhere('Is it fixed?) Yes.'), true)
	assert.equal(questionAnywhere('Is it **fixed?** Yes.'), true)
	assert.equal(questionAnywhere('Ist es fertig？ Ja.'), true)
	assert.equal(questionAnywhere('See https://example.test/a?b=1 for details. All tests pass.'), false)
	assert.equal(questionAnywhere('Renamed the helper. All tests pass.'), false)
	for (const reply of ['', '   ', undefined, null, 42, {}]) assert.equal(questionAnywhere(reply), true)
})

test('problemAnywhere: failure or blocker wording anywhere in the reply (code removed, clean phrases masked); fails closed on a non-string', () => {
	for (const reply of ["3 tests failed, couldn't fix the auth module.\n\nOne.\n\nTwo.\n\nSummary: done.", 'Build failed.\n\nA.\n\nB.\n\nC.', 'I am stuck on login.\n\nA.\n\nB.\n\nC.', 'The docs are not yet done.\n\nA.\n\nB.\n\nC.', 'Unable to reach the server.\n\nA.\n\nB.\n\nC.', 'Blocked by a missing key.\n\nA.\n\nB.\n\nC.', 'There is a follow-up.\n\nA.\n\nB.\n\nC.']) assert.equal(problemAnywhere(reply), true, reply)
	for (const reply of ['Renamed the helper. All 120 tests pass. Committed as abc1234.', 'Ran the suite: 0 failures, no errors.\n\nA.\n\nB.\n\nC.', 'Renamed `failedCount`.\n\nA.\n\nB.', 'Added a failure counter to the dashboard.']) assert.equal(problemAnywhere(reply), false, reply)
	for (const reply of ['', '   ', undefined, null, 42, {}]) assert.equal(problemAnywhere(reply), true)
})

test('curly apostrophes are read like straight ones (can’t, couldn’t) in the tail check and the whole-reply scan', () => {
	assert.equal(problemAnywhere('I can’t fix the auth module.\n\nA.\n\nB.\n\nC.'), true)
	assert.equal(problemAnywhere('It couldn’t build.\n\nA.\n\nB.\n\nC.'), true)
	assert.equal(forTriage('I can’t find the config.'), true)
	assert.equal(forTriage('I couldn’t run the migration.'), true)
	assert.equal(needsUser('I can’t find the config.'), true)
})

test('mentionsBackgroundWork: running, in-progress or continuing work anywhere in the reply; fails closed on a non-string', () => {
	for (const reply of ['The review subagent is still running in the background.', 'Started the build; I will continue when it reports.', 'Tests are still running.', 'The migration is in progress.', 'Work continues in the background.', 'Ran the suite, all green.\n\nReview 3 subagent is running.',
		"Kicked off the full migration; it's running, check logs later.", 'The import is still going.', 'Launched the deploy job.', 'Started a job for the export.', 'The sync is ongoing.', 'Started it with nohup.', 'A background task handles the rest.']) assert.equal(mentionsBackgroundWork(reply), true, reply)
	for (const reply of ['Renamed the helper. All 120 tests pass. Committed as abc1234.', 'Logged the change in the daily note.']) assert.equal(mentionsBackgroundWork(reply), false, reply)
	for (const reply of ['', '   ', undefined, null, 42, {}]) assert.equal(mentionsBackgroundWork(reply), true)
})
