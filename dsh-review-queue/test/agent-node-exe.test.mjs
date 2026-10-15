import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveNodeExe } from '../agent/node-exe.js'

const win = { platform: 'win32', execPath: 'C:\\Node\\node.exe', versions: {}, env: { PATH: 'C:\\Windows;C:\\tools' } }
const present = (...files) => (p) => files.includes(p)

test('a configured hubNode wins when it exists', () => {
  assert.deepEqual(resolveNodeExe({ ...win, hubNode: 'D:\\n\\node.exe', exists: present('D:\\n\\node.exe', 'C:\\Node\\node.exe') }), { exe: 'D:\\n\\node.exe', env: {} })
})

test('a configured hubNode that does not exist is an error, never a silent fallback', () => {
  assert.deepEqual(resolveNodeExe({ ...win, hubNode: 'D:\\gone\\node.exe', exists: present('C:\\Node\\node.exe') }), { error: 'hubNode does not exist' })
})

test('plain Node as the host: its own executable', () => {
  assert.deepEqual(resolveNodeExe({ ...win, exists: present('C:\\Node\\node.exe') }), { exe: 'C:\\Node\\node.exe', env: {} })
})

test('Electron as the host: node.exe found on PATH', () => {
  const electron = { ...win, execPath: 'C:\\DSH\\DSH.exe', versions: { electron: '33.0.0' } }
  assert.deepEqual(resolveNodeExe({ ...electron, exists: present('C:\\tools\\node.exe', 'C:\\DSH\\DSH.exe') }), { exe: 'C:\\tools\\node.exe', env: {} })
})

test('Electron as the host and no node on PATH: the Electron executable run as Node', () => {
  const electron = { ...win, execPath: 'C:\\DSH\\DSH.exe', versions: { electron: '33.0.0' } }
  assert.deepEqual(resolveNodeExe({ ...electron, exists: present('C:\\DSH\\DSH.exe') }), { exe: 'C:\\DSH\\DSH.exe', env: { ELECTRON_RUN_AS_NODE: '1' } })
})

test('nothing usable: an error that says what is missing', () => {
  const electron = { ...win, execPath: 'C:\\DSH\\DSH.exe', versions: { electron: '33.0.0' } }
  assert.deepEqual(resolveNodeExe({ ...electron, exists: () => false }), { error: 'node was not found' })
})

test('on a POSIX host the PATH search looks for "node" with the posix separator', () => {
  const posix = { platform: 'linux', execPath: '/opt/dsh/dsh', versions: { electron: '33.0.0' }, env: { PATH: '/usr/bin:/usr/local/bin' } }
  assert.deepEqual(resolveNodeExe({ ...posix, exists: present('/usr/local/bin/node') }), { exe: '/usr/local/bin/node', env: {} })
})

test('an empty or missing PATH entry is skipped', () => {
  const electron = { ...win, env: { PATH: ';;C:\\tools' }, execPath: 'C:\\DSH\\DSH.exe', versions: { electron: '1' } }
  assert.equal(resolveNodeExe({ ...electron, exists: present('C:\\tools\\node.exe') }).exe, 'C:\\tools\\node.exe')
  assert.equal(resolveNodeExe({ ...electron, env: {}, exists: () => false }).error, 'node was not found')
})
