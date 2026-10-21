import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestSessionByRef } from '../todo.js'
import { fakeLlm, setupFollowUp, promptOf, prompts, NOW } from './follow-up-helpers.mjs'

// Which session a follow-up is for: the deterministic ticket / PR number match first, then the cheapest model.
const c = (sessionId, title) => ({ sessionId, title })
const LIST = [c('a', 'Fix: login redirect - 25001'), c('b', 'PR 6556 review'), c('d', 'Orca engine tuning')]

// ---- deterministic -------------------------------------------------------------------------------------------------
test('a ticket or PR number in the words that is a whole number in exactly one title picks that session', () => {
  for (const query of ['the session about AB#25001', 'ticket 25001 follow up', 'ticket #25001', 'the one for #25001', 'Ticket 25001.', 'work item 25001', 'Work Item #25001']) {
    assert.deepEqual(suggestSessionByRef(query, LIST), { sessionId: 'a', title: 'Fix: login redirect - 25001', reason: 'ticket or PR number in the words' }, query)
  }
  for (const query of ['PR 6556', 'pr 6556 please', 'PR#6556', 'the pull request 6556 session', 'Pull Request #6556', 'PR  #6556']) {
    assert.equal(suggestSessionByRef(query, LIST)?.sessionId, 'b', query)
  }
})

test('short numbers count only with a ticket / PR keyword; a number inside a longer number does not match', () => {
  const list = [c('x', 'PR 7 cleanup'), c('y', 'Release 2026 plan'), c('z', 'build 25678')]
  assert.equal(suggestSessionByRef('PR 7 please', list)?.sessionId, 'x')
  assert.equal(suggestSessionByRef('ticket 7', list)?.sessionId, 'x')
  assert.equal(suggestSessionByRef('the 7 thing', list), undefined, 'a bare one-digit number is not a reference')
  assert.equal(suggestSessionByRef('the 2026 plan', list), undefined, 'a bare number is only a hint for the model, it does not decide on its own')
  assert.equal(suggestSessionByRef('the one for 25001', [c('a', 'Fix: login redirect - 25001'), c('b', 'Other')]), undefined, 'not even when it is a whole number of exactly one title')
  assert.equal(suggestSessionByRef('APR 7 report', list), undefined, 'a keyword inside a longer word is none')
  assert.equal(suggestSessionByRef('the 2567 build', list), undefined, 'not a whole number of the title')
  assert.equal(suggestSessionByRef('the 256789 build', list), undefined)
  assert.equal(suggestSessionByRef('ticket 25678 now', list)?.sessionId, 'z')
  assert.equal(suggestSessionByRef('build 25678 now', list), undefined, 'a bare number')
  assert.equal(suggestSessionByRef('AB#2567', [c('q', 'AB#25678 thing')]), undefined)
})

test('ambiguous or contradicting references give no pick', () => {
  const two = [c('a', 'Fix 25001 login'), c('b', 'Also 25001 docs'), c('d', 'PR 6556')]
  assert.equal(suggestSessionByRef('ticket 25001', two), undefined, 'the number is in two titles')
  assert.equal(suggestSessionByRef('ticket 25001 and PR 6556', two)?.sessionId, 'd', 'a number in two titles is ignored when another one is unique')
  const split = [c('a', 'Fix 25001'), c('b', 'PR 6556')]
  assert.equal(suggestSessionByRef('ticket 25001 and PR 6556', split), undefined, 'two numbers, two different sessions')
  const same = [c('a', 'Fix 25001 for PR 6556'), c('b', 'Other')]
  assert.equal(suggestSessionByRef('ticket 25001 and PR 6556', same)?.sessionId, 'a', 'two numbers, one session')
  assert.equal(suggestSessionByRef('the login thing', LIST), undefined, 'no number')
  assert.equal(suggestSessionByRef('ticket 99999', LIST), undefined, 'a number no title has')
  assert.equal(suggestSessionByRef('ticket 25001', []), undefined)
  assert.equal(suggestSessionByRef('', LIST), undefined)
  assert.equal(suggestSessionByRef('ticket 25001', undefined), undefined)
})

test('a bare number in the words does not preselect a session: the model is asked and is told the number as a hint', async () => {
  const seen = {}
  const { queue, store } = setupFollowUp({ llm: fakeLlm({ answer: '{"select":"s-orca","reason":"r"}', seen }) })
  const { id } = queue.addTodo('Please also run the lint', { followUp: 'the session for 6556 and 25001 and 6556' })
  await queue.todoIdle()
  assert.equal(seen.calls, 1, 'the model is asked')
  assert.equal(store.get(id).suggested.sessionId, 's-orca', 'what the model says, not the title that holds the number')
  assert.match(promptOf(seen), /Numbers in the words[^\n"]*: 6556, 25001/)
  const none = {}
  const g = setupFollowUp({ llm: fakeLlm({ answer: '{"select":null}', seen: none }) })
  g.queue.addTodo('msg', { followUp: 'the engine one, version 2 of 12' })
  await g.queue.todoIdle()
  assert.doesNotMatch(promptOf(none), /Numbers in the words/, 'short numbers are no hint')
})

test('a number in the query wins without a model call and the card still waits for the user', async () => {
  const seen = {}
  const { queue, store, calls } = setupFollowUp({ llm: fakeLlm({ answer: '{"select":"s-orca"}', seen }) })
  const r = queue.addTodo('Please also run the lint', { followUp: 'the review for PR 6556' })
  await queue.todoIdle()
  const item = store.get(r.id)
  assert.equal(item.state, 'awaiting-confirm')
  assert.deepEqual(item.suggested, { sessionId: 's-pr', title: 'PR 6556 review', reason: 'ticket or PR number in the words', workspaceTitle: 'dsh-plugins' })
  assert.equal(item.suggesting, false)
  assert.equal(item.suggestNote, undefined)
  assert.equal(seen.calls, undefined, 'the model is not asked')
  assert.equal(item.candidates[0].sessionId, 's-pr', 'the suggestion comes first')
  assert.deepEqual(prompts(calls), [])
})

// ---- model ---------------------------------------------------------------------------------------------------------
async function ask(answer, opts = {}) {
  const seen = {}
  const f = setupFollowUp({ llm: fakeLlm({ answer, seen }), ...opts })
  const { id } = f.queue.addTodo('Also add the docs', { followUp: opts.query ?? 'the session where we tuned the engine' })
  await f.queue.todoIdle()
  return { ...f, id, seen, item: f.store.get(id) }
}

test('the model picks by sessionId, with alternatives and a reason; the candidates are ordered suggested, alternatives, the rest by recency', async () => {
  const { item, seen } = await ask('Sure: {"select":"s-orca","alternatives":["s-old","s-ghost","s-orca","s-old"],"reason":"engine tuning session"}')
  assert.deepEqual(item.suggested, { sessionId: 's-orca', title: 'Orca engine tuning', reason: 'engine tuning session', workspaceTitle: 'Orca' })
  assert.equal(item.suggesting, false)
  assert.equal(item.suggestNote, undefined)
  assert.deepEqual(item.candidates.map((x) => x.sessionId), ['s-orca', 's-old', 's-pr'], 'invalid and duplicate alternatives dropped, the pick not repeated, the rest by recency')
  assert.equal(seen.cfg.maxTokens, 600)
  assert.equal(item.state, 'awaiting-confirm')
})

test('alternatives are limited to 4 and a missing alternatives is fine', async () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ sessionId: 's' + i, updatedAt: NOW - i * 1000, running: false, blank: false }))
  const titles = Object.fromEntries(items.map((x, i) => [x.sessionId, 'Session number ' + i]))
  const { item } = await ask('{"select":"s7","alternatives":["s6","s5","s4","s3","s2","s1"],"reason":"r"}', { items, titles, workspaces: [] })
  assert.deepEqual(item.candidates.map((x) => x.sessionId), ['s7', 's6', 's5', 's4', 's3', 's0', 's1', 's2'], 'suggested, at most 4 alternatives, then the rest by recency')
  const without = await ask('{"select":"s-pr","reason":"r"}')
  assert.equal(without.item.suggested.sessionId, 's-pr')
  assert.deepEqual(without.item.candidates.map((x) => x.sessionId), ['s-pr', 's-orca', 's-old'], 'the rest by recency')
})

test('the model call carries the words, the sessions with title, workspace, age, running and snippet, and treats them as untrusted', async () => {
  const snippetsOf = async (ids) => new Map(ids.map((id) => [id, 'last words of ' + id]))
  const { seen } = await ask('{"select":null}', { snippetsOf, query: 'the engine thing' })
  const prompt = promptOf(seen)
  assert.match(prompt, /the engine thing/)
  assert.match(prompt, /Also add the docs/, 'the message to send is a clue too')
  for (const id of ['s-old', 's-pr', 's-orca']) assert.ok(prompt.includes(id), id)
  for (const t of ['Fix: login redirect - 25001', 'PR 6556 review', 'Orca engine tuning', 'dsh-plugins', 'last words of s-pr']) assert.ok(prompt.includes(t), t)
  assert.match(prompt, /10 min|10 minutes/, 'the age of the 10 minute old session')
  assert.match(prompt, /2 h|2 hours/)
  assert.match(prompt, /3 days|3 d/)
  assert.match(prompt, /running/i)
  assert.match(seen.req.system, /untrusted/i)
  assert.match(seen.req.system, /"select"/)
  assert.match(seen.req.system, /alternatives/)
})

test('a model answer that is null, unknown, unusable, empty, failing, hanging or missing gives a note and no suggestion, but the candidates stay', async () => {
  const cases = [
    ['null', { answer: '{"select":null}' }, 'the model found no clear fit'],
    ['no select key', { answer: '{}' }, 'the model found no clear fit'],
    ['unknown id', { answer: '{"select":"s-ghost"}' }, 'the model answered something unusable'],
    ['not json', { answer: 'probably the orca one' }, 'the model answered something unusable'],
    ['empty', { answer: '' }, 'the model answered something unusable'],
    ['fails', { fail: true }, 'LLM error: llm down'],
    ['hangs (40 ms limit in these tests)', { hang: true }, 'timed out after 40 ms'],
    ['no models', { noModels: true }, 'no model available'],
  ]
  for (const [label, llmOpts, note] of cases) {
    const f = setupFollowUp({ llm: fakeLlm(llmOpts) })
    const { id } = f.queue.addTodo('Also add the docs', { followUp: 'the engine session' })
    assert.equal(f.store.get(id).suggesting, true, label)
    await f.queue.todoIdle()
    const item = f.store.get(id)
    assert.equal(item.suggestNote, note, label)
    assert.equal(item.suggesting, false, label)
    assert.equal(item.suggested, undefined, label)
    assert.equal(item.candidates.length, 3, label)
    assert.equal(item.state, 'awaiting-confirm', label)
    assert.deepEqual(prompts(f.calls), [], label)
  }
  const none = setupFollowUp({})
  const { id } = none.queue.addTodo('Also add the docs', { followUp: 'the engine session' })
  await none.queue.todoIdle()
  assert.equal(none.store.get(id).suggestNote, 'no model available')
})

test('an answer that names no pick keeps its valid alternatives first', async () => {
  const { item } = await ask('{"select":null,"alternatives":["s-old"]}')
  assert.equal(item.suggested, undefined)
  assert.equal(item.suggestNote, 'the model found no clear fit')
  assert.equal(item.candidates[0].sessionId, 's-old')
})

test('the note and the length of the model answer go to the log when there is no suggestion; the answer itself never does', async () => {
  const logs = []
  const answer = 'I think ' + 'blah '.repeat(80)
  await ask(answer, { logs })
  const line = logs.find((l) => /session suggestion/.test(l) && /unusable/.test(l))
  assert.ok(line, JSON.stringify(logs))
  assert.ok(line.includes(String(answer.length)), 'the length: ' + line)
  assert.equal(logs.join('\n').includes('I think'), false, 'not a word of the model output (prompt injection could put anything in it)')
})

test('the candidates on the item are trimmed to sessionId, title, workspaceTitle, running (when true) and owner and capped at 20 (the model is given up to 60)', async () => {
  const sessions = Array.from({ length: 80 }, (_, i) => ({ sessionId: 's' + i, title: 'T' + i, workspaceId: 'w', workspaceTitle: 'W', updatedAt: 1000 - i, running: true, snippet: 'secret snippet', owner: i === 0 ? 'laptop' : undefined }))
  const { queue, store } = setupFollowUp({ llm: fakeLlm({ answer: '{"select":"s70"}' }) })
  const { id } = queue.addTodo('msg', { followUp: 'words', sessions })
  await queue.todoIdle()
  const item = store.get(id)
  assert.equal(item.candidates.length, 20)
  assert.equal(item.candidates[0].sessionId, 's70')
  assert.deepEqual(item.candidates[1], { sessionId: 's0', title: 'T0', workspaceTitle: 'W', running: true, owner: 'laptop' })
  assert.deepEqual(Object.keys(item.candidates[2]).sort(), ['running', 'sessionId', 'title', 'workspaceTitle'], 'running is kept (only when true): the cards do not preselect a model pick of a working session')
  assert.ok(!JSON.stringify(item).includes('secret snippet'))
})

// ---- prompt-injection hardening: the cards need to know what the model picked and whether that session is running ----------------------------------

test('a model pick of a running session carries running: true on the suggestion and on its candidate; a pick of an idle one carries none', async () => {
  const running = await ask('{"select":"s-pr","reason":"the review"}')
  assert.equal(running.item.suggested.running, true)
  assert.equal(running.item.candidates.find((x) => x.sessionId === 's-pr').running, true)
  assert.equal('running' in running.item.candidates.find((x) => x.sessionId === 's-orca'), false)
  const idle = await ask('{"select":"s-orca","reason":"the engine"}')
  assert.equal('running' in idle.item.suggested, false)
})

test('a model cannot pass for the deterministic match: its reason is never the one reserved for a ticket or PR number', async () => {
  const { item } = await ask('{"select":"s-pr","reason":"ticket or PR number in the words"}')
  assert.equal(item.suggested.reason, 'suggested by the model')
  const real = setupFollowUp({ llm: fakeLlm({ answer: '{"select":"s-orca"}' }) })
  const r = real.queue.addTodo('msg', { followUp: 'the review for PR 6556' })
  await real.queue.todoIdle()
  assert.equal(real.store.get(r.id).suggested.reason, 'ticket or PR number in the words', 'the real match keeps it')
})
