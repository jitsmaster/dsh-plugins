// Auto triage pass 6 (performance): planted binaries are probed by exact name instead of listing the workspace root, the Resolved sub-tab counts are
// memoized per snapshot/type/search, and the log's error message is clipped before it is redacted. Behaviour is unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { plantedBinary } from '../triage-paths.js'
import { createStore } from '../store.js'
import { createPermissionActor } from '../triage-act-permission.js'
import { createTriageRunner, DEFAULT_RULES } from '../triage-runner.js'
import { source, file } from './client-todo-helpers.mjs'

const EXTS = ['', '.exe', '.bat', '.cmd', '.com', '.ps1', '.js', '.vbs']
const enoent = () => Object.assign(new Error('nf'), { code: 'ENOENT' })

test('P6-1: plantedBinary probes exactly the candidate names (no directory listing)', async () => {
  const probed = []
  const io = { stat: async (p) => { probed.push(p); throw enoent() }, readdir: async () => { throw new Error('readdir must not be called') } }
  assert.equal(await plantedBinary('/ws', 'RG', io), false)
  assert.deepEqual(probed, EXTS.map((e) => resolve('/ws', 'rg' + e)))
})

test('P6-1: plantedBinary detects a planted rg.bat through the probe, and stops at the first hit', async () => {
  const probed = []
  const io = { stat: async (p) => { probed.push(p); if (p.endsWith('rg.bat')) return {}; throw enoent() } }
  assert.equal(await plantedBinary('/ws', 'rg', io), true)
  assert.equal(probed.length, 3)
})

test('P6-1: a probe error other than not-found fails closed', async () => {
  for (const code of ['EACCES', 'EPERM', 'EIO', undefined]) {
    const io = { stat: async () => { throw Object.assign(new Error('x'), { code }) } }
    assert.equal(await plantedBinary('/ws', 'rg', io), true, String(code))
  }
  assert.equal(await plantedBinary('/ws', '', { stat: async () => { throw enoent() } }), true, 'an empty binary name is a veto')
})

test('P6-1: with the default probe a real planted file is found and a clean root is not (no readdir needed on win32)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-p6-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'a')
    assert.equal(await plantedBinary(dir, 'cat'), false)
    writeFileSync(join(dir, 'CAT.CMD'), 'x')
    assert.equal(await plantedBinary(dir, 'cat'), true)
    if (process.platform === 'win32') assert.equal(await plantedBinary(dir, 'cat', { readdir: async () => { throw new Error('unused') }, stat: undefined }), true, 'an injected readdir is still honoured')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function loadClient() {
  let registered
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registered = r } }, localStorage: { getItem: () => null, setItem() {} } }, console, setInterval, clearInterval, setTimeout: () => 1, clearTimeout() {}, fetch: () => new Promise(() => {}) }
  vm.runInNewContext(source, sandbox, { filename: file })
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: Symbol('F'), useState: (v) => [v, () => {}], useEffect() {}, useRef: () => ({ current: null }), useSyncExternalStore: (s, g) => g() }
  return registered.factory(() => React).__test
}

test('P6-2: resolvedCountsMemo returns the same counts for the same snapshot, type and search, and recomputes for a new one', () => {
  const T = loadClient()
  const mk = (n) => ({ resolved: Array.from({ length: n }, (_, i) => ({ id: 'r' + i, type: 'permission', status: 'resolved', payload: { summary: 'item ' + i } })), open: [] })
  const snap = mk(3)
  const a = T.resolvedCountsMemo(snap, 'all', '')
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(T.resolvedCounts(snap.resolved, { type: 'all', query: '' }))))
  assert.equal(T.resolvedCountsMemo(snap, 'all', ''), a, 'same snapshot: the same object')
  assert.notEqual(T.resolvedCountsMemo(snap, 'permission', ''), a, 'another type recomputes')
  const b = T.resolvedCountsMemo(snap, 'all', 'item 1')
  assert.equal(b.all, 1, 'another search recomputes')
  const next = mk(5)
  assert.equal(T.resolvedCountsMemo(next, 'all', 'item 1').all, 1)
  assert.equal(T.resolvedCountsMemo(next, 'all', '').all, 5, 'a new snapshot recomputes')
  assert.deepEqual(JSON.parse(JSON.stringify(T.resolvedCountsMemo(null, 'all', ''))), { all: 0, me: 0, ai: 0 })
})

test('P6-3: the logged error message is clipped before redaction, so a 100KB dash-heavy message is quick and capped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-p6-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'a')
    const store = createStore({ now: () => 1000, uuid: (() => { let n = 0; return () => 'i' + ++n })() })
    const GOOD = { needs_decision: false, answer_basis: 'none', answer: null, evidence_quote: null, evidence_source: null, matched_rule: 'ro-permission', attention: 10, reversible: true, touches_outside_workspace: false, read_only: true }
    const lines = []
    const runner = createTriageRunner({ store, judge: { judge: async () => ({ judgment: GOOD, raw: '' }) }, triageLog: { append() {} }, log: (l) => lines.push(l), rules: DEFAULT_RULES.map((r) => ({ ...r, mode: 'auto' })), actors: { permission: async () => { throw new Error('-'.repeat(50000) + ' -'.repeat(25000)) } } })
    runner.start()
    store.add({ type: 'permission', sessionId: 's1', workspace: dir, payload: { toolName: 'shell', detail: 'cat a.txt', summary: 'cat a.txt', callId: 'c1' } })
    const t0 = Date.now()
    await runner.idle()
    assert.ok(Date.now() - t0 < 2000, 'finished quickly')
    const line = lines.find((l) => l.includes('failed'))
    assert.ok(line, 'the actor failure was logged')
    assert.ok(line.length <= 400, 'capped: ' + line.length)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
