import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launcherFileName, launcherScript, pickPrivateBrowser, writeLauncher } from '../limit-browser.js'

// Expected text copied from DSH llm-claude-code/src/browser.ts logic.
const winEnv = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const FIREFOX = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
const only = (...paths) => (p) => paths.includes(p)

test('limit-browser: pick prefers Chrome, then Edge, then Firefox, else undefined', () => {
  assert.deepEqual(pickPrivateBrowser('win32', winEnv, only(CHROME, EDGE, FIREFOX)), { name: 'Chrome', executable: CHROME, args: ['--incognito'] })
  assert.deepEqual(pickPrivateBrowser('win32', winEnv, only(EDGE, FIREFOX)), { name: 'Edge', executable: EDGE, args: ['--inprivate'] })
  assert.deepEqual(pickPrivateBrowser('win32', winEnv, only(FIREFOX)), { name: 'Firefox', executable: FIREFOX, args: ['-private-window'] })
  assert.equal(pickPrivateBrowser('win32', winEnv, () => false), undefined)
  assert.equal(pickPrivateBrowser('linux', {}, only('/usr/bin/chromium'))?.executable, '/usr/bin/chromium')
  assert.equal(pickPrivateBrowser('darwin', {}, only('/Applications/Firefox.app/Contents/MacOS/firefox'))?.name, 'Firefox')
})

test('limit-browser: script text per platform', () => {
  assert.equal(launcherScript('win32', { name: 'Chrome', executable: CHROME, args: ['--incognito'] }), `@echo off\r\nstart "" "${CHROME}" --incognito "%~1"\r\n`)
  assert.equal(launcherScript('win32', { name: 'Edge', executable: EDGE, args: ['--inprivate'] }), `@echo off\r\nstart "" "${EDGE}" --inprivate "%~1"\r\n`)
  assert.equal(launcherScript('win32', undefined), '@echo off\r\nstart "" "%~1"\r\n')
  assert.equal(launcherScript('win32', { name: 'Chrome', executable: 'C:\\a"b\\c.exe', args: ['--incognito'] }), '@echo off\r\nstart "" "%~1"\r\n')
  assert.equal(launcherScript('win32', { name: 'Chrome', executable: 'C:\\100%\\c.exe', args: ['--incognito'] }), '@echo off\r\nstart "" "C:\\100%%\\c.exe" --incognito "%~1"\r\n')
  assert.equal(launcherScript('linux', { name: 'Chrome', executable: '/usr/bin/chromium', args: ['--incognito'] }), "#!/bin/sh\nexec '/usr/bin/chromium' --incognito \"$1\"\n")
  assert.equal(launcherScript('linux', { name: 'Chrome', executable: "/o'k/c", args: ['--incognito'] }), "#!/bin/sh\nexec '/o'\\''k/c' --incognito \"$1\"\n")
  assert.equal(launcherScript('linux', undefined), '#!/bin/sh\nexec xdg-open "$1"\n')
  assert.equal(launcherScript('darwin', undefined), '#!/bin/sh\nexec open "$1"\n')
  assert.equal(launcherScript('darwin', { name: 'Firefox', executable: '/Applications/Firefox.app/Contents/MacOS/firefox', args: ['-private-window'] }), "#!/bin/sh\nexec '/Applications/Firefox.app/Contents/MacOS/firefox' -private-window \"$1\"\n")
  assert.equal(launcherFileName('win32'), 'open-private.cmd')
  assert.equal(launcherFileName('linux'), 'open-private.sh')
})

// Security review Low: a Windows browser path that cannot be quoted falls back to the default browser, so no private browser may be reported.
test('limit-browser: writeLauncher reports no browser when the path cannot be quoted (default-browser fallback)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-lb-'))
  try {
    const bad = 'C:\\a"b\\Google\\Chrome\\Application\\chrome.exe'
    const r = await writeLauncher(dir, 'win32', { ProgramFiles: 'C:\\a"b' }, only(bad))
    assert.equal(r.browser, undefined)
    assert.equal(readFileSync(r.path, 'utf8'), '@echo off\r\nstart "" "%~1"\r\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('limit-browser: writeLauncher writes the script and reports the browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rq-lb-'))
  try {
    const none = await writeLauncher(dir, 'win32', winEnv, () => false)
    assert.equal(none.browser, undefined)
    assert.equal(readFileSync(none.path, 'utf8'), '@echo off\r\nstart "" "%~1"\r\n')
    const some = await writeLauncher(dir, 'linux', {}, only('/usr/bin/firefox'))
    assert.equal(some.browser.name, 'Firefox')
    assert.equal(readFileSync(some.path, 'utf8'), "#!/bin/sh\nexec '/usr/bin/firefox' -private-window \"$1\"\n")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
