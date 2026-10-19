import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

test('cordis.patch.yml lists the question window setting next to the other question settings', () => {
  assert.match(index, /questionWindowSeconds/)
  const line = yml.split('\n').find((l) => /questionAutoAnswerLeadSeconds/.test(l))
  assert.ok(line, 'the key list line')
  assert.match(yml, /questionWindowSeconds \(120\)/)
})
