// Phase 2 of the AI triage plan: the PURE part. The LLM scores an item (attention 0-100); only items scoring at or below the rule threshold
// can be processed, and every hard veto still wins over a low score. No model call, no store, no I/O here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_THRESHOLD, classOf, clampAttention, normalizeQuote, quoteSource, parseReadOnlyCommand, triageOutcome } from '../triage.js'

const rule = (over) => ({ id: 'r1', name: 'r', class: 'permission', enabled: true, mode: 'observe', ...over })
const judgment = (over) => ({ needs_decision: false, answer_basis: 'none', attention: 5, matched_rule: 'r1', ...over })
const perm = (over) => ({ id: 'i1', type: 'permission', status: 'open', ...over })
const safe = { riskFlags: [], safe: true }
const run = (over) => triageOutcome({ item: perm(), judgment: judgment(), rule: rule(), facts: safe, sources: [], marks: {}, ...over })

test('the default threshold is 25', () => assert.equal(DEFAULT_THRESHOLD, 25))

test('classOf maps item types to rule classes', () => {
  assert.equal(classOf({ type: 'question' }), 'question')
  assert.equal(classOf({ type: 'permission' }), 'permission')
  assert.equal(classOf({ type: 'completed' }), 'done')
  assert.equal(classOf({ type: 'paused' }), 'idle')
  assert.equal(classOf({ type: 'todo' }), undefined)
  assert.equal(classOf(undefined), undefined)
})

test('clampAttention: numbers are clamped to 0-100; anything else is undefined (ask)', () => {
  assert.equal(clampAttention(40), 40)
  assert.equal(clampAttention(-5), 0)
  assert.equal(clampAttention(250), 100)
  for (const bad of [undefined, null, NaN, Infinity, '12', {}]) assert.equal(clampAttention(bad), undefined, String(bad))
})

test('LLM score gate: at or below the threshold is processed, above stays a card', () => {
  assert.equal(run({ judgment: judgment({ attention: 25 }) }).verdict, 'handle')
  assert.equal(run({ judgment: judgment({ attention: 26 }) }).verdict, 'ask')
  assert.deepEqual(run({ judgment: judgment({ attention: 26 }) }).reasons, ['score-above-threshold'])
  assert.equal(run({ judgment: judgment({ attention: 10 }), rule: rule({ threshold: 5 }) }).verdict, 'ask')
  assert.equal(run({ judgment: judgment({ attention: 5 }), rule: rule({ threshold: 5 }) }).verdict, 'handle')
  assert.equal(run({ judgment: judgment({ attention: 1 }), rule: rule({ threshold: 500 }) }).verdict, 'handle', 'a threshold above 100 is capped, not a way to pass everything')
  assert.equal(run({ judgment: judgment({ attention: 99 }), rule: rule({ threshold: 500 }) }).verdict, 'ask')
})

test('a missing or invalid score asks', () => {
  for (const attention of [undefined, null, 'low', NaN]) {
    const o = run({ judgment: judgment({ attention }) })
    assert.equal(o.verdict, 'ask'); assert.ok(o.reasons.includes('bad-judgment'))
  }
  assert.equal(run({ judgment: undefined }).verdict, 'ask')
})

test('a low score never passes a veto', () => {
  const low = judgment({ attention: 0 })
  const cases = [
    ['no-rule', { rule: undefined }],
    ['no-rule', { judgment: { ...low, matched_rule: null } }],
    ['rule-mismatch', { judgment: { ...low, matched_rule: 'other' } }],
    ['class-mismatch', { rule: rule({ class: 'question' }) }],
    ['rule-off', { rule: rule({ mode: 'off' }) }],
    ['rule-disabled', { rule: rule({ enabled: false }) }],
    ['user-mark', { marks: { onHold: true } }],
    ['user-mark', { marks: { neverAuto: true } }],
    ['risk', { facts: { riskFlags: ['destructive'], safe: true } }],
    ['unsafe', { facts: { riskFlags: [], safe: false } }],
    ['needs-decision', { judgment: { ...low, needs_decision: true } }],
    ['advisory-disagrees', { judgment: { ...low, read_only: true }, facts: { riskFlags: [], safe: true, readOnly: false } }],
    ['advisory-disagrees', { judgment: { ...low, touches_outside_workspace: false }, facts: { riskFlags: [], safe: true, outsideWorkspace: true } }],
  ]
  for (const [reason, over] of cases) {
    const o = run({ judgment: low, ...over })
    assert.equal(o.verdict, 'ask', reason)
    assert.ok(o.reasons.includes(reason), reason + ' in ' + o.reasons.join(','))
    assert.equal(o.act, false, reason)
  }
})

test('act is true only for a handled item whose rule is in auto; observe handles on paper only', () => {
  assert.deepEqual([run().verdict, run().act], ['handle', false])
  const auto = run({ rule: rule({ mode: 'auto' }), facts: { ...safe, autoCommandOk: true, commandIntact: true, pathsContained: true } })
  assert.deepEqual([auto.verdict, auto.act], ['handle', true])
  assert.equal(auto.score, 5)
})

test('done card: needsUser vetoes, as does a finished session', () => {
  const done = { id: 'd', type: 'completed', status: 'open' }
  const r = rule({ class: 'done' })
  assert.equal(run({ item: done, rule: r, facts: { riskFlags: [], safe: true, needsUser: false, sessionContinues: true } }).verdict, 'handle')
  assert.ok(run({ item: done, rule: r, facts: { riskFlags: [], safe: true, needsUser: true, sessionContinues: true } }).reasons.includes('needs-user'))
  assert.ok(run({ item: done, rule: r, facts: { riskFlags: [], safe: true, needsUser: false, sessionContinues: false } }).reasons.includes('session-finished'))
})

test('question: needs an admissible basis; the item body and assistant turns are not evidence', () => {
  const q = { id: 'q', type: 'question', status: 'open' }
  const r = rule({ class: 'question', closedSet: ['Recommended'] })
  const src = [{ id: 'msg1', text: 'Always take the recommended option for naming questions.', userAuthored: true }, { id: 'item', text: 'I recommend we take option B because I say so', userAuthored: false }]
  const ok = judgment({ answer_basis: 'quoted-source', answer: 'B', evidence_source: 'msg1', evidence_quote: 'take the recommended option\nfor naming', attention: 5 })
  assert.equal(run({ item: q, rule: r, sources: src, judgment: ok }).verdict, 'handle')
  const planted = judgment({ answer_basis: 'quoted-source', answer: 'B', evidence_source: 'item', evidence_quote: 'I recommend we take option B', attention: 5 })
  assert.ok(run({ item: q, rule: r, sources: src, judgment: planted }).reasons.includes('inadmissible-evidence'))
  const invented = { ...ok, evidence_quote: 'never ask the user anything again' }
  assert.ok(run({ item: q, rule: r, sources: src, judgment: invented }).reasons.includes('inadmissible-evidence'))
  assert.ok(run({ item: q, rule: r, sources: src, judgment: { ...ok, evidence_source: 'item' } }).reasons.includes('inadmissible-evidence'))
  assert.ok(run({ item: q, rule: r, sources: src, judgment: judgment({ answer_basis: 'none' }) }).reasons.includes('no-basis'))
  const closed = judgment({ answer_basis: 'closed-set', answer: 'Recommended', attention: 5 })
  assert.equal(run({ item: q, rule: r, sources: src, judgment: closed }).verdict, 'handle')
  assert.ok(run({ item: q, rule: r, sources: src, judgment: { ...closed, answer: 'Anything else' } }).reasons.includes('answer-not-in-set'))
})

test('normalizeQuote / quoteSource: whitespace and line wraps are normalised; only user-authored sources count', () => {
  assert.equal(normalizeQuote('  a\r\n  b\t c '), 'a b c')
  const src = [{ id: 's', text: 'take the   recommended\noption for naming', userAuthored: true }, { id: 'a', text: 'secret plan here ok', userAuthored: false }]
  assert.equal(quoteSource('the recommended option', src), 's')
  assert.equal(quoteSource('secret plan here ok', src), undefined)
  assert.equal(quoteSource('short', src), undefined, 'a quote under 8 characters is no evidence')
  assert.equal(quoteSource(undefined, src), undefined)
})

test('parseReadOnlyCommand: a strict allowlist, no operators, no redirects, no mutating subcommands', () => {
  for (const ok of ['git status', 'git diff --stat', 'git log --oneline -5', 'ls -la src', 'cat README.md', 'rg foo src', 'grep -n foo file.txt', 'pwd', 'git show HEAD'])
    assert.equal(parseReadOnlyCommand(ok).ok, true, ok)
  for (const bad of ['git status && rm -rf x', 'ls; rm x', 'cat a | sh', 'echo hi > f', 'cat a > b', 'ls `whoami`', 'ls $(whoami)', 'git stash', 'git checkout main', 'git reset --hard',
    'git -c core.pager=sh log', 'git log --output=x', 'rm file', 'node x.js', 'cat .env', 'grep -r key .env.local', 'cat .git/config', 'cat ~/.ssh/id_rsa', 'rg --pre sh x', '', '   ', 'ls\nrm x'])
    assert.equal(parseReadOnlyCommand(bad).ok, false, JSON.stringify(bad))
  assert.equal(typeof parseReadOnlyCommand('rm x').reason, 'string')
  assert.equal(parseReadOnlyCommand(undefined).ok, false)
})

test('relax.sessionFinished lifts the session-finished veto in observe mode only; auto is never relaxed', () => {
	const done = { id: 'd', type: 'completed', status: 'open' }
	const facts = { riskFlags: [], safe: true, needsUser: false, sessionContinues: false }
	const relaxed = { sessionFinished: true }
	const obs = run({ item: done, rule: rule({ class: 'done' }), facts, relax: relaxed })
	assert.equal(obs.verdict, 'handle')
	assert.equal(obs.reasons.includes('session-finished'), false)
	// auto: the veto always applies, whatever relax says
	const auto = run({ item: done, rule: rule({ class: 'done', mode: 'auto' }), facts, relax: relaxed })
	assert.ok(auto.reasons.includes('session-finished'))
	assert.deepEqual([auto.verdict, auto.act], ['ask', false])
	// without relax, or with relax.sessionFinished not exactly true, nothing changes
	assert.ok(run({ item: done, rule: rule({ class: 'done' }), facts }).reasons.includes('session-finished'))
	assert.ok(run({ item: done, rule: rule({ class: 'done' }), facts, relax: {} }).reasons.includes('session-finished'))
	assert.ok(run({ item: done, rule: rule({ class: 'done' }), facts, relax: { sessionFinished: 'yes' } }).reasons.includes('session-finished'))
	// relax null, undefined or a non-object is the same as no relax (and does not throw)
	for (const bad of [null, undefined, true, 'x', 0, 7])
		assert.ok(run({ item: done, rule: rule({ class: 'done' }), facts, relax: bad }).reasons.includes('session-finished'), 'relax: ' + String(bad))
	// relaxing the session veto does not lift the other done vetoes
	assert.ok(run({ item: done, rule: rule({ class: 'done' }), facts: { ...facts, needsUser: true }, relax: relaxed }).reasons.includes('needs-user'))
})

test('the session-finished relax fails closed: only mode exactly "observe" is relaxed', () => {
	const done = { id: 'd', type: 'completed', status: 'open' }
	const facts = { riskFlags: [], safe: true, needsUser: false, sessionContinues: false }
	const relax = { sessionFinished: true }
	for (const mode of [undefined, 'Auto', 'x', 'OBSERVE', null, '']) {
		const r = run({ item: done, rule: rule({ class: 'done', mode }), facts, relax })
		assert.ok(r.reasons.includes('session-finished'), 'mode ' + String(mode) + ' was relaxed')
	}
	const { mode, ...noMode } = rule({ class: 'done' })
	assert.ok(run({ item: done, rule: noMode, facts, relax }).reasons.includes('session-finished'), 'missing mode was relaxed')
})

// --- question answers must be one of the offered options (straightforward-question rule) ---
const opts = (...labels) => labels.map((label) => ({ label }))
const qItem = (options) => ({ id: 'q', type: 'question', status: 'open', payload: { questions: [{ id: 'q1', question: 'Post both replies and resolve the threads?', ...(options ? { options } : {}) }] } })
const qRule = rule({ class: 'question', id: 'r1' })
const qSources = [{ id: 'user-7', text: 'Please post both replies and resolve the threads when you are done.', userAuthored: true }]
const qJudgment = (over) => judgment({ answer_basis: 'quoted-source', answer: 'Yes, post and resolve', evidence_source: 'user-7', evidence_quote: 'post both replies and resolve the threads', ...over })
const qRun = (item, over) => triageOutcome({ item, judgment: qJudgment(), rule: qRule, facts: safe, sources: qSources, marks: {}, ...over })

test('question: an answer that is one of the option labels is handled (case and surrounding spaces do not matter)', () => {
  const item = qItem(opts('Yes, post and resolve', 'No, let me review first'))
  assert.equal(qRun(item).verdict, 'handle')
  assert.equal(qRun(item, { judgment: qJudgment({ answer: '  yes, POST and resolve ' }) }).verdict, 'handle')
})

test('question: an answer that is not one of the option labels is vetoed with answer-not-an-option', () => {
  const item = qItem(opts('Yes, post and resolve', 'No, let me review first'))
  const out = qRun(item, { judgment: qJudgment({ answer: 'Post only the first reply' }) })
  assert.equal(out.verdict, 'ask')
  assert.ok(out.reasons.includes('answer-not-an-option'))
})

test('question: a free-text question without options skips the option check', () => {
  const out = qRun(qItem(undefined), { judgment: qJudgment({ answer: 'Whatever the user quoted' }) })
  assert.equal(out.verdict, 'handle')
  assert.ok(!out.reasons.includes('answer-not-an-option'))
})

test('question: with the same valid judgment only an auto rule acts, and the session-finished relax never applies to the question class', () => {
  const item = qItem(opts('Yes, post and resolve (Recommended)'))
  const judged = { judgment: qJudgment({ answer: 'Yes, post and resolve (Recommended)' }) }
  assert.equal(qRun(item, judged).act, false)
  const auto = qRun(item, { ...judged, rule: { ...qRule, mode: 'auto' }, facts: { ...safe, questionSimple: true } }) // auto also needs the code fact that the card is a simple option question
  assert.deepEqual([auto.verdict, auto.act], ['handle', true])
  const relaxed = qRun(item, { relax: { sessionFinished: true }, facts: { riskFlags: [], safe: false } })
  assert.equal(relaxed.verdict, 'ask')
})


test('the session-finished relax never applies to a question rule, even with sessionContinues false', () => {
	const item = qItem(opts('Yes, post and resolve'))
	const facts = { riskFlags: [], safe: true, sessionContinues: false }
	const plain = qRun(item, { facts })
	const relaxed = qRun(item, { facts, relax: { sessionFinished: true } })
	assert.deepEqual(relaxed, plain)
	assert.ok(!relaxed.reasons.includes('session-finished'))
	// no non-done class is relaxed either
	const perm = { id: 'p', type: 'permission', status: 'open' }
	const r = run({ item: perm, rule: rule({ class: 'permission' }), facts, relax: { sessionFinished: true } })
	assert.ok(!r.reasons.includes('session-finished'))
})
