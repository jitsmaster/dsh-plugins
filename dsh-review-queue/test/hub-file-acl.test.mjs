import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from '../hub/atomic-file.js'
import { createHardener, hardenedWrite } from '../hub/file-acl.js'
import { tmpDir } from './hub-helpers.mjs'

const win = (over = {}) => {
  const calls = []
  const logs = []
  const h = createHardener({ platform: 'win32', user: 'PC\\me', run: (cmd, args) => { calls.push([cmd, args]); return over.result ?? { status: 0 } }, log: (l) => logs.push(l), ...over.deps })
  return { h, calls, logs }
}

test('on Windows the file is cut off from inherited rights and granted to the current user only, through the injected runner', () => {
  const { h, calls } = win()
  assert.deepEqual(h.harden('C:\\state\\hub\\devices.json'), { ok: true })
  assert.deepEqual(calls, [['icacls', ['C:\\state\\hub\\devices.json', '/inheritance:r', '/grant:r', 'PC\\me:(R,W)']]])
  assert.deepEqual(h.status(), { tightened: true, failed: [] })
})

test('a runner that fails or throws is logged by file name, reported as not tightened, and never throws', () => {
  for (const result of [{ status: 5 }, { status: null, error: new Error('spawn icacls ENOENT') }]) {
    const { h, logs } = win({ result })
    assert.equal(h.harden('C:\\state\\hub\\devices.json').ok, false)
    assert.deepEqual(h.status(), { tightened: false, failed: ['devices.json'] })
    assert.ok(logs.some((l) => /devices\.json/.test(l) && /could not be tightened/.test(l)))
    assert.ok(!logs.some((l) => l.includes('C:\\state')), 'only the file name is logged')
  }
  const h = createHardener({ platform: 'win32', user: 'PC\\me', run: () => { throw new Error('boom') }, log: () => {} })
  assert.equal(h.harden('x\\a.json').ok, false)
})

test('a later success for the same file clears its failure', () => {
  let status = 1
  const h = createHardener({ platform: 'win32', user: 'PC\\me', run: () => ({ status }), log: () => {} })
  h.harden('x\\a.json'); h.harden('x\\b.json')
  assert.deepEqual(h.status().failed, ['a.json', 'b.json'])
  status = 0
  h.harden('x\\a.json')
  assert.deepEqual(h.status(), { tightened: false, failed: ['b.json'] })
})

test('without a user name there is nothing safe to grant: not tightened', () => {
  const h = createHardener({ platform: 'win32', user: null, run: () => ({ status: 0 }), log: () => {} })
  assert.equal(h.harden('x\\a.json').ok, false)
})

test('elsewhere the mode is set to 0600 and no icacls runs', () => {
  const modes = []
  const calls = []
  const h = createHardener({ platform: 'linux', chmod: (f, m) => modes.push([f, m]), run: (...a) => calls.push(a), log: () => {} })
  assert.equal(h.harden('/s/a.json').ok, true)
  assert.deepEqual(modes, [['/s/a.json', 0o600]])
  assert.deepEqual(calls, [])
})

test('hardenedWrite gives writeAtomic the hook that tightens the temp file before it replaces the target (a rename keeps the temp file rights)', () => {
  const dir = tmpDir()
  const seen = []
  const { h } = win()
  const opts = hardenedWrite({ harden: (f) => { seen.push(f); return h.harden(f) } })
  writeAtomic(join(dir, 'd.json'), 'x', opts)
  assert.equal(seen.length, 1)
  assert.match(seen[0], /d\.json\.\d+\.tmp$/)
  assert.equal(readFileSync(join(dir, 'd.json'), 'utf8'), 'x')
})

test('the real icacls on a real file: only the current user keeps access, the file stays writable and atomically replaceable', { skip: process.platform !== 'win32' }, (t) => {
  const dir = tmpDir(t)
  const file = join(dir, 'devices.json')
  writeFileSync(file, '1')
  const h = createHardener({ log: () => {} })
  assert.equal(h.harden(file).ok, true, 'icacls ran')
  const acl = execFileSync('icacls', [file], { encoding: 'utf8' })
  assert.doesNotMatch(acl, /BUILTIN\\Administrators|NT AUTHORITY\\SYSTEM|BUILTIN\\Users|Everyone/, acl)
  assert.match(acl, new RegExp(String(process.env.USERNAME).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  writeAtomic(file, '2', hardenedWrite({ harden: (f) => h.harden(f) }))
  assert.equal(readFileSync(file, 'utf8'), '2')
  assert.equal(h.status().tightened, true)
})
