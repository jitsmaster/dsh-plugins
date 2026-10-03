import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionRegistry } from '../sessions.js'
import { startServer } from '../server.js'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const PORT = 38082
const ORIGIN = 'http://127.0.0.1:3080'
let tmp, repo, handle

function call(path, { method = 'GET', origin = ORIGIN, host, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { ...(origin ? { Origin: origin } : {}), ...(host ? { Host: host } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        let json
        try { json = JSON.parse(buf.toString('utf8')) } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-view-h-')))
  repo = join(tmp, 'repo'); mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@e.com'); sh(repo, 'config', 'user.name', 'T'); sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init')
  const registry = createSessionRegistry({ stateDir: join(tmp, 'state') })
  registry.seen('sess', repo)
  handle = startServer({ registry, logger: { warn: () => {} }, port: PORT, webUrl: ORIGIN })
  await new Promise(r => handle.server.once('listening', r))
})
after(() => { handle?.close(); try { rmSync(tmp, { recursive: true, force: true }) } catch { /* windows locks */ } })

test('requests without the DSH web origin are refused', async () => {
  assert.equal((await call('/v1/snapshot?session=sess', { origin: null })).status, 403)
  assert.equal((await call('/v1/snapshot?session=sess', { origin: 'https://evil.example' })).status, 403)
})

test('a rebinding Host header is refused', async () => {
  assert.equal((await call('/v1/snapshot?session=sess', { host: 'evil.example:' + PORT })).status, 403)
})

test('snapshot returns status, worktrees and branch compare for the session', async () => {
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  writeFileSync(join(repo, 'n.txt'), 'new\n')
  const r = await call('/v1/snapshot?session=sess')
  assert.equal(r.status, 200)
  assert.equal(r.headers['access-control-allow-origin'], ORIGIN)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.status.branch.name, 'main')
  assert.equal(r.json.status.changes[0].path, 'a.txt')
  assert.equal(r.json.status.untracked[0].path, 'n.txt')
  assert.equal(r.json.worktrees.length, 1)
  assert.equal(r.json.source, 'cwd')
})

test('an unknown session is an ok:false answer, not a crash', async () => {
  const r = await call('/v1/snapshot?session=ghost')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, false)
})

test('diff endpoint returns a patch and rejects traversal', async () => {
  const d = await call('/v1/diff?session=sess&scope=unstaged&path=a.txt')
  assert.match(d.json.patch, /^\+two$/m)
  const bad = await call('/v1/diff?session=sess&scope=unstaged&path=' + encodeURIComponent('../../etc/passwd'))
  assert.equal(bad.json.ok, false)
})

test('the session cannot be pointed at another folder through query parameters', async () => {
  const r = await call('/v1/snapshot?session=sess&worktree=' + encodeURIComponent(tmp) + '&cwd=' + encodeURIComponent(tmp))
  assert.equal(r.json.status.root, repo)
})

test('image blobs are served with their mime type and a locked-down CSP', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  writeFileSync(join(repo, 'p.png'), png)
  const r = await call('/v1/blob?session=sess&scope=untracked&path=p.png&side=new')
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'image/png')
  assert.match(r.headers['content-security-policy'], /sandbox/)
  assert.deepEqual(r.body, png)
  assert.equal((await call('/v1/blob?session=sess&scope=untracked&path=p.png&side=old')).status, 204)
})

test('there is no route that changes the repository', async () => {
  for (const path of ['/v1/stage', '/v1/unstage', '/v1/commit-now', '/v1/refs', '/v1/checkout']) {
    const r = await call(path + '?session=sess', { method: 'POST', body: { paths: ['n.txt'] } })
    assert.equal(r.status, 405, path)
  }
  const s = (await call('/v1/snapshot?session=sess')).json.status
  assert.deepEqual(s.staged, [], 'nothing was staged')
})

test('worktree and base query parameters are ignored: the session decides', async () => {
  const r = await call('/v1/snapshot?session=sess&worktree=' + encodeURIComponent(tmp) + '&base=--output%3Dx')
  assert.equal(r.json.status.root, repo)
  assert.equal(r.json.source, 'cwd')
})