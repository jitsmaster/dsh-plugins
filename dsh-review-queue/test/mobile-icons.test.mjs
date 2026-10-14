import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodePng, renderIcon, BACKGROUND } from '../scripts/make-icons.mjs'

const file = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)))
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

// An independent CRC-32 (the encoder has its own).
const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

function decode(png) {
  assert.ok(png.subarray(0, 8).equals(SIG), 'PNG signature')
  const chunks = []
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o)
    const type = png.toString('ascii', o + 4, o + 8)
    const data = png.subarray(o + 8, o + 8 + len)
    assert.equal(png.readUInt32BE(o + 8 + len), crc32(png.subarray(o + 4, o + 8 + len)), type + ' crc')
    chunks.push({ type, data })
    o += 12 + len
  }
  assert.deepEqual(chunks.map((c) => c.type).filter((t, i, a) => a.indexOf(t) === i), ['IHDR', 'IDAT', 'IEND'])
  const ihdr = chunks[0].data
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  assert.deepEqual([...ihdr.subarray(8)], [8, 6, 0, 0, 0]) // 8 bit RGBA, no interlace
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const stride = width * 4
  assert.equal(raw.length, height * (stride + 1))
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 0, 'filter type none')
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { width, height, pixels }
}

test('encodePng writes a valid RGBA PNG that decodes back to the same pixels', () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 2, 3, 4])
  const out = decode(encodePng(2, 2, rgba))
  assert.equal(out.width, 2)
  assert.equal(out.height, 2)
  assert.ok(out.pixels.equals(rgba))
})

test('encodePng rejects pixel data of the wrong size', () => {
  assert.throws(() => encodePng(2, 2, Buffer.alloc(3)), /size/i)
})

test('renderIcon is deterministic, fills the square with the dark background and draws a light glyph', () => {
  const a = renderIcon(96)
  const b = renderIcon(96)
  assert.ok(a.equals(b))
  assert.equal(a.length, 96 * 96 * 4)
  assert.deepEqual([...a.subarray(0, 4)], [...BACKGROUND, 255]) // corner
  let light = 0
  for (let i = 0; i < a.length; i += 4) if (a[i] > 200 && a[i + 1] > 200 && a[i + 2] > 200) light++
  assert.ok(light > 96 * 96 * 0.03, 'the glyph is visible')
})

test('the glyph stays inside the maskable safe zone (a circle of 80% of the width)', () => {
  const size = 192
  const px = renderIcon(size)
  const c = (size - 1) / 2
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4
    if (px[i] === BACKGROUND[0] && px[i + 1] === BACKGROUND[1] && px[i + 2] === BACKGROUND[2]) continue
    assert.ok(Math.hypot(x - c, y - c) <= size * 0.4 + 1, 'pixel ' + x + ',' + y + ' is outside the safe zone')
  }
})

test('the committed icons are what the script renders', () => {
  for (const size of [192, 512]) {
    const png = decode(file('../lib/mobile/icon-' + size + '.png'))
    assert.equal(png.width, size)
    assert.equal(png.height, size)
    assert.ok(png.pixels.equals(renderIcon(size)), 'icon-' + size + '.png is stale: run node scripts/make-icons.mjs')
  }
})
