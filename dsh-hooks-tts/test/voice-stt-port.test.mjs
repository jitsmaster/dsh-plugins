import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePort } from '../voice/stt-port.js'

test('normalizePort accepts integers 1-65535 (numbers or numeric strings) and falls back otherwise', () => {
  assert.equal(normalizePort(8890), 8890)
  assert.equal(normalizePort('9001'), 9001)
  assert.equal(normalizePort(1), 1)
  assert.equal(normalizePort(65535), 65535)
  for (const bad of [0, -1, 65536, 80.5, '80/../x', '8890; calc', NaN, Infinity, null, undefined, {}, [], true, '']) {
    assert.equal(normalizePort(bad), 8890, String(bad))
  }
  assert.equal(normalizePort('x', 1234), 1234)
})
