import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRemote, normalizeGithub, normalizeAdo, pickPr, readPr, createPrLookup, findCli } from '../pr.js'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

test('parseRemote classifies GitHub and Azure DevOps remotes, rejects the rest', () => {
  assert.deepEqual(parseRemote('https://github.com/jitsmaster/dsh-plugins.git'), { kind: 'github', slug: 'jitsmaster/dsh-plugins' })
  assert.deepEqual(parseRemote('git@github.com:a/b.git'), { kind: 'github', slug: 'a/b' })
  assert.deepEqual(parseRemote('https://org@dev.azure.com/org/Proj/_git/Repo'), { kind: 'ado', org: 'org', project: 'Proj', repo: 'Repo' })
  assert.deepEqual(parseRemote('git@ssh.dev.azure.com:v3/org/Proj/Repo'), { kind: 'ado', org: 'org', project: 'Proj', repo: 'Repo' })
  assert.deepEqual(parseRemote('https://ingeniuxdev.visualstudio.com/DefaultCollection/Ingeniux/_git/CTnP'), { kind: 'ado', org: 'ingeniuxdev', project: 'Ingeniux', repo: 'CTnP' })
  assert.deepEqual(parseRemote('https://o.visualstudio.com/P/_git/R'), { kind: 'ado', org: 'o', project: 'P', repo: 'R' })
  assert.deepEqual(parseRemote('o@vs-ssh.visualstudio.com:v3/o/P/R'), { kind: 'ado', org: 'o', project: 'P', repo: 'R' })
  assert.equal(parseRemote('https://dev.azure.com/org/My%20Proj/_git/Repo'), undefined, 'spaces would need shell quoting')
  assert.equal(parseRemote('https://dev.azure.com/o/p&calc/_git/r'), undefined)
  assert.equal(parseRemote('https://example.com/a/b.git'), undefined)
  assert.equal(parseRemote(undefined), undefined)
})

test('an open PR wins over newer closed ones; urls must be https', () => {
  const json = JSON.stringify([
    { number: 9, url: 'https://github.com/a/b/pull/9', state: 'CLOSED', title: 'x' },
    { number: 7, url: 'https://github.com/a/b/pull/7', state: 'OPEN', title: 'y' },
    { number: 8, url: 'javascript:alert(1)', state: 'OPEN' },
  ])
  assert.equal(normalizeGithub(json).number, 7)
  assert.equal(normalizeGithub('not json'), undefined)
  assert.equal(pickPr([]), undefined)
})

test('ado rows become a pullrequest url built from the remote, not from the CLI output', () => {
  const remote = { kind: 'ado', org: 'o', project: 'P', repo: 'R' }
  const pr = normalizeAdo(JSON.stringify([{ pullRequestId: 12, status: 'completed', title: 't', url: 'https://evil' }]), remote)
  assert.equal(pr.url, 'https://dev.azure.com/o/P/_git/R/pullrequest/12')
  assert.equal(pr.state, 'merged')
})

const gitOk = (url) => async () => ({ code: 0, stdout: url + '\n' })
test('readPr asks gh for a GitHub remote and shows nothing without the CLI', async () => {
  let seen
  const r = await readPr('/r', 'feat/x', {
    gitFn: gitOk('https://github.com/a/b.git'), find: () => 'C:/gh.exe',
    exec: async (exe, args) => { seen = args; return JSON.stringify([{ number: 3, url: 'https://github.com/a/b/pull/3', state: 'OPEN', title: 't' }]) },
  })
  assert.equal(r.pr.url, 'https://github.com/a/b/pull/3')
  assert.ok(seen.includes('feat/x') && seen.includes('a/b'))
  assert.deepEqual(await readPr('/r', 'feat/x', { gitFn: gitOk('https://github.com/a/b.git'), find: () => undefined }), { ok: true, pr: null })
  assert.deepEqual(await readPr('/r', 'feat/x', { gitFn: gitOk('https://github.com/a/b.git'), find: () => 'gh', exec: async () => undefined }), { ok: true, pr: null })
  assert.deepEqual(await readPr('/r', undefined), { ok: true, pr: null })
})

test('readPr never passes a shell-hostile branch to az', async () => {
  let called = false
  const r = await readPr('/r', 'a&calc', { gitFn: gitOk('https://dev.azure.com/o/p/_git/r'), find: () => 'az.cmd', exec: async () => { called = true } })
  assert.equal(called, false)
  assert.equal(r.pr, null)
  const ok = await readPr('/r', 'task/1-x', { gitFn: gitOk('https://dev.azure.com/o/p/_git/r'), find: () => 'az.cmd', exec: async () => JSON.stringify([{ pullRequestId: 5, status: 'active' }]) })
  assert.equal(ok.pr.number, 5)
})

test('a busy git answer is not cached; found answers are', async () => {
  let n = 0, busy = true
  const lookup = createPrLookup({ gitFn: async () => { n++; return busy ? { busy: true } : { code: 0, stdout: 'https://github.com/a/b' } }, find: () => 'gh', exec: async () => JSON.stringify([{ number: 1, url: 'https://github.com/a/b/pull/1', state: 'OPEN' }]) })
  assert.equal((await lookup('/r', 'x')).busy, true)
  busy = false
  assert.equal((await lookup('/r', 'x')).pr.number, 1)
  await lookup('/r', 'x')
  assert.equal(n, 2)
})

test('findCli ignores relative PATH entries', () => {
  assert.equal(findCli('definitely-not-a-cli', '.' + (process.platform === 'win32' ? ';' : ':') + 'rel'), undefined)
})

test('client: the PR session is the session titled "PR <number>", never this one or "PR 12" for 1', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const sandbox = { console, URLSearchParams, TextEncoder, TextDecoder, location: { hostname: '127.0.0.1' }, window: { __ModuleLoader__: { load: (m) => { sandbox.mod = m.factory((n) => (n === 'react' ? { createElement() {}, Fragment: Symbol('F'), useState() {}, useEffect() {}, useRef() {}, useMemo() {}, useCallback() {} } : {})) } } } }
  vm.runInNewContext(src, sandbox)
  const { findPrSessionId } = sandbox.mod.__test
  const byId = { a: { title: 'PR 12' }, b: { title: 'PR 1 - fixes' }, c: { title: 'Other' }, self: { title: 'PR 1' } }
  assert.equal(findPrSessionId(byId, 1, 'self'), 'b')
  assert.equal(findPrSessionId(byId, 12, 'self'), 'a')
  assert.equal(findPrSessionId(byId, 99, 'self'), undefined)
})

test('ado with a PAT uses the REST API, newest-first rows, and never spawns anything', async () => {
  let seen
  const fetchFn = async (url, init) => { seen = { url, auth: init.headers.Authorization }; return { ok: true, json: async () => ({ value: [{ pullRequestId: 6501, status: 'active', title: 't' }] }) } }
  const r = await readPr('/r', 'task/25693-x', { gitFn: gitOk('https://ingeniuxdev.visualstudio.com/DefaultCollection/Ingeniux/_git/CTnP'), fetchFn, env: { AZURE_DEVOPS_EXT_PAT: 'secret' }, find: () => assert.fail('no CLI'), exec: () => assert.fail('no CLI') })
  assert.equal(r.pr.url, 'https://dev.azure.com/ingeniuxdev/Ingeniux/_git/CTnP/pullrequest/6501')
  assert.ok(seen.url.includes('refs%2Fheads%2Ftask%2F25693-x') && seen.url.startsWith('https://dev.azure.com/ingeniuxdev/Ingeniux/_apis/git/repositories/CTnP/'))
  assert.equal(seen.auth, 'Basic ' + Buffer.from(':secret').toString('base64'))
  const bad = await readPr('/r', 'task/x', { gitFn: gitOk('https://dev.azure.com/o/p/_git/r'), fetchFn: async () => ({ ok: false }), env: { AZURE_DEVOPS_EXT_PAT: 'secret' }, find: () => undefined })
  assert.equal(bad.pr, null)
})
