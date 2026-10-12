import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'

// A permissive stand-in for the cordis context; named services can be made to throw like an un-injected service.
function fakeCtx(throwing = []) {
  const mk = (path) => new Proxy(function () {}, {
    get(_t, k) {
      if (typeof k === 'symbol' || k === 'then') return undefined
      if (path === 'ctx' && throwing.includes(k)) throw new Error('service ' + String(k) + ' is not injected')
      return mk(path + '.' + String(k))
    },
    apply() { return mk(path + '()') },
  })
  return mk('ctx')
}

test('apply() survives a ctx.llm that throws when read (service not injected)', () => {
  assert.doesNotThrow(() => apply(fakeCtx(['llm']), {}))
})
