// Shared helpers of the hub tests: temp dirs, a fake clock with timers, an in-memory file pair and a raw HTTP client.
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rq-hub-test-'))
  t?.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** now() plus setTimeout/clearTimeout driven by advance(ms), in due order. */
export function fakeClock(start = 1_000_000) {
  let t = start
  let id = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimeout(fn, ms) { const h = { id: ++id, at: t + ms, fn, unref() {} }; timers.set(h.id, h); return h },
    clearTimeout(h) { if (h) timers.delete(h.id) },
    pending: () => timers.size,
    advance(ms) {
      const end = t + ms
      for (;;) {
        const due = [...timers.values()].filter((h) => h.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!due) break
        timers.delete(due.id)
        t = Math.max(t, due.at)
        due.fn()
      }
      t = end
    },
  }
}

/** The io pair the hub store writes to: main and .bak text in memory; every write is recorded. */
export function memIo({ main, bak } = {}) {
  const files = { main, bak }
  const writes = []
  return {
    files,
    writes,
    read: (which) => files[which],
    write(text, { rotate = false } = {}) {
      if (this.failNext) { this.failNext--; throw new Error('disk full') }
      writes.push({ text, rotate })
      if (rotate && files.main !== undefined) files.bak = files.main
      files.main = text
    },
    failNext: 0,
  }
}

export async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

export async function waitFor(check, ms = 10_000, what = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out waiting for ' + what)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

/** One request with full control of the headers (fetch cannot set Host). Answers { status, headers, text, json }. */
export function raw({ port, method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

export const postJson = (port, path, body, headers = {}) =>
  raw({ port, method: 'POST', path, headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
