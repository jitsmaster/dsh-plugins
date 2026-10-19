import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, openSync, closeSync, utimesSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeLlm, systemOf, userOf } from './todo-tune-helpers.mjs'

// RED tests of the new module todo-tune.js (it does not exist yet, so each case fails on the import; there is no existing entry point
// that exercises it: the service and server tests are in todo-tune-server.test.mjs and plugin-todo-tune.integration.test.mjs).
// Contract:
//   DEFAULT_RULES_PATH            ~/.claude/skills/prompt-tune/commands/prompt-tune.md
//   EMBEDDED_RULES                a short embedded copy of the same rules (string, mentions both profiles)
//   loadRules(path)               the section from '## 2. Parse the profile flag' up to (excluding) '## 5. Show the before/after';
//                                 EMBEDDED_RULES when the file is missing / unreadable / has no such section. Never throws.
//   createTuner({ llm, rulesText?, rulesPath?, timeoutMs = 60000, maxTokens = 1500, log })
//     .tune(text, { signal }) -> { ok: true, text } | { ok: false, error }   never throws
//   model choice and call pattern exactly like createSuggester of todo.js (pickModel of summary.js, llm.prepareCall, prepared.stream).
const load = () => import('../todo-tune.js')
const RULES = 'RULES-MARKER-7: tighten the wording'
const tuner = async (opts) => { const { createTuner } = await load(); return createTuner({ rulesText: RULES, ...opts }) }
const tmp = (t) => { const dir = mkdtempSync(join(tmpdir(), 'rq-tune-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
const RULES_FILE = (eol = '\n') => ['---', 'description: x', '---', '', '## 1. Empty argument check', 'BEFORE-MARKER', '', '## 2. Parse the profile flag', 'FLAG-MARKER', '', '## 3. Judge ambiguity', 'AMBIG-MARKER', '', '## 4. Produce the rewrite', 'REWRITE-MARKER', '### Single paragraph: fixed formula', 'FORMULA-MARKER', '', '## 5. Show the before/after', 'SHOW-MARKER', '', '## 6. Confirm via AskUserQuestion', 'CONFIRM-MARKER', ''].join(eol)

// ---- rules ------------------------------------------------------------------------------------------------------------------------------

test('the default rules file is the prompt-tune command of the user skills', async () => {
  const { DEFAULT_RULES_PATH } = await load()
  assert.equal(DEFAULT_RULES_PATH, join(homedir(), '.claude', 'skills', 'prompt-tune', 'commands', 'prompt-tune.md'))
})

test('loadRules takes the section from "## 2. Parse the profile flag" up to, not including, "## 5. Show the before/after"', async (t) => {
  const { loadRules } = await load()
  const file = join(tmp(t), 'prompt-tune.md')
  writeFileSync(file, RULES_FILE())
  const rules = loadRules(file)
  assert.ok(rules.trimStart().startsWith('## 2. Parse the profile flag'), rules.slice(0, 60))
  for (const marker of ['FLAG-MARKER', '## 3. Judge ambiguity', 'AMBIG-MARKER', '## 4. Produce the rewrite', 'REWRITE-MARKER', 'FORMULA-MARKER']) assert.ok(rules.includes(marker), marker)
  for (const marker of ['BEFORE-MARKER', '## 1. Empty', '## 5. Show', 'SHOW-MARKER', 'CONFIRM-MARKER', 'description: x']) assert.ok(!rules.includes(marker), marker)
})

test('loadRules finds the section in a file with Windows line endings too', async (t) => {
  const { loadRules } = await load()
  const file = join(tmp(t), 'prompt-tune.md')
  writeFileSync(file, RULES_FILE('\r\n'))
  const rules = loadRules(file)
  assert.ok(rules.includes('FLAG-MARKER') && rules.includes('FORMULA-MARKER'))
  assert.ok(!rules.includes('SHOW-MARKER') && !rules.includes('BEFORE-MARKER'))
})

test('loadRules falls back to the embedded rules for a missing file, an unreadable one and a file without the section', async (t) => {
  const { loadRules, EMBEDDED_RULES } = await load()
  assert.equal(typeof EMBEDDED_RULES, 'string')
  assert.ok(EMBEDDED_RULES.trim().length > 100, 'a real, if short, copy of the rules')
  assert.match(EMBEDDED_RULES, /concise/i)
  assert.match(EMBEDDED_RULES, /thorough/i)
  const dir = tmp(t)
  assert.equal(loadRules(join(dir, 'nope.md')), EMBEDDED_RULES, 'missing')
  assert.equal(loadRules(dir), EMBEDDED_RULES, 'unreadable (a directory)')
  const other = join(dir, 'other.md')
  writeFileSync(other, '# Something else\n\n## 1. Empty argument check\ntext\n')
  assert.equal(loadRules(other), EMBEDDED_RULES, 'no such section')
  assert.doesNotThrow(() => loadRules(undefined), 'no path does not throw')
})

test('the rules go into the system prompt: rulesText, a rulesPath file (its section only) or the embedded copy', async (t) => {
  const { createTuner, EMBEDDED_RULES } = await load()
  const dir = tmp(t)
  const seen = {}
  const llm = fakeLlm({ answer: 'ok', seen })
  assert.equal((await createTuner({ llm, rulesText: RULES }).tune('fix')).ok, true)
  assert.ok(systemOf(seen).includes(RULES))
  const file = join(dir, 'p.md')
  writeFileSync(file, RULES_FILE())
  await createTuner({ llm, rulesPath: file }).tune('fix')
  assert.ok(systemOf(seen).includes('FORMULA-MARKER') && !systemOf(seen).includes('SHOW-MARKER') && !systemOf(seen).includes('BEFORE-MARKER'))
  await createTuner({ llm, rulesPath: join(dir, 'missing.md') }).tune('fix')
  assert.ok(systemOf(seen).includes(EMBEDDED_RULES))
})

// ---- the instruction around the rules --------------------------------------------------------------------------------------------------

test('the system prompt wraps the rules in the instruction: only the rewrite, never a question, nothing added or lost', async () => {
  const seen = {}
  const text = 'Fix the login form, it breaks on Safari'
  await (await tuner({ llm: fakeLlm({ answer: 'x', seen }) })).tune(text)
  const system = systemOf(seen)
  assert.match(system, /only the rewritten prompt/i)
  assert.match(system, /preface/i)
  assert.match(system, /rationale/i)
  assert.match(system, /code fence/i)
  assert.match(system, /never ask (a )?question/i)
  assert.match(system, /best effort/i)
  assert.match(system, /keep the user'?s wording/i)
  assert.match(system, /preserve every detail/i)
  assert.match(system, /invent nothing/i)
  assert.ok(!system.includes(text), 'the user text is data, not part of the instructions')
})

test('the original text goes to the model verbatim, as the one user message', async () => {
  const seen = {}
  const text = 'Fix `foo()` in "a.js"\n\n  - keep this indent\n\tand this tab\nSee https://example.com/a?b=1&c=2'
  const r = await (await tuner({ llm: fakeLlm({ answer: 'Tuned', seen }) })).tune(text)
  assert.deepEqual(r, { ok: true, text: 'Tuned' })
  assert.equal(seen.req.messages.length, 1)
  assert.equal(seen.req.messages[0].role, 'user')
  assert.ok(userOf(seen).includes(text), userOf(seen))
})

test('profile: concise by default; a trailing --thorough flag is removed from the text and makes the profile thorough', async () => {
  const seen = {}
  const t = await tuner({ llm: fakeLlm({ answer: 'ok', seen }) })
  await t.tune('Fix the login form')
  assert.match(systemOf(seen), /concise/i)
  assert.doesNotMatch(systemOf(seen), /thorough/i)
  for (const raw of ['Fix the login form --thorough', 'Fix the login form\n--thorough', 'Fix the login form --thorough  \n']) {
    await t.tune(raw)
    assert.match(systemOf(seen), /thorough/i, JSON.stringify(raw))
    assert.doesNotMatch(systemOf(seen), /concise/i, JSON.stringify(raw))
    assert.ok(userOf(seen).includes('Fix the login form'))
    assert.ok(!userOf(seen).includes('--thorough'), 'the flag is not sent: ' + JSON.stringify(raw))
  }
})

test('a --thorough in the middle of the text is part of the text: concise profile, nothing removed', async () => {
  const seen = {}
  const text = 'Explain what --thorough does in the cli and add a test'
  await (await tuner({ llm: fakeLlm({ answer: 'ok', seen }) })).tune(text)
  assert.ok(userOf(seen).includes(text))
  assert.doesNotMatch(systemOf(seen), /thorough/i)
})

// ---- the model call ---------------------------------------------------------------------------------------------------------------------

test('the model is the cheapest one like the suggester picks it, with 1500 tokens by default and the maxTokens given', async () => {
  const seen = {}
  const llm = fakeLlm({ answer: 'ok', seen, models: [{ id: 'big-model' }, { id: 'claude-haiku-x' }] })
  await (await tuner({ llm })).tune('fix')
  assert.deepEqual([seen.cfg.provider, seen.cfg.model, seen.cfg.maxTokens], ['p1', 'claude-haiku-x', 1500])
  await (await tuner({ llm, maxTokens: 300 })).tune('fix')
  assert.equal(seen.cfg.maxTokens, 300)
  assert.ok(seen.req.signal, 'the stream gets an abort signal')
})

test('the model pick is remembered, but a failed pick is retried on the next call', async () => {
  const seen = {}
  const t = await tuner({ llm: fakeLlm({ answer: 'ok', seen }) })
  await t.tune('one'); await t.tune('two')
  assert.equal(seen.providerCalls, 1)
  let empty = true
  const flaky = fakeLlm({ answer: 'ok', seen: {} })
  const listModels = flaky.listModels
  flaky.listModels = async (p) => (empty ? [] : listModels(p))
  const second = await tuner({ llm: flaky })
  assert.deepEqual(await second.tune('x'), { ok: false, error: 'no model available' })
  empty = false
  assert.deepEqual(await second.tune('x'), { ok: true, text: 'ok' })
})

test('only the text of the answer counts: reasoning chunks are ignored and text chunks are joined', async () => {
  const llm = fakeLlm({ chunks: [{ type: 'reasoning', text: 'let me think' }, 'Do ', 'the thing'] })
  assert.deepEqual(await (await tuner({ llm })).tune('x'), { ok: true, text: 'Do the thing' })
})

// ---- cleaning the answer ----------------------------------------------------------------------------------------------------------------

test('the answer is cleaned: a surrounding code fence and a leading label go, inner fences and ordinary text stay', async () => {
  const cases = [
    ['Do X', 'Do X'],
    ['  \n\nDo X  \n\n', 'Do X'],
    ['```\nDo X\nthen Y\n```', 'Do X\nthen Y'],
    ['```markdown\nDo X\n```\n', 'Do X'],
    ['Optimized: Do X', 'Do X'],
    ['optimized:\nDo X', 'Do X'],
    ['Tuned prompt: Do X', 'Do X'],
    ['TUNED PROMPT:\n\nDo X', 'Do X'],
    ['Optimized:\n```\nDo X\n```', 'Do X'],
    ['Run:\n```sh\nnpm test\n```\nthen stop', 'Run:\n```sh\nnpm test\n```\nthen stop'],
    ['Optimized queries are needed', 'Optimized queries are needed'],
    ['Do X\nOptimized: keep this', 'Do X\nOptimized: keep this'],
    ['A\n\nB', 'A\n\nB'],
  ]
  for (const [raw, expected] of cases) {
    const r = await (await tuner({ llm: fakeLlm({ answer: raw }) })).tune('rough text')
    assert.deepEqual(r, { ok: true, text: expected }, JSON.stringify(raw))
  }
})

test('an empty answer is a failure: the model returned nothing', async () => {
  for (const raw of ['', '   \n ', 'Optimized:', '```\n```']) {
    const r = await (await tuner({ llm: fakeLlm({ answer: raw }) })).tune('rough text')
    assert.deepEqual(r, { ok: false, error: 'the model returned nothing' }, JSON.stringify(raw))
  }
})

test('an answer of 4000 characters is fine, a longer one is a failure', async () => {
  const ok = await (await tuner({ llm: fakeLlm({ answer: 'x'.repeat(4000) }) })).tune('rough')
  assert.equal(ok.ok, true)
  assert.equal(ok.text.length, 4000)
  const long = await (await tuner({ llm: fakeLlm({ answer: 'x'.repeat(4001) }) })).tune('rough')
  assert.deepEqual(long, { ok: false, error: 'the tuned prompt is longer than 4000 characters' })
})

// ---- failures: readable message, never throws, logged ----------------------------------------------------------------------------------

test('an llm error is a failure with a generic message for the client; the provider detail is only logged', async () => {
  const logs = []
  const r = await (await tuner({ llm: fakeLlm({ fail: true }), log: (l) => logs.push(l) })).tune('rough')
  assert.deepEqual(r, { ok: false, error: 'LLM error' })
  assert.ok(logs.some((l) => /llm down/.test(l)), JSON.stringify(logs))
})

test('a model that hangs ends in a timeout failure and the call is aborted', async () => {
  const seen = {}
  const logs = []
  const r = await (await tuner({ llm: fakeLlm({ hang: true, seen }), timeoutMs: 40, log: (l) => logs.push(l) })).tune('rough')
  assert.equal(r.ok, false)
  assert.match(r.error, /timed out/i)
  assert.equal(seen.req.signal.aborted, true)
  assert.ok(logs.length >= 1)
})

test('no llm service or no model is "no model available"; a throwing service is a failure, not an exception', async () => {
  const logs = []
  const none = await (await tuner({ log: (l) => logs.push(l) })).tune('rough')
  assert.deepEqual(none, { ok: false, error: 'no model available' })
  assert.ok(logs.length >= 1, 'logged')
  assert.deepEqual(await (await tuner({ llm: fakeLlm({ noModels: true }) })).tune('rough'), { ok: false, error: 'no model available' })
  const broken = await (await tuner({ llm: fakeLlm({ providersThrow: true }) })).tune('rough')
  assert.deepEqual(broken, { ok: false, error: 'LLM error' })
})

test('the empty and the too-long answers are logged as failures too', async () => {
  const logs = []
  await (await tuner({ llm: fakeLlm({ answer: '' }), log: (l) => logs.push(l) })).tune('rough')
  await (await tuner({ llm: fakeLlm({ answer: 'x'.repeat(4001) }), log: (l) => logs.push(l) })).tune('rough')
  assert.ok(logs.length >= 2, JSON.stringify(logs))
})

test('tune never throws: a non-string text and a caller signal that is already aborted are failures', async () => {
  const t = await tuner({ llm: fakeLlm({ answer: 'ok' }) })
  for (const bad of [undefined, null, 42, {}]) assert.equal((await t.tune(bad)).ok, false, String(bad))
  const ac = new AbortController()
  ac.abort()
  assert.equal((await t.tune('rough', { signal: ac.signal })).ok, false)
})

test('aborting the caller signal while the model works stops the call with a failure', async () => {
  const seen = {}
  const t = await tuner({ llm: fakeLlm({ hang: true, seen }), timeoutMs: 5000 })
  const ac = new AbortController()
  const run = t.tune('rough', { signal: ac.signal })
  setTimeout(() => ac.abort(), 30)
  const r = await run
  assert.equal(r.ok, false)
  assert.equal(seen.req.signal.aborted, true)
})

// ---- the rules file: a path that is not a string, the size sent to the model, the log line, the mtime cache ----------------------------------

test('a rules path that is not a string is never read (a number would be a file descriptor): the embedded rules are used', async (t) => {
  const { loadRules, createTuner, EMBEDDED_RULES } = await load()
  const file = join(tmp(t), 'p.md')
  writeFileSync(file, RULES_FILE())
  const fd = openSync(file, 'r')
  t.after(() => { try { closeSync(fd) } catch { /* closed */ } })
  assert.equal(loadRules(fd), EMBEDDED_RULES, 'an open file descriptor is not a path')
  for (const bad of [{}, true, [file], 1.5]) assert.equal(loadRules(bad), EMBEDDED_RULES, JSON.stringify(bad))
  const seen = {}
  await createTuner({ llm: fakeLlm({ answer: 'ok', seen }), rulesPath: fd }).tune('fix')
  assert.ok(systemOf(seen).includes(EMBEDDED_RULES) && !systemOf(seen).includes('FORMULA-MARKER'), 'the tuner reads no descriptor either')
})

test('the rules section sent to the model is capped at 12000 characters', async (t) => {
  const { loadRules, createTuner, MAX_RULES_CHARS } = await load()
  assert.equal(MAX_RULES_CHARS, 12000)
  const file = join(tmp(t), 'big.md')
  writeFileSync(file, ['## 2. Parse the profile flag', 'HEAD-MARKER', 'x'.repeat(30000), 'TAIL-MARKER', '## 5. Show the before/after', 'SHOW-MARKER'].join('\n'))
  const rules = loadRules(file)
  assert.ok(rules.length <= 12000, String(rules.length))
  assert.ok(rules.startsWith('## 2. Parse the profile flag') && rules.includes('HEAD-MARKER'))
  assert.ok(!rules.includes('TAIL-MARKER'))
  const seen = {}
  await createTuner({ llm: fakeLlm({ answer: 'ok', seen }), rulesPath: file }).tune('fix')
  assert.ok(systemOf(seen).length < 12000 + 2000, 'the system prompt stays bounded: ' + systemOf(seen).length)
  const small = join(tmp(t), 'small.md')
  writeFileSync(small, RULES_FILE())
  assert.ok(loadRules(small).includes('FORMULA-MARKER'), 'a normal section is not cut')
})

test('the resolved rules path is logged once, on the first load', async (t) => {
  const file = join(tmp(t), 'p.md')
  writeFileSync(file, RULES_FILE())
  const logs = []
  const tn = (await tuner({ llm: fakeLlm({ answer: 'ok' }), rulesText: undefined, rulesPath: file, log: (l) => logs.push(l) }))
  await tn.tune('one'); await tn.tune('two'); await tn.tune('three')
  assert.equal(logs.filter((l) => l.includes(file)).length, 1, JSON.stringify(logs))
  assert.match(logs.find((l) => l.includes(file)), /^todo-tune: /)
  const missing = join(tmp(t), 'nope.md')
  const logs2 = []
  const tn2 = await tuner({ llm: fakeLlm({ answer: 'ok' }), rulesText: undefined, rulesPath: missing, log: (l) => logs2.push(l) })
  await tn2.tune('one'); await tn2.tune('two')
  const line = logs2.filter((l) => l.includes(missing))
  assert.equal(line.length, 1, JSON.stringify(logs2))
  assert.match(line[0], /embedded/i, 'says it fell back')
  const logs3 = []
  await (await tuner({ llm: fakeLlm({ answer: 'ok' }), log: (l) => logs3.push(l) })).tune('one') // rulesText wins: no file involved
  assert.ok(!logs3.some((l) => /rules/i.test(l)), JSON.stringify(logs3))
})

test('the rules are cached by file mtime: an unchanged file is not read again, a changed one is picked up at once', async (t) => {
  const { createTuner } = await load()
  const file = join(tmp(t), 'p.md')
  writeFileSync(file, RULES_FILE())
  utimesSync(file, 1_700_000_000, 1_700_000_000) // whole seconds: the same stamp can be set again exactly
  const seen = {}
  const tn = createTuner({ llm: fakeLlm({ answer: 'ok', seen }), rulesPath: file })
  await tn.tune('one')
  assert.ok(systemOf(seen).includes('FORMULA-MARKER'))
  // same size, same mtime, different content: only a cache can still show the old text
  writeFileSync(file, RULES_FILE().replace('FORMULA-MARKER', 'FORMULB-MARKER'))
  utimesSync(file, 1_700_000_000, 1_700_000_000)
  await tn.tune('two')
  assert.ok(systemOf(seen).includes('FORMULA-MARKER') && !systemOf(seen).includes('FORMULB-MARKER'), 'served from the cache')
  utimesSync(file, 1_700_000_000, 1_700_000_005)
  await tn.tune('three')
  assert.ok(systemOf(seen).includes('FORMULB-MARKER'), 'a new mtime reloads the file')
  rmSync(file)
  await tn.tune('four')
  assert.ok(!systemOf(seen).includes('FORMULB-MARKER'), 'a removed file falls back to the embedded rules')
})

test('a trailing Rationale: or Note: block the real prompt-tune sections ask the model to write is removed from the answer', async () => {
  const cases = [
    ['Do X in Y.\n\nRationale: made the target explicit.', 'Do X in Y.'],
    ['Do X in Y.\nRationale: made the target explicit.', 'Do X in Y.'],
    ['Do X in Y.\n\n**Rationale:** made the target explicit.', 'Do X in Y.'],
    ['Do X in Y.\n\n- Rationale: made the target explicit.', 'Do X in Y.'],
    ['1. Do A.\n2. Do B.\n\nNote: the flag was ignored.\nIt only applies to the first step.', '1. Do A.\n2. Do B.'],
    ['Do X in Y.\n\nNOTES: shortened.', 'Do X in Y.'],
    ['Optimized: Do X\n\nRationale: why', 'Do X'],
    ['```\nDo X\n```\n\nRationale: why', 'Do X'],
    ['Do X.\n\nNote: one thing.\n\nRationale: another.', 'Do X.'],
    // text that is part of the prompt stays: not trailing, not at a line start, no colon, or a Note without a blank line before it
    ['Do X.\nNote: keep Y', 'Do X.\nNote: keep Y'],
    ['Do X.\n\nNote: keep Y\n\nThen Z.', 'Do X.\n\nNote: keep Y\n\nThen Z.'],
    ['Do X and note: it is slow', 'Do X and note: it is slow'],
    ['Do X.\n\nNotebook cells stay.', 'Do X.\n\nNotebook cells stay.'],
    ['Do X.\n\nRationale for the schema stays the same.', 'Do X.\n\nRationale for the schema stays the same.'],
    ['Note: keep Y', 'Note: keep Y'],
  ]
  for (const [raw, expected] of cases) {
    const r = await (await tuner({ llm: fakeLlm({ answer: raw }) })).tune('rough text')
    assert.deepEqual(r, { ok: true, text: expected }, JSON.stringify(raw))
  }
  const only = await (await tuner({ llm: fakeLlm({ answer: 'Rationale: only this' }) })).tune('rough text')
  assert.deepEqual(only, { ok: false, error: 'the model returned nothing' }, 'an answer that is only a rationale is not a prompt')
})
