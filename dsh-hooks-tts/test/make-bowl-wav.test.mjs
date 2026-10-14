// scripts/make-bowl-wav.mjs synthesises the singing-bowl strike played instead of the spoken "Deciding with LLM." line
// (assets/bowl.wav is its committed output). No dependencies; no randomness, so the file is reproducible.
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import test from 'node:test'
import { synthBowl } from '../scripts/make-bowl-wav.mjs'

const ASSET = new URL('../assets/bowl.wav', import.meta.url)

function parse(buf) {
  return {
    riff: buf.toString('ascii', 0, 4), size: buf.readUInt32LE(4), wave: buf.toString('ascii', 8, 12), fmt: buf.toString('ascii', 12, 16),
    fmtLen: buf.readUInt32LE(16), format: buf.readUInt16LE(20), channels: buf.readUInt16LE(22), rate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28), align: buf.readUInt16LE(32), bits: buf.readUInt16LE(34), data: buf.toString('ascii', 36, 40), dataLen: buf.readUInt32LE(40),
    samples: Array.from({ length: (buf.length - 44) / 2 }, (_, i) => buf.readInt16LE(44 + i * 2)),
  }
}

test('B1 the bowl is a valid 16-bit mono PCM RIFF/WAVE file whose chunk sizes match its length', () => {
  const buf = synthBowl()
  const w = parse(buf)
  assert.equal(w.riff, 'RIFF'); assert.equal(w.wave, 'WAVE'); assert.equal(w.fmt, 'fmt '); assert.equal(w.data, 'data')
  assert.equal(w.fmtLen, 16); assert.equal(w.format, 1); assert.equal(w.channels, 1); assert.equal(w.bits, 16)
  assert.equal(w.byteRate, w.rate * 2); assert.equal(w.align, 2)
  assert.equal(w.size, buf.length - 8)
  assert.equal(w.dataLen, buf.length - 44)
})

test('B2 the strike lasts 1.5 to 2 seconds and stays well under 200 KB', () => {
  const buf = synthBowl()
  const w = parse(buf)
  const seconds = w.samples.length / w.rate
  assert.ok(seconds >= 1.5 && seconds <= 2, 'duration ' + seconds)
  assert.ok(buf.length < 200 * 1024, 'size ' + buf.length)
})

test('B3 it is not silent, is soft (peak below full scale), strikes fast and decays to silence without a click', () => {
  const { samples, rate } = parse(synthBowl())
  const peak = (from, to) => samples.slice(from, to).reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  const all = peak(0, samples.length)
  assert.ok(all > 3000, 'audible, peak ' + all)
  assert.ok(all < 32767 * 0.8, 'soft, peak ' + all)
  assert.ok(peak(0, Math.round(rate * 0.1)) > all * 0.5, 'the strike is in the first 100 ms')
  assert.ok(peak(samples.length - Math.round(rate * 0.2), samples.length) < all * 0.1, 'it has decayed at the end')
  assert.ok(Math.abs(samples[0]) < 200, 'starts at zero (no click)')
  assert.ok(Math.abs(samples.at(-1)) < 20, 'ends at zero (no click)')
})

test('B4 it rings with several inharmonic partials: the fundamental and the 2.71x and 5.15x partials stand out from the spectrum between them', () => {
  const { samples, rate } = parse(synthBowl())
  const power = (hz) => {
    let re = 0, im = 0
    const n = Math.min(samples.length, rate)
    for (let i = 0; i < n; i++) { re += samples[i] * Math.cos(2 * Math.PI * hz * i / rate); im += samples[i] * Math.sin(2 * Math.PI * hz * i / rate) }
    return Math.hypot(re, im) / n
  }
  assert.ok(power(440) > power(700) * 10, 'the fundamental')
  assert.ok(power(440 * 2.71) > power(1500) * 5, 'a partial at 2.71x, not a harmonic')
  assert.ok(power(440 * 5.15) > power(3000) * 5, 'a partial at 5.15x')
})

test('B5 it is deterministic: two runs give the same bytes, and the sample rate and length can be chosen', () => {
  assert.ok(synthBowl().equals(synthBowl()))
  const small = synthBowl({ sampleRate: 8000, seconds: 1 })
  assert.equal(parse(small).rate, 8000)
  assert.equal(parse(small).samples.length, 8000)
})

test('B6 the committed assets/bowl.wav is exactly what the generator writes', () => {
  assert.ok(statSync(ASSET).size < 200 * 1024)
  assert.ok(readFileSync(ASSET).equals(synthBowl()), 'run: node scripts/make-bowl-wav.mjs')
})
