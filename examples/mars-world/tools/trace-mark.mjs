// Traces the Agnes mark (packages/web/public/brand-mark.png, a 64x64 white glyph) into a vector
// path, so the flag shows it crisp at any size: bicubic upsampling of the alpha, marching squares
// at half coverage, smoothing along the outline, simplification, then quadratic curves through the midpoints so the outline is
// smooth. Writes src/agnes-mark.ts. Run: node tools/trace-mark.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const root = new URL('..', import.meta.url).pathname
const SCALE = 8 // samples per source pixel
const TOLERANCE = 0.015 // Douglas-Peucker tolerance, in source pixels

/** Alpha of an 8-bit grayscale+alpha PNG, as rows of numbers 0..1. */
function readAlpha(path) {
  const png = readFileSync(path)
  let pos = 8
  let width = 0
  let height = 0
  const chunks = []
  while (pos < png.length) {
    const length = png.readUInt32BE(pos)
    const type = png.toString('ascii', pos + 4, pos + 8)
    const body = png.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 4) throw new Error('expected 8-bit grayscale+alpha')
    }
    if (type === 'IDAT') chunks.push(body)
    pos += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const bpp = 2
  const stride = width * bpp
  const rows = []
  let prev = new Uint8Array(stride)
  for (let y = 0, i = 0; y < height; y++) {
    const filter = raw[i++]
    const line = new Uint8Array(raw.subarray(i, i + stride))
    i += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      if (filter === 1) line[x] = (line[x] + a) & 255
      else if (filter === 2) line[x] = (line[x] + b) & 255
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    rows.push(Array.from({ length: width }, (_, x) => line[x * bpp + 1] / 255))
    prev = line
  }
  return { width, height, rows }
}

/** Catmull-Rom weights. */
function cubic(t) {
  const t2 = t * t
  const t3 = t2 * t
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2]
}

function upsample({ width, height, rows }) {
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : rows[y][x])
  const w = width * SCALE + 1
  const h = height * SCALE + 1
  const field = Array.from({ length: h }, () => new Float32Array(w))
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      // Sample positions in source pixel centers.
      const sx = i / SCALE - 0.5
      const sy = j / SCALE - 0.5
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const wx = cubic(sx - x0)
      const wy = cubic(sy - y0)
      let v = 0
      for (let m = 0; m < 4; m++) for (let n = 0; n < 4; n++) v += wx[n] * wy[m] * at(x0 - 1 + n, y0 - 1 + m)
      field[j][i] = v
    }
  return field
}

/** Closed iso-contours of the field at 0.5, as point lists in field coordinates. */
function contours(field) {
  const h = field.length
  const w = field[0].length
  const iso = 0.5
  const lerp = (a, b) => (iso - a) / (b - a)
  // Each segment joins two cell edges; edges are keyed so neighbouring cells share them.
  const next = new Map()
  const point = new Map()
  const key = (kind, i, j) => `${kind}${i},${j}`
  for (let j = 0; j < h - 1; j++)
    for (let i = 0; i < w - 1; i++) {
      const a = field[j][i]
      const b = field[j][i + 1]
      const c = field[j + 1][i + 1]
      const d = field[j + 1][i]
      const code = (a > iso ? 8 : 0) | (b > iso ? 4 : 0) | (c > iso ? 2 : 0) | (d > iso ? 1 : 0)
      if (code === 0 || code === 15) continue
      const top = key('h', i, j)
      const right = key('v', i + 1, j)
      const bottom = key('h', i, j + 1)
      const left = key('v', i, j)
      point.set(top, [i + lerp(a, b), j])
      point.set(right, [i + 1, j + lerp(b, c)])
      point.set(bottom, [i + lerp(d, c), j + 1])
      point.set(left, [i, j + lerp(a, d)])
      // Segments oriented with the inside on the left; saddles resolved by the centre value.
      const centre = (a + b + c + d) / 4 > iso
      const segs = {
        1: [[left, bottom]],
        2: [[bottom, right]],
        3: [[left, right]],
        4: [[right, top]],
        5: centre
          ? [
              [left, top],
              [right, bottom],
            ]
          : [
              [left, bottom],
              [right, top],
            ],
        6: [[bottom, top]],
        7: [[left, top]],
        8: [[top, left]],
        9: [[top, bottom]],
        10: centre
          ? [
              [top, right],
              [bottom, left],
            ]
          : [
              [top, left],
              [bottom, right],
            ],
        11: [[top, right]],
        12: [[right, left]],
        13: [[right, bottom]],
        14: [[bottom, left]],
      }[code]
      for (const [from, to] of segs) next.set(from, to)
    }
  const loops = []
  const seen = new Set()
  for (const start of next.keys()) {
    if (seen.has(start)) continue
    const loop = []
    let at = start
    while (at !== undefined && !seen.has(at)) {
      seen.add(at)
      loop.push(point.get(at))
      at = next.get(at)
    }
    if (loop.length > 8) loops.push(loop)
  }
  return loops
}

function simplify(points, tolerance) {
  if (points.length < 3) return points
  const [ax, ay] = points[0]
  const [bx, by] = points[points.length - 1]
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  let worst = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i]
    const d = Math.abs(dy * (px - ax) - dx * (py - ay)) / len
    if (d > worst) {
      worst = d
      index = i
    }
  }
  if (worst <= tolerance) return [points[0], points[points.length - 1]]
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ]
}

const alpha = readAlpha(`${root}../../packages/web/public/brand-mark.png`)
const field = upsample(alpha)
const size = alpha.width * SCALE
/** Moving averages along a closed loop: evens out the steps of the 64-pixel source. */
function smooth(loop, radius, passes) {
  let pts = loop
  for (let p = 0; p < passes; p++)
    pts = pts.map((_, i) => {
      let x = 0
      let y = 0
      for (let k = -radius; k <= radius; k++) {
        const q = pts[(i + k + pts.length) % pts.length]
        x += q[0]
        y += q[1]
      }
      return [x / (2 * radius + 1), y / (2 * radius + 1)]
    })
  return pts
}

const loops = contours(field).map((raw) => {
  const loop = smooth(raw, SCALE >> 1, 5)
  // Split the closed loop in two so simplification keeps both halves.
  const half = loop.length >> 1
  const a = simplify(loop.slice(0, half + 1), TOLERANCE * SCALE)
  const b = simplify([...loop.slice(half), loop[0]], TOLERANCE * SCALE)
  return [...a.slice(0, -1), ...b.slice(0, -1)]
})
const fmt = (n) => Number((n / size).toFixed(4))
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const xy = ([x, y]) => `${fmt(x)} ${fmt(y)}`
/** The dot of the mark is a circle; at 64 pixels its outline is not, so it is drawn as one. */
function circle(loop) {
  const cx = loop.reduce((n, p) => n + p[0], 0) / loop.length
  const cy = loop.reduce((n, p) => n + p[1], 0) / loop.length
  const r = loop.reduce((n, p) => n + Math.hypot(p[0] - cx, p[1] - cy), 0) / loop.length
  const R = fmt(r)
  return `M${xy([cx + r, cy])}A${R} ${R} 0 1 0 ${xy([cx - r, cy])}A${R} ${R} 0 1 0 ${xy([cx + r, cy])}Z`
}

const path = loops
  .map((loop) => {
    const xs = loop.map((p) => p[0])
    if (Math.max(...xs) - Math.min(...xs) < size * 0.2) return circle(loop)
    const curves = loop.map((p, i) => `Q${xy(p)} ${xy(mid(p, loop[(i + 1) % loop.length]))}`)
    return `M${xy(mid(loop[loop.length - 1], loop[0]))}${curves.join('')}Z`
  })
  .join('')
writeFileSync(
  `${root}src/agnes-mark.ts`,
  `// The Agnes mark as a vector path in a unit square, traced from packages/web/public/brand-mark.png
// by tools/trace-mark.mjs. Fill it with the even-odd rule.
export const AGNES_MARK = '${path}'
`,
)
console.log(
  `${loops.length} loops, ${loops.reduce((n, l) => n + l.length, 0)} points, ${path.length} characters`,
)
