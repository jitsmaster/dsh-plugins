import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionRegistry } from '../sessions.js'
import { startServer, memo } from '../server.js'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const PORT = 38084
const ORIGIN = 'http://127.0.0.1:3080'
let tmp, repo, handle, resolveCalls

function call(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { Origin: ORIGIN } }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        let json
        try { json = JSON.parse(buf.toString('utf8')) } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-view-sh-')))
  repo = join(tmp, 'repo'); mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@e.com'); sh(repo, 'config', 'user.name', 'T'); sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'a.txt'), 'one\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init')
  sh(repo, 'checkout', '-qb', 'feature')
  writeFileSync(join(repo, 'a.txt'), 'one\nBRANCH\n'); sh(repo, 'commit', '-qam', 'feat')
  const real = createSessionRegistry({ stateDir: join(tmp, 'state') })
  real.seen('sess', repo)
  resolveCalls = []
  const registry = { ...real, resolve: (id, opts) => { resolveCalls.push(opts ?? {}); return real.resolve(id, opts) } }
  handle = startServer({ registry, logger: { warn: () => {} }, port: PORT, webUrl: ORIGIN })
  await new Promise(r => handle.server.once('listening', r))
})
after(() => { handle?.close(); try { rmSync(tmp, { recursive: true, force: true }) } catch { /* windows locks */ } })

test('memo: a rejecting loader neither leaves an unhandled rejection nor stays cached', async () => {
  const unhandled = []
  const onUnhandled = (e) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  try {
    let calls = 0
    const m = memo(async () => { calls++; throw new Error('boom') })
    await assert.rejects(m('k'), /boom/)
    await new Promise(r => setTimeout(r, 50)) // let any dangling derived promise surface
    assert.deepEqual(unhandled, [])
    await assert.rejects(m('k'), /boom/)
    assert.equal(calls, 2, 'a rejected entry is evicted, not served again')
  } finally { process.off('unhandledRejection', onUnhandled) }
})

test('memo: concurrent identical reads share one load, and a synchronous throw becomes a rejection', async () => {
  let calls = 0
  const m = memo(async () => { calls++; return 7 })
  assert.deepEqual(await Promise.all([m('k'), m('k')]), [7, 7])
  assert.equal(calls, 1)
  await assert.rejects(memo(() => { throw new Error('sync') })('k'), /sync/)
})

test('non-GET/HEAD/OPTIONS requests get 405', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await call('/v1/snapshot?session=sess', method)
    assert.equal(r.status, 405, method)
    assert.match(r.headers.allow, /GET/)
  }
  assert.equal((await call('/v1/snapshot?session=sess', 'OPTIONS')).status, 204)
  assert.equal((await call('/v1/snapshot?session=sess', 'HEAD')).status, 200)
})

test('branch diffs ignore the client-supplied base and use the server-derived compare base', async () => {
  const r = await call('/v1/diff?session=sess&scope=branch&path=a.txt&base=' + encodeURIComponent('no-such-ref'))
  assert.equal(r.json.ok, true, JSON.stringify(r.json))
  assert.match(r.json.patch, /^\+BRANCH$/m)
  const evil = await call('/v1/diff?session=sess&scope=branch&path=a.txt&base=--output%3Dpwned')
  assert.equal(evil.json.ok, true)
  assert.match(evil.json.patch, /^\+BRANCH$/m)
})

test('resolve is cached per session briefly and only snapshots list worktrees', async () => {
  await new Promise(r => setTimeout(r, 900)) // let earlier cache entries expire
  resolveCalls.length = 0
  await Promise.all([call('/v1/history?session=sess'), call('/v1/history?session=sess'), call('/v1/diff?session=sess&scope=all&path=a.txt')])
  assert.equal(resolveCalls.length, 1, 'concurrent non-snapshot routes share one resolve')
  assert.equal(resolveCalls[0].worktrees, false, 'worktree list is skipped off the snapshot route')
  const before = resolveCalls.length
  // Concurrent, not sequential: git can be slow on a loaded machine, so a TTL-based assertion would be flaky.
  await Promise.all([call('/v1/snapshot?session=sess'), call('/v1/snapshot?session=sess')])
  assert.equal(resolveCalls.length - before, 1, 'concurrent snapshots share one resolve')
  assert.equal(resolveCalls.at(-1).worktrees, true)
})
