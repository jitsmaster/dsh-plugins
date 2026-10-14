/**
 * Generates the PWA icons (lib/mobile/icon-192.png, icon-512.png) with no dependency: a small PNG encoder on node:zlib and a
 * software-rendered glyph (a checklist). Run `node scripts/make-icons.mjs` after changing the design; test/mobile-icons.test.mjs checks
 * the committed files against this renderer.
 * The background fills the whole square (the launcher applies its own mask) and the glyph stays inside the maskable safe zone.
 */
import zlib from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BACKGROUND = [0x14, 0x16, 0x1a] // theme / background colour of the manifest
const INK = [0xe8, 0xea, 0xed]
const ACCENT = [0x5b, 0xc0, 0x8b]

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** An 8 bit RGBA PNG (filter type 0 on every line). `rgba` is width*height*4 bytes. */
export function encodePng(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('Pixel data has the wrong size for ' + width + 'x' + height)
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// Shapes in unit coordinates (0..1 of the width); coverage comes from a signed distance, anti-aliased over one pixel.
const roundedBar = (x, y, x0, x1, cy, r) => { const cx = Math.min(Math.max(x, x0 + r), x1 - r); return Math.hypot(x - cx, y - cy) - r }
function segment(x, y, ax, ay, bx, by, r) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) - r
}

/** Three rows of a task list: a green check, a green check and a hollow bullet, each with a text line. All inside a 0.6 wide square. */
const GLYPH_SCALE = 1.3 // grows the glyph around the centre; its far corner stays inside the 0.4 radius safe zone
function glyph(px, py) {
  const x = 0.5 + (px - 0.5) / GLYPH_SCALE
  const y = 0.5 + (py - 0.5) / GLYPH_SCALE
  const layers = []
  const rows = [0.36, 0.5, 0.64]
  rows.forEach((cy, i) => {
    layers.push({ d: roundedBar(x, y, 0.5, 0.7, cy, 0.022), color: INK })
    if (i < 2) {
      layers.push({ d: Math.min(segment(x, y, 0.3, cy, 0.325, cy + 0.03, 0.02), segment(x, y, 0.325, cy + 0.03, 0.375, cy - 0.035, 0.02)), color: ACCENT })
    } else {
      layers.push({ d: Math.abs(Math.hypot(x - 0.335, y - cy) - 0.04) - 0.012, color: INK })
    }
  })
  return layers.map((l) => ({ ...l, d: l.d * GLYPH_SCALE }))
}

/** The icon as width*width*4 RGBA bytes; deterministic. */
export function renderIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const aa = 1 / size
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / size
      const y = (j + 0.5) / size
      let rgb = BACKGROUND
      for (const { d, color } of glyph(x, y)) {
        const cover = Math.min(1, Math.max(0, 0.5 - d / aa))
        if (cover > 0) rgb = rgb.map((c, k) => Math.round(c + (color[k] - c) * cover))
      }
      px.set([...rgb, 255], (j * size + i) * 4)
    }
  }
  return px
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'mobile')
  mkdirSync(dir, { recursive: true })
  for (const size of [192, 512]) {
    writeFileSync(join(dir, 'icon-' + size + '.png'), encodePng(size, size, renderIcon(size)))
    console.log('wrote icon-' + size + '.png')
  }
}
