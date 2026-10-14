#!/usr/bin/env node
/**
 * Synthesises the soft singing-bowl strike that the voice flow plays while the LLM decides (it replaces the spoken
 * "Deciding with LLM." line) and writes it to assets/bowl.wav. The WAV is committed; run this script only to change the sound:
 *   node scripts/make-bowl-wav.mjs
 * A few inharmonic sine partials (the ratios of a struck bowl), a fast attack, an exponential decay per partial (higher partials die
 * sooner) and a slightly detuned twin of the fundamental for the slow shimmer. 16-bit mono PCM, no dependencies, no randomness.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FUNDAMENTAL_HZ = 440
/** [frequency ratio, amplitude, decay time constant in seconds] */
const PARTIALS = [[1, 1, 0.7], [1.003, 0.6, 0.65], [2.71, 0.45, 0.4], [5.15, 0.22, 0.25], [8.4, 0.1, 0.15]]
const ATTACK_S = 0.008
const FADE_OUT_S = 0.08
/** Peak level as a fraction of full scale: a soft strike. */
const PEAK = 0.5

/** The WAV file bytes: mono, 16-bit PCM. */
export function synthBowl({ sampleRate = 24000, seconds = 1.8 } = {}) {
  const n = Math.round(sampleRate * seconds)
  const raw = new Float64Array(n)
  let max = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    let v = 0
    for (const [ratio, amp, tau] of PARTIALS) v += amp * Math.exp(-t / tau) * Math.sin(2 * Math.PI * FUNDAMENTAL_HZ * ratio * t)
    v *= Math.min(1, t / ATTACK_S) * Math.min(1, (seconds - t) / FADE_OUT_S)
    raw[i] = v
    max = Math.max(max, Math.abs(v))
  }
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((raw[i] / (max || 1)) * PEAK * 32767), 44 + i * 2)
  return buf
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(new URL('../assets/bowl.wav', import.meta.url))
  mkdirSync(dirname(out), { recursive: true })
  const wav = synthBowl()
  writeFileSync(out, wav)
  console.log('wrote ' + out + ' (' + wav.length + ' bytes)')
}
