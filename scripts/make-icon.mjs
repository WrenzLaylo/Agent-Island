/**
 * Generate build/icon.ico — the app, installer and taskbar icon.
 *
 * Written by hand rather than pulled from the tray asset: that one is a 32px
 * PNG, and Windows wants 256px for the installer and shortcut. Upscaling a
 * 32px source gives a blurry icon on every surface that matters.
 *
 * No image dependency. PNG is deflate plus four chunks, and an ICO is a small
 * header around a list of PNGs, so both are cheaper to write than to install.
 *
 * The mark is the island itself: a black pill with an amber dot, which is
 * exactly what the user sees when an agent is waiting on them. A hairline
 * light border keeps the black shape visible against a dark taskbar.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIZES = [256, 128, 64, 48, 32, 16]
/** Samples per axis. 4 gives clean curves without a visible staircase. */
const SS = 4

const PILL = { r: 0x0d, g: 0x0d, b: 0x0f }
const EDGE = { r: 0xff, g: 0xff, b: 0xff }
const DOT = { r: 0xf0, g: 0xb4, b: 0x5f }

/** Signed distance to a rounded rectangle centred on the origin. */
function roundedRectDistance(x, y, halfW, halfH, radius) {
  const qx = Math.abs(x) - (halfW - radius)
  const qy = Math.abs(y) - (halfH - radius)
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  return outside + Math.min(Math.max(qx, qy), 0) - radius
}

/**
 * Coverage-based rendering: for each supersample, decide which layer it lands
 * in and accumulate. Alpha falls out of the sample count, so the curves are
 * anti-aliased without a separate blur pass.
 */
function renderRgba(size) {
  const pixels = Buffer.alloc(size * size * 4)
  // Proportions are fixed fractions of the canvas so every size matches.
  const halfW = size * 0.42
  const halfH = size * 0.23
  const radius = halfH
  const border = Math.max(size * 0.018, 0.75)
  const dotR = halfH * 0.44
  const dotX = -halfW + halfH * 1.05

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let fill = 0
      let edge = 0
      let dot = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS - size / 2
          const y = py + (sy + 0.5) / SS - size / 2
          const d = roundedRectDistance(x, y, halfW, halfH, radius)
          if (d > 0) continue
          if (d > -border) {
            edge++
            continue
          }
          if (Math.hypot(x - dotX, y) <= dotR) dot++
          else fill++
        }
      }

      const total = SS * SS
      const covered = fill + edge + dot
      if (covered === 0) continue

      // Weighted average of whichever layers this pixel straddles.
      const r = (PILL.r * fill + EDGE.r * edge + DOT.r * dot) / covered
      const g = (PILL.g * fill + EDGE.g * edge + DOT.g * dot) / covered
      const b = (PILL.b * fill + EDGE.b * edge + DOT.b * dot) / covered

      const offset = (py * size + px) * 4
      pixels[offset] = Math.round(r)
      pixels[offset + 1] = Math.round(g)
      pixels[offset + 2] = Math.round(b)
      pixels[offset + 3] = Math.round((covered / total) * 255)
    }
  }
  return pixels
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte per scanline; filter 0 (None) keeps this readable and the
  // images are tiny enough that the extra bytes do not matter.
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  let offset = header.length + entries.length

  images.forEach((image, index) => {
    const at = index * 16
    // 256 is stored as 0; the field is a single byte.
    entries[at] = image.size >= 256 ? 0 : image.size
    entries[at + 1] = image.size >= 256 ? 0 : image.size
    entries[at + 2] = 0 // palette size
    entries[at + 3] = 0
    entries.writeUInt16LE(1, at + 4) // colour planes
    entries.writeUInt16LE(32, at + 6) // bits per pixel
    entries.writeUInt32BE(0, at + 8)
    entries.writeUInt32LE(image.png.length, at + 8)
    entries.writeUInt32LE(offset, at + 12)
    offset += image.png.length
  })

  return Buffer.concat([header, entries, ...images.map((image) => image.png)])
}

const images = SIZES.map((size) => ({ size, png: encodePng(size, renderRgba(size)) }))
mkdirSync(join(ROOT, 'build'), { recursive: true })
const ico = encodeIco(images)
writeFileSync(join(ROOT, 'build', 'icon.ico'), ico)
// The largest PNG doubles as the Linux/macOS source and the README asset.
writeFileSync(join(ROOT, 'build', 'icon.png'), images[0].png)

console.log(`build/icon.ico  ${ico.length} bytes  (${SIZES.join(', ')})`)
