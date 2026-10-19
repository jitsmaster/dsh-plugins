/**
 * Unit tests for dsh-hooks-tts/pr-schedule.js: the module that represents a PR comment poll as ONE visible DSH
 * Automation (schedule) task per "PR <id>" session.
 *
 * Contract under test:
 *   createPrSchedule({ getSchedule, stateDir, trace?, intervalSeconds? = 600 }) -> {
 *     available(): boolean                       // a schedule service is currently reachable
 *     ensureTask(sessionId, prId): Promise<string|undefined>   // task id; undefined when no service. Serialized per session, idempotent.
 *     deleteTasks(sessionId): Promise<void>                    // deletes + retires every task of ours for the session
 *     classifyTick(text, sessionId?): { format: 'batch'|'single'|null,
 *                           ours:    [{ id, sessionId, prId }],   // live tasks of ours present in the tick
 *                           retired: [id],                        // ids we deleted earlier, or ones carrying our marker for sessionId (a late tick: ignore)
 *                           others:  [id],                        // reminders that are not ours
 *                           remainder: string|null }              // the tick text without our/retired entries; null when nothing else is left
 *   }
 *   getSchedule is a function returning the ctx.get('schedule') service (or undefined when absent).
 *   Registry file: <stateDir>/pr-poll-tasks.json. Task title "PR <id> comment poll", prompt ends with the marker line
 *   "[dsh-hooks-tts pr-poll v1 session=<sid> pr=<id>]". Schedule API shapes are the real ones (see pr-schedule-helpers.mjs).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeSchedule, marker, taskTitle, renderBatch, renderSingle, flush } from './pr-schedule-helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// The module is imported lazily so that every test fails on its own (rather than one suite-level load error).
async function make({ absent = false, dir = mkdtempSync(join(tmpdir(), 'prs-')), schedule = fakeSchedule(), ...extra } = {}) {
  const { createPrSchedule } = await import('../pr-schedule.js')
  const logs = []
  const api = createPrSchedule({ getSchedule: () => (absent ? undefined : schedule.service), stateDir: dir, trace: (line) => logs.push(String(line)), ...extra })
  return { api, schedule, dir, logs, again: (more = {}) => make({ dir, schedule, ...more }) }
}
const registryPath = (dir) => join(dir, 'pr-poll-tasks.json')

// ---- ensureTask: creating the task ----

test('ensureTask creates one every-10-minutes task titled "PR <id> comment poll" for the session', async () => {
  const { api, schedule } = await make()
  const id = await api.ensureTask('s1', '5')
  assert.equal(schedule.calls.create.length, 1)
  const { sessionId, request } = schedule.calls.create[0]
  assert.equal(sessionId, 's1')
  assert.equal(request.title, taskTitle('5'))
  assert.equal(request.every_seconds, 600)
  assert.equal(schedule.tasksOf('s1').length, 1)
  assert.equal(id, schedule.tasksOf('s1')[0].id)
})

test('the task prompt is the fallback instruction and ends with the marker line', async () => {
  const { api, schedule } = await make()
  await api.ensureTask('s1', '5')
  const { prompt } = schedule.calls.create[0].request
  assert.match(prompt, /Check Azure DevOps pull request 5 for review comments you have not handled yet\./)
  assert.match(prompt, /ado-pr-implement/)
  assert.match(prompt, /PR-WAIT: 5/)
  assert.equal(prompt.trim().split('\n').at(-1), marker('s1', '5'))
})

test('ensureTask is idempotent: a second call for the same session and PR creates nothing and returns the same id', async () => {
  const { api, schedule } = await make()
  const first = await api.ensureTask('s1', '5')
  const second = await api.ensureTask('s1', '5')
  assert.equal(schedule.calls.create.length, 1)
  assert.equal(second, first)
})

test('concurrent ensureTask calls for one session are serialized into a single create', async () => {
  const { api, schedule } = await make()
  const open = schedule.gate('create')
  const a = api.ensureTask('s1', '5')
  const b = api.ensureTask('s1', '5')
  await flush()
  open()
  const [ida, idb] = await Promise.all([a, b])
  assert.equal(schedule.calls.create.length, 1)
  assert.equal(schedule.tasksOf('s1').length, 1)
  assert.equal(ida, idb)
})

test('a slow create for one session does not block another session', async () => {
  const { api, schedule } = await make()
  const open = schedule.gate('create')
  const slow = api.ensureTask('s1', '5')
  await flush()
  // The fake service serializes create() itself, so only the plugin's own queue is being tested: s2 must at least be
  // started (its create call is made) while s1 is still waiting.
  const other = api.ensureTask('s2', '6')
  await flush()
  assert.deepEqual(schedule.calls.create.map((c) => c.sessionId).sort(), ['s1', 's2'])
  open()
  await Promise.all([slow, other])
  assert.equal(schedule.tasksOf('s2').length, 1)
})

test('ensureTask for a different PR in the same session replaces the old task', async () => {
  const { api, schedule } = await make()
  const old = await api.ensureTask('s1', '5')
  await api.ensureTask('s1', '7')
  const tasks = schedule.tasksOf('s1')
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].title, taskTitle('7'))
  assert.notEqual(tasks[0].id, old)
  assert.ok(schedule.calls.delete.some((d) => d.id === old))
})

test('ensureTask recreates the task when the user deleted it (no suppression)', async () => {
  const { api, schedule } = await make()
  const first = await api.ensureTask('s1', '5')
  schedule.userDelete(first)
  const second = await api.ensureTask('s1', '5')
  assert.equal(schedule.calls.create.length, 2)
  assert.notEqual(second, first)
  assert.equal(schedule.tasksOf('s1').length, 1)
})

test('ensureTask without a schedule service does nothing and does not throw', async () => {
  const { api, schedule, dir } = await make({ absent: true })
  assert.equal(api.available(), false)
  assert.equal(await api.ensureTask('s1', '5'), undefined)
  assert.equal(schedule.calls.create.length, 0)
  assert.equal(existsSync(registryPath(dir)), false)
})

test('available() is true when a schedule service exists', async () => {
  const { api } = await make()
  assert.equal(api.available(), true)
})

test('a failing create leaves no stale registry entry and the next ensureTask retries', async () => {
  const { api, schedule, dir } = await make()
  schedule.hooks.createError = Object.assign(new Error('boom-create'), { once: true })
  await assert.rejects(api.ensureTask('s1', '5'), /boom-create/)
  assert.equal(schedule.tasksOf('s1').length, 0)
  const afterFailure = existsSync(registryPath(dir)) ? JSON.parse(readFileSync(registryPath(dir), 'utf8')).tasks : []
  assert.deepEqual(afterFailure, [], 'the registry file holds no entry for the task that was never created')
  const id = await api.ensureTask('s1', '5')
  assert.equal(schedule.calls.create.length, 2)
  assert.equal(schedule.tasksOf('s1').length, 1)
  assert.equal(id, schedule.tasksOf('s1')[0].id)
})

// ---- adoption and registry ----

test('ensureTask adopts an existing task with the exact title and marker instead of creating a second one', async () => {
  const { api, schedule } = await make()
  const seeded = await schedule.service.create('s1', { title: taskTitle('5'), prompt: `some older wording\n${marker('s1', '5')}`, every_seconds: 600 })
  schedule.calls.create.length = 0
  const id = await api.ensureTask('s1', '5')
  assert.equal(id, seeded.id)
  assert.equal(schedule.calls.create.length, 0)
})

test('ensureTask does not adopt a task with the right title but another marker, or no marker', async () => {
  const { api, schedule } = await make()
  await schedule.service.create('s1', { title: taskTitle('5'), prompt: `mine\n${marker('other-session', '5')}`, every_seconds: 600 })
  await schedule.service.create('s1', { title: taskTitle('5'), prompt: 'a user task that only shares the title', every_seconds: 600 })
  schedule.calls.create.length = 0
  await api.ensureTask('s1', '5')
  assert.equal(schedule.calls.create.length, 1)
})

test('the registry file records the task and survives a restart: a new instance neither creates nor forgets it', async () => {
  const { api, schedule, dir, again } = await make()
  const id = await api.ensureTask('s1', '5')
  assert.ok(existsSync(registryPath(dir)), 'pr-poll-tasks.json is written next to settings.json')
  assert.ok(readFileSync(registryPath(dir), 'utf8').includes(id))
  schedule.calls.create.length = 0
  const next = await again()
  assert.equal(await next.api.ensureTask('s1', '5'), id)
  assert.equal(schedule.calls.create.length, 0)
  // and it still recognises its own task in a tick without ensureTask having run in this process
  const third = await again()
  assert.deepEqual(third.api.classifyTick(renderBatch([{ id, prompt: 'p' }])).ours, [{ id, sessionId: 's1', prId: '5' }])
})

test('a corrupt registry file is ignored and ensureTask still works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prs-'))
  writeFileSync(registryPath(dir), '{ not json')
  const { api, schedule } = await make({ dir })
  const id = await api.ensureTask('s1', '5')
  assert.equal(id, schedule.tasksOf('s1')[0].id)
})

// ---- deleteTasks ----

test('deleteTasks removes the session\'s task and its registry entry', async () => {
  const { api, schedule, dir } = await make()
  const id = await api.ensureTask('s1', '5')
  await api.deleteTasks('s1')
  assert.equal(schedule.tasksOf('s1').length, 0)
  assert.ok(schedule.calls.delete.some((d) => d.id === id && d.sessionId === 's1'))
  assert.equal(readFileSync(registryPath(dir), 'utf8').includes(id), false)
})

test('deleteTasks is idempotent and a no-op for a session without a task', async () => {
  const { api, schedule } = await make()
  await api.deleteTasks('nobody')
  await api.ensureTask('s1', '5')
  await api.deleteTasks('s1')
  await api.deleteTasks('s1')
  assert.equal(schedule.tasksOf('s1').length, 0)
})

test('deleteTasks only touches our tasks, never the user\'s own reminders in the same session', async () => {
  const { api, schedule } = await make()
  await api.ensureTask('s1', '5')
  const foreign = schedule.addForeign('s1', { title: taskTitle('5'), prompt: 'same title but no marker' })
  const other = schedule.addForeign('s1', { title: 'standup' })
  await api.deleteTasks('s1')
  assert.deepEqual(schedule.tasksOf('s1').map((t) => t.id).sort(), [foreign.id, other.id].sort())
})

test('deleteTasks also removes an unregistered task found by its marker (registry lost)', async () => {
  const { api, schedule } = await make()
  await schedule.service.create('s1', { title: taskTitle('5'), prompt: `orphan\n${marker('s1', '5')}`, every_seconds: 600 })
  await api.deleteTasks('s1')
  assert.equal(schedule.tasksOf('s1').length, 0)
})

test('deleteTasks queued behind an in-flight ensureTask ends with no task left', async () => {
  const { api, schedule } = await make()
  const open = schedule.gate('create')
  const ensure = api.ensureTask('s1', '5')
  await flush()
  const del = api.deleteTasks('s1')
  await flush()
  open()
  await Promise.all([ensure.catch(() => {}), del])
  assert.equal(schedule.tasksOf('s1').length, 0)
})

test('a failing delete keeps the registry entry so a later deleteTasks retries', async () => {
  const { api, schedule } = await make()
  await api.ensureTask('s1', '5')
  schedule.hooks.deleteError = Object.assign(new Error('boom-delete'), { once: true })
  await api.deleteTasks('s1').then(() => {}, () => {})
  assert.equal(schedule.tasksOf('s1').length, 1)
  await api.deleteTasks('s1')
  assert.equal(schedule.tasksOf('s1').length, 0)
})

test('deleteTasks without a schedule service does not throw', async () => {
  const { api } = await make({ absent: true })
  await api.deleteTasks('s1')
})

// ---- classifyTick ----

test('classifyTick recognises our task in the real recurring batch format', async () => {
  const { api } = await make()
  const id = await api.ensureTask('s1', '5')
  const out = api.classifyTick(renderBatch([{ id, prompt: 'whatever' }]))
  assert.equal(out.format, 'batch')
  assert.deepEqual(out.ours, [{ id, sessionId: 's1', prId: '5' }])
  assert.deepEqual(out.others, [])
  assert.deepEqual(out.retired, [])
  assert.equal(out.remainder, null)
})

test('classifyTick recognises our task in the real single-reminder format', async () => {
  const { api } = await make()
  const id = await api.ensureTask('s1', '5')
  const out = api.classifyTick(renderSingle({ id, prompt: 'whatever' }))
  assert.equal(out.format, 'single')
  assert.deepEqual(out.ours, [{ id, sessionId: 's1', prId: '5' }])
  assert.equal(out.remainder, null)
})

test('classifyTick: a batch with our entry and another reminder is rebuilt without our entry', async () => {
  const { api, schedule } = await make()
  const id = await api.ensureTask('s1', '5')
  const other = schedule.addForeign('s1')
  const mine = { id, prompt: 'p', occurrenceAt: '2026-10-16T22:50:00.000Z' }
  const theirs = { id: other.id, prompt: other.prompt, occurrenceAt: '2026-10-16T23:00:00.000Z' }
  const out = api.classifyTick(renderBatch([mine, theirs]))
  assert.equal(out.format, 'batch')
  assert.deepEqual(out.ours.map((o) => o.id), [id])
  assert.deepEqual(out.others, [other.id])
  assert.equal(out.remainder, renderBatch([theirs]))
})

test('classifyTick: a batch of only other reminders is not ours and its text is kept as is', async () => {
  const { api, schedule } = await make()
  await api.ensureTask('s1', '5')
  const other = schedule.addForeign('s1')
  const text = renderBatch([{ id: other.id, prompt: other.prompt }])
  const out = api.classifyTick(text)
  assert.deepEqual(out.ours, [])
  assert.deepEqual(out.others, [other.id])
  assert.equal(out.remainder, text)
})

test('classifyTick: a single reminder that is not ours is left as is', async () => {
  const { api } = await make()
  const text = renderSingle({ id: 'schedule-someone-else', prompt: 'x' })
  const out = api.classifyTick(text)
  assert.equal(out.format, 'single')
  assert.deepEqual(out.ours, [])
  assert.deepEqual(out.others, ['schedule-someone-else'])
  assert.equal(out.remainder, text)
})

test('classifyTick: a tick for a task we already deleted is retired, not ours, and is dropped', async () => {
  const { api } = await make()
  const id = await api.ensureTask('s1', '5')
  await api.deleteTasks('s1')
  const out = api.classifyTick(renderBatch([{ id, prompt: 'late' }]))
  assert.deepEqual(out.ours, [])
  assert.deepEqual(out.retired, [id])
  assert.equal(out.remainder, null)
})

test('classifyTick: a batch mixing a retired id and another reminder keeps only the other reminder', async () => {
  const { api, schedule } = await make()
  const id = await api.ensureTask('s1', '5')
  await api.deleteTasks('s1')
  const other = schedule.addForeign('s1')
  const theirs = { id: other.id, prompt: other.prompt }
  const out = api.classifyTick(renderBatch([{ id, prompt: 'late' }, theirs]))
  assert.deepEqual(out.retired, [id])
  assert.equal(out.remainder, renderBatch([theirs]))
})

test('classifyTick: ordinary text and malformed ticks are not ticks and never throw', async () => {
  const { api } = await make()
  for (const text of ['hello', '', '[SCHEDULE REMINDER BATCH]\n' + 'This is a scheduled message from the user\nreminders_json: {nope', '[SCHEDULE REMINDER]\nschedule_id_json: ']) {
    const out = api.classifyTick(text)
    assert.deepEqual(out.ours, [], text)
    assert.deepEqual(out.retired, [], text)
    assert.equal(out.remainder, text, text) // not a tick: nothing is stripped
  }
  assert.equal(api.classifyTick('hello').format, null)
})

test('classifyTick: text that merely quotes a tick further down is not a tick', async () => {
  const { api } = await make()
  const id = await api.ensureTask('s1', '5')
  const text = `Please look at this:\n${renderBatch([{ id, prompt: 'p' }])}`
  const out = api.classifyTick(text)
  assert.deepEqual(out.ours, [])
  assert.equal(out.format, null)
})

// ---- packaging and docs ----

test('package.json "files" ships pr-schedule.js', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('pr-schedule.js'), 'pr-schedule.js must be listed in package.json files')
})

test('README describes the PR poll as an Automation task named "PR <id> comment poll"', () => {
  const readme = readFileSync(join(HERE, '..', '..', 'README.md'), 'utf8')
  assert.match(readme, /PR <id> comment poll/)
  assert.match(readme, /Automation/)
})

// ---- ensure: the wanted task first, stale ones afterwards ----

test('ensureTask creates the wanted task BEFORE deleting a stale one: a failing create deletes nothing', async () => {
  const { api, schedule } = await make()
  const stale = await api.ensureTask('s1', '4')
  schedule.calls.delete.length = 0
  schedule.hooks.createError = Object.assign(new Error('boom-create'), { once: true })
  await assert.rejects(api.ensureTask('s1', '5'), /boom-create/)
  assert.equal(schedule.calls.delete.length, 0, 'the stale task is kept while the new one could not be created')
  assert.deepEqual(schedule.tasksOf('s1').map((t) => t.id), [stale])
})

test('a stale task that cannot be deleted does not fail ensureTask; the next call removes it', async () => {
  const { api, schedule } = await make()
  const stale = await api.ensureTask('s1', '4')
  schedule.hooks.deleteError = Object.assign(new Error('boom-delete'), { once: true })
  const id = await api.ensureTask('s1', '5')
  assert.ok(schedule.tasksOf('s1').some((t) => t.id === id && t.title === taskTitle('5')), 'the wanted task exists')
  assert.ok(schedule.tasksOf('s1').some((t) => t.id === stale), 'the stale one is still there')
  assert.equal(await api.ensureTask('s1', '5'), id)
  assert.deepEqual(schedule.tasksOf('s1').map((t) => t.id), [id])
})

test('a duplicate of the wanted task that cannot be deleted still returns the kept task', async () => {
  const { api, schedule } = await make()
  const a = await schedule.service.create('s1', { title: taskTitle('5'), prompt: `one\n${marker('s1', '5')}`, every_seconds: 600 })
  await schedule.service.create('s1', { title: taskTitle('5'), prompt: `two\n${marker('s1', '5')}`, every_seconds: 600 })
  schedule.hooks.deleteError = Object.assign(new Error('boom-delete'), { once: true })
  assert.equal(await api.ensureTask('s1', '5'), a.id)
})

// ---- registry validation ----

test('malformed registry entries are dropped on load, valid ones are kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prs-'))
  const bad = [
    { id: 'schedule-1', sessionId: 's1', prId: 'abc' },
    { id: 'schedule-2', sessionId: 's1', prId: '5/../x' },
    { id: 'schedule-3', sessionId: 's1', prId: '' },
    { id: 'schedule-4', sessionId: '', prId: '5' },
    { id: 'schedule-5', sessionId: 'has space', prId: '5' },
    { id: 'schedule-6', sessionId: 'line\nbreak', prId: '5' },
    { id: 'schedule-7', sessionId: 'ctrl\u0007bell', prId: '5' },
    { id: 'schedule-8', sessionId: 's1', prId: 5 },
    { id: '', sessionId: 's1', prId: '5' },
    { id: 7, sessionId: 's1', prId: '5' },
    null,
    'text',
  ]
  writeFileSync(registryPath(dir), JSON.stringify({ tasks: [...bad, { id: 'schedule-ok', sessionId: 's9', prId: '12' }] }))
  const { api } = await make({ dir })
  assert.deepEqual(api.sessionIds(), ['s9'])
  assert.deepEqual(api.taskIdsOf('s1'), [])
  assert.equal(api.hasTasks('s1'), false)
  assert.deepEqual(api.classifyTick(renderBatch([{ id: 'schedule-ok', prompt: 'p' }])).ours, [{ id: 'schedule-ok', sessionId: 's9', prId: '12' }])
  assert.deepEqual(api.classifyTick(renderBatch([{ id: 'schedule-1', prompt: 'p' }])).ours, [])
})

test('a registry whose tasks field is not a list is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prs-'))
  writeFileSync(registryPath(dir), JSON.stringify({ tasks: { id: 'x' } }))
  const { api } = await make({ dir })
  assert.deepEqual(api.sessionIds(), [])
})

// ---- stale ticks: our marker for this session, task id unknown ----

test('classifyTick: a batch entry whose prompt carries our marker for the receiving session but an unknown id is retired', async () => {
  const { api } = await make()
  const text = renderBatch([{ id: 'schedule-lost', prompt: `Check ...\n${marker('s1', '5')}` }])
  const out = api.classifyTick(text, 's1')
  assert.deepEqual(out.retired, ['schedule-lost'])
  assert.deepEqual(out.ours, [])
  assert.equal(out.remainder, null)
})

test('classifyTick: the same stale single reminder is retired too', async () => {
  const { api } = await make()
  const out = api.classifyTick(renderSingle({ id: 'schedule-lost', prompt: `Check ...\n${marker('s1', '5')}` }), 's1')
  assert.deepEqual(out.retired, ['schedule-lost'])
  assert.equal(out.remainder, null)
})

test('classifyTick: a marker for another session, no session given, or a marker that is not the last prompt line is left alone', async () => {
  const { api } = await make()
  const other = renderBatch([{ id: 'schedule-x', prompt: `Check ...\n${marker('s2', '5')}` }])
  assert.deepEqual(api.classifyTick(other, 's1').retired, [])
  assert.equal(api.classifyTick(other, 's1').remainder, other)
  const same = renderBatch([{ id: 'schedule-y', prompt: `Check ...\n${marker('s1', '5')}` }])
  assert.deepEqual(api.classifyTick(same).retired, [], 'without a receiving session nothing is assumed')
  const quoted = renderBatch([{ id: 'schedule-z', prompt: `${marker('s1', '5')}\nand then more text` }])
  assert.deepEqual(api.classifyTick(quoted, 's1').retired, [])
})

test('classifyTick: a stale entry is dropped from a mixed batch while the user\'s own reminder survives', async () => {
  const { api, schedule } = await make()
  const other = schedule.addForeign('s1')
  const theirs = { id: other.id, prompt: other.prompt }
  const out = api.classifyTick(renderBatch([{ id: 'schedule-lost', prompt: `p\n${marker('s1', '5')}` }, theirs]), 's1')
  assert.deepEqual(out.retired, ['schedule-lost'])
  assert.equal(out.remainder, renderBatch([theirs]))
})

test('classifyTick: a registered task whose prompt carries the marker stays ours (the registry wins)', async () => {
  const { api } = await make()
  const id = await api.ensureTask('s1', '5')
  const out = api.classifyTick(renderBatch([{ id, prompt: `p\n${marker('s1', '5')}` }]), 's1')
  assert.deepEqual(out.ours, [{ id, sessionId: 's1', prId: '5' }])
  assert.deepEqual(out.retired, [])
})

test('classifyTick: a stale tick (marker for this session, unknown id) leaves a trace naming the task and the session, never the prompt', async () => {
  const { api, logs } = await make()
  api.classifyTick(renderBatch([{ id: 'schedule-lost', prompt: `Check the secret thing\n${marker('s1', '5')}` }]), 's1')
  api.classifyTick(renderSingle({ id: 'schedule-lost-2', prompt: `Check ...\n${marker('s1', '5')}` }), 's1')
  assert.ok(logs.some((l) => /stale tick/.test(l) && l.includes('schedule-lost') && l.includes('s1')), logs.join('\n'))
  assert.ok(logs.some((l) => /stale tick/.test(l) && l.includes('schedule-lost-2')), logs.join('\n'))
  assert.equal(logs.some((l) => l.includes('secret thing')), false, 'the prompt text must not reach the trace')
})

test('classifyTick: a tick of a retired (deleted) task leaves a trace too', async () => {
  const { api, logs } = await make()
  const id = await api.ensureTask('s1', '5')
  await api.deleteTasks('s1')
  logs.length = 0
  api.classifyTick(renderBatch([{ id, prompt: 'p' }]), 's1')
  assert.ok(logs.some((l) => /retired task/.test(l) && l.includes(id)), logs.join('\n'))
})

test('classifyTick: a tick that is neither stale nor retired (ours or a foreign one) leaves no drop trace', async () => {
  const { api, schedule, logs } = await make()
  const id = await api.ensureTask('s1', '5')
  const foreign = schedule.addForeign('s1')
  logs.length = 0
  api.classifyTick(renderBatch([{ id, prompt: 'p' }, { id: foreign.id, prompt: foreign.prompt }]), 's1')
  assert.deepEqual(logs, [])
})

test('README: polling does not stop on disposal, ticks add log events, merged PR sessions should be archived, a tick waits for the next turn', () => {
  const readme = readFileSync(join(HERE, '..', '..', 'README.md'), 'utf8')
  const paragraph = readme.split('\n').find((line) => line.includes('PR <id> comment poll')) ?? ''
  assert.doesNotMatch(paragraph, /or the session is disposed/, 'a disposed session is re-registered on its next step: polling does not stop')
  assert.match(paragraph, /few log events per PR session/)
  assert.match(paragraph, /archive[^.]*once (?:its|the) PR is (?:merged|completed)/i)
  assert.match(paragraph, /start of the next turn/)
})
