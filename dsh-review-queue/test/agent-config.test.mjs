import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hubEnabled, instanceKeyOf, instanceLabelOf } from '../agent/config.js'

test('the hub is on by default; hub:false or DSH_RQ_HUB=0 switch it off, either one', () => {
  assert.equal(hubEnabled({}, {}), true)
  assert.equal(hubEnabled({ hub: true }, { DSH_RQ_HUB: '1' }), true)
  assert.equal(hubEnabled({ hub: false }, {}), false)
  assert.equal(hubEnabled({}, { DSH_RQ_HUB: '0' }), false)
  assert.equal(hubEnabled({ hub: true }, { DSH_RQ_HUB: '0' }), false)
  assert.equal(hubEnabled({ hub: false }, { DSH_RQ_HUB: '1' }), false)
  assert.equal(hubEnabled({ hub: 'no' }, {}), true, 'only the boolean false counts')
})

test('the instance key is the DSH home plus the web port: the same app after a restart, another one on another port', () => {
  const a = instanceKeyOf({ dshHome: 'C:\\Users\\a\\.dsh', port: 64047 })
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.equal(a, instanceKeyOf({ dshHome: 'C:\\Users\\a\\.dsh', port: 64047 }))
  assert.notEqual(a, instanceKeyOf({ dshHome: 'C:\\Users\\a\\.dsh', port: 53231 }))
  assert.notEqual(a, instanceKeyOf({ dshHome: 'C:\\Users\\b\\.dsh', port: 64047 }))
  assert.notEqual(instanceKeyOf({ dshHome: 'h', port: 1 }), instanceKeyOf({ dshHome: 'h1', port: undefined }) , 'no collision by concatenation')
})

test('without a web port the key is made from the pid and the start time, so nothing is ever adopted', () => {
  const k = instanceKeyOf({ dshHome: 'h', port: undefined, pid: 321, startedAt: 1000 })
  assert.match(k, /^pid-321-/)
  assert.notEqual(k, instanceKeyOf({ dshHome: 'h', port: undefined, pid: 321, startedAt: 2000 }))
  assert.match(instanceKeyOf({ dshHome: 'h', port: 0, pid: 5, startedAt: 1 }), /^pid-5-/, 'port 0 is no port')
})

test('the label is the configured one, else "DSH :<port>", else "DSH"', () => {
  assert.equal(instanceLabelOf({ instanceLabel: '  Work app ' }, 64047), 'Work app')
  assert.equal(instanceLabelOf({}, 64047), 'DSH :64047')
  assert.equal(instanceLabelOf({ instanceLabel: '' }, undefined), 'DSH')
  assert.equal(instanceLabelOf({ instanceLabel: 'x'.repeat(200) }, 1).length, 80)
  assert.equal(instanceLabelOf({ instanceLabel: 5 }, 7), 'DSH :7')
})
