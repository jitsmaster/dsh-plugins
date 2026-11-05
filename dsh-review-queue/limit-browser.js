/**
 * Private-window launcher for the sign-in page: a JS port of DSH's llm-claude-code/src/browser.ts (keep the two equal; test/limit-browser.test.mjs
 * holds the expected script text). The login child gets `BROWSER=<launcher>`, which opens the sign-in URL in a private window of the first installed
 * Chrome, Edge or Firefox (else the default browser), so a claude.ai session of the normal profile cannot pick the old account.
 */
import { chmod, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'

function candidates(platform, env) {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA].filter((r) => typeof r === 'string' && r.length > 0)
    const under = (...parts) => roots.map((r) => win32.join(r, ...parts))
    return [
      { name: 'Chrome', args: ['--incognito'], paths: under('Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Edge', args: ['--inprivate'], paths: under('Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Firefox', args: ['-private-window'], paths: under('Mozilla Firefox', 'firefox.exe') },
    ]
  }
  if (platform === 'darwin') {
    return [
      { name: 'Chrome', args: ['--incognito'], paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] },
      { name: 'Edge', args: ['--inprivate'], paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] },
      { name: 'Firefox', args: ['-private-window'], paths: ['/Applications/Firefox.app/Contents/MacOS/firefox'] },
    ]
  }
  return [
    { name: 'Chrome', args: ['--incognito'], paths: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'] },
    { name: 'Edge', args: ['--inprivate'], paths: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] },
    { name: 'Firefox', args: ['-private-window'], paths: ['/usr/bin/firefox'] },
  ]
}

/** The first installed Chrome, Edge or Firefox as { name, executable, args }, or undefined. `exists(path)` is injected. */
export function pickPrivateBrowser(platform, env, exists) {
  for (const c of candidates(platform, env)) {
    const executable = c.paths.find((p) => exists(p))
    if (executable !== undefined) return { name: c.name, executable, args: c.args }
  }
  return undefined
}

export const launcherFileName = (platform) => (platform === 'win32' ? 'open-private.cmd' : 'open-private.sh')

const cmdQuote = (path) => (/["\r\n]/u.test(path) ? undefined : `"${path.replaceAll('%', '%%')}"`)
const shQuote = (word) => `'${word.replaceAll('\'', '\'\\\'\'')}'`

/** The launcher text (URL is its one argument); the default-browser script when the browser path cannot be quoted safely. */
export function launcherScript(platform, browser) {
  if (platform === 'win32') {
    const executable = browser === undefined ? undefined : cmdQuote(browser.executable)
    const open = browser === undefined || executable === undefined
      ? 'start "" "%~1"'
      : `start "" ${executable} ${browser.args.join(' ')} "%~1"`
    return `@echo off\r\n${open}\r\n`
  }
  const opener = platform === 'darwin' ? 'open' : 'xdg-open'
  const open = browser === undefined ? `exec ${opener} "$1"` : `exec ${shQuote(browser.executable)} ${browser.args.join(' ')} "$1"`
  return `#!/bin/sh\n${open}\n`
}

/** Writes the launcher into `directory` (the caller removes it); returns { path, browser? }. */
export async function writeLauncher(directory, platform, env, exists) {
  let browser = pickPrivateBrowser(platform, env, exists)
  // A Windows path that cannot be quoted makes launcherScript fall back to the default (non-private) browser: do not report a private one then.
  if (browser !== undefined && platform === 'win32' && cmdQuote(browser.executable) === undefined) browser = undefined
  const path = join(directory, launcherFileName(platform))
  await writeFile(path, launcherScript(platform, browser))
  if (platform !== 'win32') await chmod(path, 0o755)
  return { path, ...(browser === undefined ? {} : { browser }) }
}
