import { test } from 'node:test'
import assert from 'node:assert/strict'

// ado-create.js: adoBaseOf (the ADO base of a workspace from its origin) and createTask (the first write to Azure DevOps, one Task).
const load = () => import('../ado-create.js')
const PAT = 'pat-SECRET-value-123'
const B64 = Buffer.from(':' + PAT).toString('base64')
const BASE = 'https://dev.azure.com/ingeniuxdev/Ingeniux'
const config = (url) => '[core]\n\trepositoryformatversion = 0\n[remote "upstream"]\n\turl = https://github.com/x/y.git\n[remote "origin"]\n\turl = ' + url + '\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n'
const reader = (url) => async (path) => { reader.paths.push(String(path).replace(/\\/g, '/')); return config(url) }
reader.paths = []

// ---- adoBaseOf -----------------------------------------------------------------------------------------------------------------------

test('adoBaseOf reads only <path>/.git/config and derives the base from the https origin forms', async () => {
  const { adoBaseOf } = await load()
  const cases = [
    ['https://dev.azure.com/ingeniuxdev/Ingeniux/_git/CTnP-Final', BASE],
    ['https://ingeniuxdev@dev.azure.com/ingeniuxdev/Ingeniux/_git/CTnP-Final', BASE],
    ['https://user:secret@dev.azure.com/ingeniuxdev/Ingeniux/_git/CTnP-Final', BASE],
    ['https://dev.azure.com/ingeniuxdev/My%20Project/_git/repo', 'https://dev.azure.com/ingeniuxdev/My%20Project'],
    ['https://ingeniuxdev.visualstudio.com/Ingeniux/_git/CTnP-Final', 'https://ingeniuxdev.visualstudio.com/Ingeniux'],
    ['https://ingeniuxdev.visualstudio.com/DefaultCollection/Ingeniux/_git/CTnP-Final', 'https://ingeniuxdev.visualstudio.com/Ingeniux'],
    ['https://dev.azure.com/ingeniuxdev/_git/Solo', 'https://dev.azure.com/ingeniuxdev/Solo'], // project-less form: the project has the repo's name
    ['git@ssh.dev.azure.com:v3/ingeniuxdev/Ingeniux/CTnP-Final', BASE],
    ['ssh://git@ssh.dev.azure.com/v3/ingeniuxdev/Ingeniux/CTnP-Final', BASE],
    ['https://dev.azure.com/ingeniuxdev/Ingeniux/_git/CTnP-Final/', BASE],
  ]
  for (const [url, want] of cases) {
    reader.paths = []
    assert.equal(await adoBaseOf('D:/dev/ws', { readFile: reader(url) }), want, url)
    assert.deepEqual(reader.paths, ['D:/dev/ws/.git/config'], 'only the config file is read')
  }
})

test('adoBaseOf is undefined for other hosts, http, look-alike hosts, no origin, odd shapes and a missing file; it never throws', async () => {
  const { adoBaseOf } = await load()
  const none = [
    'https://github.com/x/y.git', 'git@github.com:x/y.git', 'http://dev.azure.com/o/p/_git/r',
    'https://dev.azure.com.evil.example/o/p/_git/r', 'https://evil.example/dev.azure.com/o/p/_git/r', 'https://dev.azure.com@evil.example/o/p/_git/r',
    'https://notvisualstudio.com/o/p/_git/r', 'https://dev.azure.com/', 'https://dev.azure.com/org-only', 'git@ssh.dev.azure.com:v3/only-org', '', 'not a url',
  ]
  for (const url of none) assert.equal(await adoBaseOf('/ws', { readFile: reader(url) }), undefined, url)
  assert.equal(await adoBaseOf('/ws', { readFile: async () => '[core]\n\tbare = false\n' }), undefined, 'no origin')
  assert.equal(await adoBaseOf('/ws', { readFile: async () => '[remote "upstream"]\n\turl = https://dev.azure.com/o/p/_git/r\n' }), undefined, 'only a non-origin remote')
  assert.equal(await adoBaseOf('/ws', { readFile: async () => { throw new Error('ENOENT') } }), undefined)
  assert.equal(await adoBaseOf('/ws', { readFile: () => { throw new Error('sync boom') } }), undefined)
  for (const bad of [undefined, null, '', 5, {}]) assert.equal(await adoBaseOf(bad, { readFile: reader(BASE + '/_git/r') }), undefined)
})

test('adoBaseOf: a worktree (.git is a file, so .git/config cannot be read) gives undefined: only the one config file is ever read', async () => {
  const { adoBaseOf } = await load()
  const enotdir = Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' })
  const paths = []
  assert.equal(await adoBaseOf('/ws', { readFile: async (p) => { paths.push(String(p).replace(/\\/g, '/')); throw enotdir } }), undefined)
  assert.deepEqual(paths, ['/ws/.git/config'])
})

test('adoBaseOf ignores an oversized config', async () => {
  const { adoBaseOf } = await load()
  assert.equal(await adoBaseOf('/ws', { readFile: async () => '#' + 'x'.repeat(300_000) + '\n' + config(BASE + '/_git/r') }), undefined)
})

// ---- createTask ----------------------------------------------------------------------------------------------------------------------

function fakeFetch(answer = { id: 4711 }, init = {}) {
  const calls = []
  const fn = async (url, opts) => { calls.push({ url: String(url), opts }); return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => answer } }
  fn.calls = calls
  return fn
}
const run = async (over = {}, task = { title: 'Apply tip: Bloom in src/a.js', description: 'A place.' }, base = BASE) => {
  const { createTask } = await load()
  const logs = []
  const fetchImpl = over.fetchImpl ?? fakeFetch()
  const result = await createTask(base, task, { env: { AZURE_DEVOPS_EXT_PAT: PAT }, fetchImpl, log: (l) => logs.push(l), ...over })
  return { result, logs, fetchImpl }
}

test('createTask POSTs one JSON patch (title and description only) to the $Task endpoint with Basic auth and returns id and url', async () => {
  const { result, fetchImpl } = await run()
  assert.deepEqual(result, { ok: true, id: 4711, url: BASE + '/_workitems/edit/4711' })
  assert.equal(fetchImpl.calls.length, 1)
  const { url, opts } = fetchImpl.calls[0]
  assert.equal(url, BASE + '/_apis/wit/workitems/$Task?api-version=7.0')
  assert.equal(opts.method, 'POST')
  assert.equal(opts.redirect, 'error')
  assert.equal(opts.headers['Content-Type'], 'application/json-patch+json')
  assert.equal(opts.headers.Authorization, 'Basic ' + B64)
  assert.ok(opts.signal)
  assert.deepEqual(JSON.parse(opts.body), [
    { op: 'add', path: '/fields/System.Title', value: 'Apply tip: Bloom in src/a.js' },
    { op: 'add', path: '/fields/System.Description', value: 'A place.' },
  ])
})

test('createTask accepts a visualstudio.com base and a trailing slash', async () => {
  const { result, fetchImpl } = await run({}, undefined, 'https://acme.visualstudio.com/Proj/')
  assert.equal(result.ok, true)
  assert.equal(fetchImpl.calls[0].url, 'https://acme.visualstudio.com/Proj/_apis/wit/workitems/$Task?api-version=7.0')
  assert.equal(result.url, 'https://acme.visualstudio.com/Proj/_workitems/edit/4711')
})

test('createTask strips markup characters and control characters and caps the title at 120 and the description at 500', async () => {
  const { result, fetchImpl } = await run({}, { title: '<script>alert(1)</script> A & B\u0000\n' + 'x'.repeat(300), description: '<b>bold</b> & "q"\r\n' + 'y'.repeat(900) })
  assert.equal(result.ok, true)
  const [title, description] = JSON.parse(fetchImpl.calls[0].opts.body).map((o) => o.value)
  assert.ok(title.length <= 120 && description.length <= 500, title.length + '/' + description.length)
  for (const text of [title, description]) { assert.ok(!/[<>&\u0000-\u001f]/.test(text), text); assert.ok(!/\s{2,}/.test(text)) }
  assert.match(title, /^script alert\(1\) \/script A B/)
})

test('createTask refuses an empty title, a non-string task and a missing PAT without calling fetch', async () => {
  for (const task of [{ title: '', description: 'd' }, { title: ' <> ', description: 'd' }, { title: 5, description: 'd' }, null, 'text']) {
    const { result, fetchImpl } = await run({}, task)
    assert.deepEqual(result, { ok: false, error: 'bad-task' })
    assert.equal(fetchImpl.calls.length, 0)
  }
  for (const env of [{}, { AZURE_DEVOPS_EXT_PAT: '' }, null]) {
    const { result, fetchImpl } = await run({ env })
    assert.deepEqual(result, { ok: false, error: 'no-pat' })
    assert.equal(fetchImpl.calls.length, 0)
  }
})

test('createTask never sends the PAT to an untrusted host, http, a look-alike host or a base with credentials', async () => {
  for (const base of ['https://evil.example/o/p', 'http://dev.azure.com/o/p', 'https://dev.azure.com.evil.example/o/p', 'https://dev.azure.com@evil.example/o/p', 'https://u:p@dev.azure.com/o/p', 'not a url', '', null]) {
    const { result, fetchImpl, logs } = await run({}, undefined, base)
    assert.deepEqual(result, { ok: false, error: 'untrusted-host' }, String(base))
    assert.equal(fetchImpl.calls.length, 0)
    assert.ok(!logs.join('\n').includes(PAT))
  }
})

test('createTask maps failures to short codes: http-<status>, unreachable (redirect refused, timeout, network), bad-answer', async () => {
  assert.deepEqual((await run({ fetchImpl: fakeFetch({}, { ok: false, status: 401 }) })).result, { ok: false, error: 'http-401' })
  assert.deepEqual((await run({ fetchImpl: fakeFetch({}, { ok: false, status: 203 }) })).result, { ok: false, error: 'http-203' })
  assert.deepEqual((await run({ fetchImpl: async () => { throw new TypeError('redirect mode is set to error') } })).result, { ok: false, error: 'unreachable' })
  assert.deepEqual((await run({ fetchImpl: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) } })).result, { ok: false, error: 'unreachable' })
  for (const answer of [{}, { id: 'abc' }, { id: -1 }, { id: 0 }, null, 'text']) assert.deepEqual((await run({ fetchImpl: fakeFetch(answer) })).result, { ok: false, error: 'bad-answer' }, JSON.stringify(answer))
  assert.deepEqual((await run({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json') } }) })).result, { ok: false, error: 'bad-answer' })
})

test('createTask passes redirect:error so a redirect cannot carry the PAT to another host', async () => {
  const { fetchImpl } = await run()
  assert.equal(fetchImpl.calls[0].opts.redirect, 'error')
})

test('the PAT and its base64 never appear in a log line, an error code or the result, even when the error text carries them', async () => {
  const leaky = async () => { throw new Error('boom ' + PAT + ' and ' + B64) }
  const { result, logs } = await run({ fetchImpl: leaky })
  const all = JSON.stringify(result) + '\n' + logs.join('\n')
  assert.ok(!all.includes(PAT) && !all.includes(B64), all)
  assert.deepEqual(result, { ok: false, error: 'unreachable' })
  const ok = await run()
  assert.ok(!(JSON.stringify(ok.result) + ok.logs.join('\n')).includes(PAT))
  const bad = await run({ fetchImpl: fakeFetch({}, { ok: false, status: 500 }) })
  assert.ok(!(JSON.stringify(bad.result) + bad.logs.join('\n')).includes(B64))
})

test('createTask never throws (a throwing log, an odd env, a base that is an object)', async () => {
  const { createTask } = await load()
  const r = await createTask(BASE, { title: 't', description: 'd' }, { env: { AZURE_DEVOPS_EXT_PAT: PAT }, fetchImpl: async () => { throw new Error('x') }, log: () => { throw new Error('log') } })
  assert.equal(r.ok, false)
  assert.equal((await createTask({}, { title: 't' }, {})).ok, false)
  assert.equal((await createTask(BASE, { title: 't' }, { env: {}, fetchImpl: async () => { throw new Error('x') } })).ok, false)
})

// ---- review fixes: bounded config read, port, segments, '#' ------------------------------------------------------------------------

test('adoBaseOf default reader: a regular small config works; an oversized file, a directory and a symlink give undefined', async () => {
  const { adoBaseOf } = await load()
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs')
  const { constants } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'adoc-'))
  try {
    const mk = (name) => { const d = join(root, name); mkdirSync(join(d, '.git'), { recursive: true }); return d }
    const ok = mk('ok'); writeFileSync(join(ok, '.git', 'config'), config(BASE + '/_git/r'))
    assert.equal(await adoBaseOf(ok), BASE)
    const big = mk('big'); writeFileSync(join(big, '.git', 'config'), '#' + 'x'.repeat(300_000) + '\n' + config(BASE + '/_git/r'))
    assert.equal(await adoBaseOf(big), undefined)
    const dir = mk('dir'); mkdirSync(join(dir, '.git', 'config'))
    assert.equal(await adoBaseOf(dir), undefined)
    const link = mk('link'); writeFileSync(join(root, 'real'), config(BASE + '/_git/r'))
    let linked = true
    try { symlinkSync(join(root, 'real'), join(link, '.git', 'config')) } catch { linked = false }
    if (linked && constants.O_NOFOLLOW) assert.equal(await adoBaseOf(link), undefined, 'a symlink is not followed (needs O_NOFOLLOW, absent on Windows)')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a base with a port is not trusted: adoBaseOf and createTask refuse it', async () => {
  const { adoBaseOf } = await load()
  assert.equal(await adoBaseOf('/ws', { readFile: reader('https://dev.azure.com:8443/o/p/_git/r') }), undefined)
  assert.equal(await adoBaseOf('/ws', { readFile: reader('https://o.visualstudio.com:444/p/_git/r') }), undefined)
  const { result, fetchImpl } = await run({}, undefined, 'https://dev.azure.com:8443/o/p')
  assert.deepEqual(result, { ok: false, error: 'untrusted-host' })
  assert.equal(fetchImpl.calls.length, 0)
})

test('ssh and https org/project segments: only word characters, dot, dash, space; . and .. refused; output is percent-encoded', async () => {
  const { adoBaseOf } = await load()
  for (const url of ['git@ssh.dev.azure.com:v3/../p/r', 'git@ssh.dev.azure.com:v3/o/../r', 'git@ssh.dev.azure.com:v3/./p/r', 'git@ssh.dev.azure.com:v3/%2e%2e/p/r', 'git@ssh.dev.azure.com:v3/o/p%3Fx/r', 'git@ssh.dev.azure.com:v3/o?x/p/r',
    'https://dev.azure.com/o/%2e%2e/_git/r', 'https://dev.azure.com/o/../_git/r', 'https://dev.azure.com/o/p%3Fx/_git/r', 'https://dev.azure.com/o/p%2Fq/_git/r']) {
    assert.equal(await adoBaseOf('/ws', { readFile: reader(url) }), undefined, url)
  }
  assert.equal(await adoBaseOf('/ws', { readFile: reader('git@ssh.dev.azure.com:v3/my.org-1/My%20Project/r') }), 'https://dev.azure.com/my.org-1/My%20Project')
  assert.equal(await adoBaseOf('/ws', { readFile: reader('git@ssh.dev.azure.com:v3/my.org-1/My Project/r') }), 'https://dev.azure.com/my.org-1/My%20Project')
})

test("createTask replaces '#' with a space in title and description (no AB#<n> auto-link)", async () => {
  const { fetchImpl, result } = await run({}, { title: 'Apply AB#123 in #45', description: 'See AB#999 and #7.' })
  assert.equal(result.ok, true)
  const [title, description] = JSON.parse(fetchImpl.calls[0].opts.body).map((o) => o.value)
  assert.ok(!title.includes('#') && !description.includes('#'), title + ' | ' + description)
  assert.equal(title, 'Apply AB 123 in 45')
})
// ---- security review fixes: linear origin parsing, open-first bounded read, base64 scrub -------------------------------------------------

test('origin parsing is linear: a 100k-space url line, a 100k-space tail and a long run of slashes return fast; a normal config still parses', async () => {
  const { adoBaseOf } = await load()
  const cases = [
    '[remote "origin"]\n\turl = a' + ' '.repeat(100_000) + 'b\n',
    '[remote "origin"]\n\turl = ' + BASE + '/_git/r' + ' '.repeat(100_000) + '\n',
    '[remote "origin"]\n' + ' '.repeat(100_000) + 'x\n\turl = ' + BASE + '/_git/r\n',
    '[remote "origin"]\n\turl = git@ssh.dev.azure.com:v3/' + 'a/'.repeat(50_000) + '\n',
  ]
  for (const text of cases) {
    const t0 = performance.now()
    const got = await adoBaseOf('/ws', { readFile: async () => text })
    assert.ok(performance.now() - t0 < 500, 'took too long')
    assert.ok(got === undefined || got === BASE)
  }
  const t1 = performance.now()
  assert.equal(await adoBaseOf('/'.repeat(100_000) + 'x', { readFile: async () => config(BASE + '/_git/r') }), BASE)
  assert.ok(performance.now() - t1 < 500, 'slash run too slow')
  assert.equal(await adoBaseOf('/ws', { readFile: async () => config(BASE + '/_git/r') }), BASE)
  assert.equal(await adoBaseOf('/ws', { readFile: async () => '[remote "origin"]\n\turl =   ' + BASE + '/_git/r   \n' }), BASE, 'trimmed')
})

test('adoBaseOf default reader (open-first): normal file, directory, oversized and missing give the right answers, a symlink is not followed when creatable', async () => {
  const { adoBaseOf } = await load()
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'adoc2-'))
  try {
    const mk = (name) => { const d = join(root, name); mkdirSync(join(d, '.git'), { recursive: true }); return d }
    const ok = mk('ok'); writeFileSync(join(ok, '.git', 'config'), config(BASE + '/_git/r'))
    assert.equal(await adoBaseOf(ok), BASE)
    const exact = mk('exact'); const body = config(BASE + '/_git/r'); writeFileSync(join(exact, '.git', 'config'), body + '#'.repeat(200_000 - body.length))
    assert.equal(await adoBaseOf(exact), BASE, 'exactly 200000 bytes is allowed')
    const big = mk('big'); writeFileSync(join(big, '.git', 'config'), config(BASE + '/_git/r') + '#'.repeat(200_000))
    assert.equal(await adoBaseOf(big), undefined)
    const dir = mk('dir'); mkdirSync(join(dir, '.git', 'config'))
    assert.equal(await adoBaseOf(dir), undefined)
    assert.equal(await adoBaseOf(mk('missing')), undefined)
    const link = mk('link'); writeFileSync(join(root, 'real'), config(BASE + '/_git/r'))
    let linked = true
    try { symlinkSync(join(root, 'real'), join(link, '.git', 'config')) } catch { linked = false }
    if (linked) {
      const { constants } = await import('node:fs')
      if (constants.O_NOFOLLOW) assert.equal(await adoBaseOf(link), undefined, 'a symlink is not followed')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('createTask log lines carry neither the PAT nor its base64 form', async () => {
  const leaky = async () => { throw Object.assign(new Error('x'), { name: 'E ' + B64 + ' ' + PAT }) }
  const { logs } = await run({ fetchImpl: leaky })
  assert.ok(logs.length > 0)
  for (const line of logs) assert.ok(!line.includes(PAT) && !line.includes(B64), line)
})

// ---- review fixes: symlinked config (O_NOFOLLOW is absent on win32), a status that is not a number ----------------------------------------

test('adoBaseOf default reader: a symlinked .git/config is refused on every platform, a regular one is read', async (t) => {
  const { adoBaseOf } = await load()
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'adoc-ln-'))
  try {
    const ws = join(root, 'ws'); mkdirSync(join(ws, '.git'), { recursive: true })
    writeFileSync(join(ws, '.git', 'config'), config(BASE + '/_git/r'))
    assert.equal(await adoBaseOf(ws), BASE)
    const linked = join(root, 'linked'); mkdirSync(join(linked, '.git'), { recursive: true })
    writeFileSync(join(root, 'other'), config('https://dev.azure.com/evil/Proj/_git/r'))
    try { symlinkSync(join(root, 'other'), join(linked, '.git', 'config')) } catch { t.skip('symlinks are not allowed here'); return }
    assert.equal(await adoBaseOf(linked), undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('createTask: a response without a usable status gives http-error, never http-NaN', async () => {
  const { createTask } = await load()
  const env = { AZURE_DEVOPS_EXT_PAT: PAT }
  for (const res of [{ ok: false }, { ok: false, status: 'abc' }, { ok: false, status: 99 }, { ok: false, status: 600 }, { ok: false, status: 12.5 }, undefined]) {
    assert.deepEqual(await createTask(BASE, { title: 't' }, { env, fetchImpl: async () => res }), { ok: false, error: 'http-error' }, JSON.stringify(res))
  }
  assert.deepEqual(await createTask(BASE, { title: 't' }, { env, fetchImpl: async () => ({ ok: false, status: 403 }) }), { ok: false, error: 'http-403' })
})