// Slice 4 of Auto triage: real-path containment of a read-only command's path arguments (auto only), and the truncation check.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containedInWorkspace, isInside, commandIntact } from '../triage-paths.js'

const base = mkdtempSync(join(tmpdir(), 'rq-paths-'))
const ws = join(base, 'ws')
const outside = join(base, 'outside')
mkdirSync(join(ws, 'src'), { recursive: true })
mkdirSync(outside)
writeFileSync(join(ws, 'src', 'a.txt'), 'a')
writeFileSync(join(ws, 'top.txt'), 't')
writeFileSync(join(outside, 'secret.txt'), 's')
let linkSkip
try { symlinkSync(outside, join(ws, 'link'), 'junction') } catch (e) { linkSkip = 'the OS refused to create a junction/symlink: ' + e.code }
test.after(() => rmSync(base, { recursive: true, force: true }))

const inside = (cmd, workspace = ws) => containedInWorkspace(cmd, workspace)

test('absolute path inside the workspace is contained', async () => {
  assert.equal(await inside('cat ' + join(ws, 'src', 'a.txt')), true)
  assert.equal(await inside('ls ' + ws), true)
})

test('relative paths are resolved against the workspace', async () => {
  assert.equal(await inside('cat src/a.txt'), true)
  assert.equal(await inside('cat ./top.txt'), true)
  assert.equal(await inside('ls .'), true)
  assert.equal(await inside('cat top.txt'), true, 'an existing bare name is checked and fine')
})

test('a command with no path candidates is contained, and subcommand words / numbers are not paths', async () => {
  assert.equal(await inside('pwd'), true)
  assert.equal(await inside('git status'), true)
  assert.equal(await inside('git log --oneline -5'), true)
  assert.equal(await inside('git diff HEAD~1'), true)
  assert.equal(await inside('head -n 20 top.txt'), true)
})

test('an absolute path outside the workspace is vetoed; so is a relative escape', async () => {
  assert.equal(await inside('cat ' + join(outside, 'secret.txt')), false)
  assert.equal(await inside('cat ../outside/secret.txt'), false)
})

test('a --flag=value path is checked on its value', async () => {
  assert.equal(await inside('rg --file=' + join(outside, 'secret.txt') + ' x'), false)
  assert.equal(await inside('rg --file=/outside x'), false)
  assert.equal(await inside('rg --file=' + join(ws, 'top.txt') + ' x'), true)
  assert.equal(await inside('git log --since=2.days'), true)
})

test('a path candidate that does not exist is vetoed; a plain word that does not exist is not', async () => {
  assert.equal(await inside('cat src/nope.txt'), false)
  assert.equal(await inside('cat ./nope'), false)
  assert.equal(await inside('rg needle'), true)
})

test('a junction/symlink that leads outside is vetoed, through any path form', { skip: linkSkip }, async () => {
  assert.equal(await inside('cat link/secret.txt'), false)
  assert.equal(await inside('cat ' + join(ws, 'link', 'secret.txt')), false)
  assert.equal(await inside('ls link'), false, 'an existing bare name that is the link')
})

test('a missing, empty or unresolvable workspace is a veto', async () => {
  for (const w of [undefined, '', null, 42, join(base, 'no-such-dir')]) assert.equal(await containedInWorkspace('git status', w), false, String(w))
})

test('the workspace itself may be reached through a different spelling (case on Windows, trailing slash)', async () => {
  assert.equal(await inside('cat ' + join(ws, 'top.txt'), ws + '/'), true)
  if (process.platform === 'win32') {
    assert.equal(await inside('cat ' + join(ws, 'top.txt').toUpperCase()), true)
    assert.equal(await inside('cat top.txt', ws.toUpperCase()), true)
  }
})

test('the realpath of a workspace that is itself reached through a link is used', { skip: linkSkip }, async () => {
  assert.equal(await inside('cat src/a.txt', join(ws, 'link')), false, 'src/a.txt does not exist under the outside dir')
  assert.equal(await inside('cat secret.txt', join(ws, 'link')), true, 'the real workspace is the outside dir')
  assert.equal(await inside('cat ' + join(realpathSync(outside), 'secret.txt'), join(ws, 'link')), true)
})

test('isInside: containment is prefix on whole segments, separators normalised, case-insensitive on request', () => {
  assert.equal(isInside('C:\\Work\\Proj', 'C:\\Work\\Proj\\src', true), true)
  assert.equal(isInside('C:\\Work\\Proj', 'c:/work/proj', true), true)
  assert.equal(isInside('C:\\Work\\Proj', 'C:\\Work\\Project', true), false)
  assert.equal(isInside('C:\\Work\\Proj', 'c:\\work\\proj\\x', false), false)
  assert.equal(isInside('/w/p/', '/w/p/x', false), true)
  assert.equal(isInside('', '/w', false), false)
})

test('commandIntact: needs a detail that is not clipped, and a call id', () => {
  const ok = { detail: 'git status', callId: 'c1' }
  assert.equal(commandIntact(ok), true)
  assert.equal(commandIntact({ ...ok, detail: 'cat ' + 'a'.repeat(3000) + '\u2026' }), false, 'the risk.js clip marker')
  assert.equal(commandIntact({ ...ok, detail: 'git status\u2026' }), false)
  assert.equal(commandIntact({ ...ok, detail: undefined, summary: 'git status' }), false)
  assert.equal(commandIntact({ ...ok, detail: '' }), false)
  assert.equal(commandIntact({ detail: 'git status' }), false)
  assert.equal(commandIntact({ ...ok, callId: '' }), false)
  assert.equal(commandIntact(undefined), false)
})
