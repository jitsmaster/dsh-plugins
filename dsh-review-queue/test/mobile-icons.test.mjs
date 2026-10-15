import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodePng, renderIcon, BACKGROUND } from '../scripts/make-icons.mjs'
import { FILES } from '../mobile.js'

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

// ---- icon-180.png: the iOS Home Screen icon ------------------------------------------------------------------------------------------------
// iOS fills transparency with black, so the apple-touch-icon must be opaque. It is derived from icon-512.png (resized, e.g. with Pillow), so its
// encoder is not ours: this decoder accepts any 8 bit, non-interlaced RGB or RGBA PNG (all five filter types, extra chunks).
function decodeAny(png) {
  assert.ok(png.subarray(0, 8).equals(SIG), 'PNG signature')
  const idat = []
  let ihdr
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o)
    const type = png.toString('ascii', o + 4, o + 8)
    const data = png.subarray(o + 8, o + 8 + len)
    assert.equal(png.readUInt32BE(o + 8 + len), crc32(png.subarray(o + 4, o + 8 + len)), type + ' crc')
    if (type === 'IHDR') ihdr = data
    if (type === 'IDAT') idat.push(data)
    o += 12 + len
  }
  assert.ok(ihdr, 'IHDR')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  assert.equal(ihdr[8], 8, 'bit depth 8')
  assert.ok(ihdr[9] === 2 || ihdr[9] === 6, 'colour type RGB (2) or RGBA (6), got ' + ihdr[9])
  assert.equal(ihdr[12], 0, 'not interlaced')
  const bpp = ihdr[9] === 6 ? 4 : 3
  const stride = width * bpp
  const raw = zlib.inflateSync(Buffer.concat(idat))
  assert.equal(raw.length, height * (stride + 1))
  const px = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]
      const a = x >= bpp ? px[y * stride + x - bpp] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0
      let add = 0
      if (filter === 1) add = a
      else if (filter === 2) add = b
      else if (filter === 3) add = (a + b) >> 1
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      else assert.equal(filter, 0, 'known filter type')
      px[y * stride + x] = (v + add) & 255
    }
  }
  return { width, height, bpp, px }
}
const rgbAt = (img, x, y) => { const i = (y * img.width + x) * img.bpp; return [img.px[i], img.px[i + 1], img.px[i + 2]] }

test('icon-180.png is a 180x180 PNG', () => {
  const img = decodeAny(file('../lib/mobile/icon-180.png'))
  assert.equal(img.width, 180)
  assert.equal(img.height, 180)
})

test('icon-180.png is fully opaque: no alpha channel, or every alpha value is 255 (iOS fills transparency with black)', () => {
  const img = decodeAny(file('../lib/mobile/icon-180.png'))
  if (img.bpp === 4) for (let i = 3; i < img.px.length; i += 4) assert.equal(img.px[i], 255, 'pixel ' + (i - 3) / 4 + ' is not opaque')
})

test('icon-180.png keeps the dark background in its corners and the light glyph in the middle (it is not blank or black)', () => {
  const img = decodeAny(file('../lib/mobile/icon-180.png'))
  for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179]]) {
    rgbAt(img, x, y).forEach((v, k) => assert.ok(Math.abs(v - BACKGROUND[k]) <= 8, 'corner ' + x + ',' + y + ' channel ' + k + ' = ' + v))
  }
  let light = 0
  for (let y = 0; y < 180; y++) for (let x = 0; x < 180; x++) { const [r, g, b] = rgbAt(img, x, y); if (r > 200 && g > 200 && b > 200) light++ }
  assert.ok(light > 180 * 180 * 0.02, 'the glyph is visible (' + light + ' light pixels)')
})

test('icon-180.png is icon-512.png scaled down, not a different picture (mean difference to a box-filtered 512 is small)', () => {
  const big = decodeAny(file('../lib/mobile/icon-512.png'))
  const small = decodeAny(file('../lib/mobile/icon-180.png'))
  const scale = big.width / small.width
  let total = 0
  for (let y = 0; y < 180; y++) for (let x = 0; x < 180; x++) {
    const x0 = Math.floor(x * scale); const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale))
    const y0 = Math.floor(y * scale); const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale))
    const sum = [0, 0, 0]
    let n = 0
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const p = rgbAt(big, xx, yy); sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; n++ }
    const q = rgbAt(small, x, y)
    total += Math.abs(q[0] - sum[0] / n) + Math.abs(q[1] - sum[1] / n) + Math.abs(q[2] - sum[2] / n)
  }
  const mean = total / (180 * 180 * 3)
  assert.ok(mean < 8, 'mean absolute channel difference to icon-512 is ' + mean.toFixed(2))
})

test('the phone router serves icon-180.png as image/png and the file is on disk', () => {
  assert.ok(Object.hasOwn(FILES, 'icon-180.png'), 'FILES lists icon-180.png')
  assert.equal(FILES['icon-180.png'].type, 'image/png')
  assert.ok(existsSync(FILES['icon-180.png'].file))
})
