import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const coreSource = read('../lib/mobile/core.js').replace('export function loadCore', 'function loadCore') + '\n;loadCore'
const overlaySource = read('../lib/client.js')

/** A browser stand-in: appending the script element "loads" it by running `source` in the same context, then fires onload (or onerror). */
function browser({ source = overlaySource, fail = false } = {}) {
  const appended = []
  const context = { Error, Symbol, Promise, setTimeout, Object, Date, JSON, Array, Math, Number, String, RegExp }
  context.window = context
  context.document = {
    head: {
      append(script) {
        appended.push(script)
        setTimeout(() => {
          if (fail) return script.onerror()
          try { vm.runInContext(source, context); script.onload() } catch (error) { script.onerror(error) }
        }, 0)
      },
    },
    createElement: (tag) => ({ tag }),
  }
  vm.createContext(context)
  return { context, appended, loadCore: vm.runInContext(coreSource, context) }
}

test('loadCore loads ./overlay.js and resolves the pure shared helpers', async () => {
  const { loadCore, appended } = browser()
  const shared = await loadCore()
  assert.equal(appended.length, 1)
  assert.equal(appended[0].src, './overlay.js')
  assert.equal(shared.typeLabel('permission').length > 0, true)
  assert.equal(typeof shared.pruneSaved, 'function')
  assert.equal(typeof shared.errorText, 'function')
  assert.equal(shared.fmtAge(0), 'just now')
})

test('the module loader hook is removed from window once the overlay has registered', async () => {
  const { loadCore, context } = browser()
  await loadCore()
  assert.equal('__ModuleLoader__' in context, false)
})

test('an overlay bundle without shared helpers (server older than the page) is a clear error', async () => {
  const old = 'window.__ModuleLoader__.load({ id: "x", factory: () => ({ exports: {} }) })'
  const { loadCore, context } = browser({ source: old })
  await assert.rejects(loadCore(), /no shared helpers/)
  assert.equal('__ModuleLoader__' in context, false)
})

test('a bundle that throws while starting rejects', async () => {
  const { loadCore } = browser({ source: 'throw new Error("boom")' })
  await assert.rejects(loadCore(), /boom|loaded/)
})

test('a script that cannot be fetched rejects', async () => {
  const { loadCore } = browser({ fail: true })
  await assert.rejects(loadCore(), /could not be loaded/)
})
