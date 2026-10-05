/**
 * Developer harness (not shipped): renders lib/client.js with real React in a plain browser page,
 * backed by the real server and a generated demo repository, so the UI can be exercised without
 * restarting DSH.
 *
 *   node test/harness/serve.mjs [--esbuild <path to esbuild main.js>] [--react <dir containing node_modules/react>]
 * then open http://127.0.0.1:3090/
 */
import http from 'node:http'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionRegistry } from '../../sessions.js'
import { startServer } from '../../server.js'

const here = dirname(fileURLToPath(import.meta.url))
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
// Defaults: whatever require.resolve finds from this checkout (esbuild), else the DSH checkout's pnpm store. The versions in
// those paths are what DSH shipped when this was written and may have moved; a missing path fails here, naming the flag to pass.
const pnpm = 'D:/dev/DSH/node_modules/.pnpm'
const req = createRequire(import.meta.url)
const found = (spec, fallback) => { try { return req.resolve(spec) } catch { return fallback } }
const must = (flag, path) => {
  if (!existsSync(path)) { console.error(`harness: ${flag} path not found: ${path}\nInstall it here or pass ${flag} <path> (a DSH checkout is expected at ${pnpm}).`); process.exit(1) }
  return path
}
const esbuild = req(must('--esbuild', arg('--esbuild', found('esbuild', `${pnpm}/esbuild@0.28.1/node_modules/esbuild/lib/main.js`))))
const reactDir = must('--react', arg('--react', `${pnpm}/react@18.3.1/node_modules`))
const reactDomDir = must('--react-dom', arg('--react-dom', `${pnpm}/react-dom@18.3.1_react@18.3.1/node_modules`))

const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8Dwn4GBgYEBRAAAKw4D/YVSKd8AAAAASUVORK5CYII=', 'base64')
const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGNgYPj/n4GB4T8DAwMAEQ8D/XvqTHcAAAAASUVORK5CYII=', 'base64')

function demoRepo() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-view-demo-')))
  const repo = join(tmp, 'shop')
  mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 'dev@example.com'); sh(repo, 'config', 'user.name', 'Dev'); sh(repo, 'config', 'commit.gpgsign', 'false')
  mkdirSync(join(repo, 'src', 'lib'), { recursive: true })
  const big = Array.from({ length: 60 }, (_, i) => `export const item${i} = ${i} // keep`).join('\n') + '\n'
  writeFileSync(join(repo, 'src', 'cart.ts'), `import { price } from './price'\n\nexport function total(items: number[]) {\n  let sum = 0\n  for (const i of items) sum += price(i)\n  return sum\n}\n\n${big}`)
  writeFileSync(join(repo, 'src', 'price.ts'), 'export const price = (n: number) => n * 100\n')
  writeFileSync(join(repo, 'src', 'lib', 'old-util.ts'), 'export const util = 1\nexport const util2 = 2\nexport const util3 = 3\nexport const util4 = 4\n')
  writeFileSync(join(repo, 'README.md'), '# Shop\n')
  writeFileSync(join(repo, 'logo.png'), PNG_A)
  sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'initial shop')
  const wt = join(tmp, 'shop-feature-discounts')
  sh(repo, 'worktree', 'add', '-q', '-b', 'feature/discounts', wt)
  // committed work on the branch
  writeFileSync(join(wt, 'src', 'discount.ts'), 'export const discount = (p: number) => p * 0.9\n')
  sh(wt, 'add', '.'); sh(wt, 'commit', '-qm', 'feat: add discount helper')
  writeFileSync(join(wt, 'src', 'price.ts'), 'import { discount } from "./discount"\nexport const price = (n: number) => discount(n * 100)\n')
  writeFileSync(join(wt, 'logo.png'), PNG_B)
  sh(wt, 'commit', '-qam', 'feat: apply discount to price; new logo')
  // uncommitted work: staged, unstaged, untracked, rename
  writeFileSync(join(wt, 'src', 'cart.ts'), readFileSync(join(wt, 'src', 'cart.ts'), 'utf8').replace('let sum = 0', 'let sum = 0\n  // apply a coupon at the end').replace('return sum', 'return Math.round(sum)'))
  writeFileSync(join(wt, 'README.md'), '# Shop\n\nDiscounts are applied per item.\n')
  sh(wt, 'add', 'README.md')
  writeFileSync(join(wt, 'README.md'), '# Shop\n\nDiscounts are applied per item.\n\nSee `src/discount.ts`.\n')
  sh(wt, 'mv', 'src/lib/old-util.ts', 'src/lib/util.ts')
  writeFileSync(join(wt, 'src', 'coupon.ts'), 'export type Coupon = { code: string; pct: number }\nexport const apply = (c: Coupon, p: number) => p * (1 - c.pct / 100)\n')
  writeFileSync(join(wt, 'notes.bin'), Buffer.from([0, 1, 2, 3]))
  return { tmp, repo, wt }
}

const { repo, wt } = demoRepo()
const ORIGIN = 'http://127.0.0.1:3090'
const registry = createSessionRegistry({ stateDir: join(tmpdir(), 'dsh-git-view-demo-state-' + Date.now()), workspacePaths: () => [repo] })
registry.seen('demo-session', repo)
await registry.observe('demo-session', { command: `git -C "${wt}" status` })
registry.seen('plain-session', repo)
const API_PORT = 3083 // not 3082, which a running DSH may already hold
startServer({ registry, logger: console, webUrl: ORIGIN, port: API_PORT })

await esbuild.build({
  stdin: {
    contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      window.__ModuleLoader__ = { load: (reg) => {
        const mod = reg.factory(() => React)
        const params = new URLSearchParams(location.search)
        const sessionId = params.get('session') || 'demo-session'
        const cwd = ${JSON.stringify(repo)}
        const props = {
          sessionId,
          useTabInfo: () => ({ tab: { visible: true, title: 'Git' } }),
          useSessions: (sel) => sel({ byId: { [sessionId]: { cwd } } }),
        }
        createRoot(document.getElementById('root')).render(React.createElement(mod.GitTab, props))
      } }
    `,
    resolveDir: here,
  },
  bundle: true, write: false, outfile: 'out.js', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' },
  nodePaths: [reactDir, reactDomDir],
}).then((r) => { globalThis.__bundle = r.outputFiles[0].text })

const page = `<!doctype html><meta charset=utf-8><title>dsh-git-view harness</title>
<style>html,body{margin:0;height:100%;background:#151517;color:#f9fafb;font-family:-apple-system,"Segoe UI",sans-serif}
#root{width:440px;height:100vh;border-right:1px solid #333}</style>
<div id=root></div><script>window.__GIT_VIEW_PORT__=${API_PORT}</script><script src=/bundle.js></script><script src=/client.js></script>`
http.createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (path === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(globalThis.__bundle) }
  if (path === '/client.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(readFileSync(join(here, '..', '..', 'lib', 'client.js'))) }
  res.setHeader('Content-Type', 'text/html'); res.end(page)
}).listen(3090, '127.0.0.1', () => console.log(`harness ready: ${ORIGIN}/  (repo ${repo}, worktree ${wt})`))
