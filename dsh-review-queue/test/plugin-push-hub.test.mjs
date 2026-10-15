// With the hub on, push belongs to the hub (VAPID key, subscriptions, notifier): the app writes no vapid.json / push.json of its own and its
// instance route has no push routes, so a phone cannot subscribe at an app by mistake.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeWorld, startPlugin } from './plugin-helpers.mjs'

test('hub mode: no vapid.json or push.json is created by the app, and the instance has no /v1/push routes', async (t) => {
  const world = await makeWorld(t)
  const p = await startPlugin(t, world, { label: 'T', webPort: 12201 })
  const res = await p.get('/v1/push/key')
  assert.deepEqual([res.status, res.json], [404, { error: 'unknown-action' }])
  assert.equal(existsSync(join(world.dir, 'vapid.json')), false)
  assert.equal(existsSync(join(world.dir, 'push.json')), false)
})

test('hub off (standalone as before): the app still serves its own push routes and key', async (t) => {
  const world = await makeWorld(t)
  const p = await startPlugin(t, world, { label: 'T', webPort: 12202, config: { hub: false } })
  const res = await p.get('/v1/push/key')
  assert.equal(res.status, 200)
  assert.equal(typeof res.json.key, 'string')
})
