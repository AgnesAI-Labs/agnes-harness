import * as THREE from 'three'
import { FOOTPRINTS, LAYOUT } from './base.js'
import { DEVICES, MONOLITH } from './devices.js'
import { occupancy } from './live/map.js'
import { heightAt, OBSTACLES } from './terrain.js'

/** The part of the base map the minimap shows, in map coordinates (x east, y north, metres). */
const VIEW = { x0: -62, x1: 74, y0: -56, y1: 32 }
const SCALE = 2.4 // CSS pixels per metre
const W = (VIEW.x1 - VIEW.x0) * SCALE
const H = (VIEW.y1 - VIEW.y0) * SCALE
const TEXT = '#f6e7d2'
const MUTED = 'rgba(201, 167, 124, 0.85)'
const ACCENT = '#ffb15c'

/** Short names, so every label fits around a small base. */
const SHORT: Record<string, string> = {
  'habitat-01': 'habitat',
  'airlock-01': 'airlock',
  'suit-01': 'suit-01',
  [MONOLITH.id]: MONOLITH.name.toLowerCase(),
  'rover-01': 'rover-01',
  'hopper-01': 'hopper-01',
  'lab-01': 'lab',
  'power-01': 'power',
  'weather-01': 'weather',
  'comms-01': 'comms',
  'cam-base': 'cam',
}
const MOVING = new Set(['rover-01', 'hopper-01', 'suit-01', MONOLITH.id])

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Canvas position of a world point (x east, z south). */
const at = (x: number, z: number) => ({ cx: (x - VIEW.x0) * SCALE, cy: (VIEW.y1 + z) * SCALE })

/**
 * A small map in the top-right corner: the base map's frame with a 10 m grid and labelled ticks,
 * buildings, boulders and steep ground, and every device where it is now, redrawn a few times a
 * second. `M` toggles it; ?minimap=0 hides it.
 */
export function buildMinimap(anchors: Map<string, THREE.Object3D>, view: THREE.Camera): HTMLCanvasElement {
  const dpr = Math.min(devicePixelRatio, 2)
  const canvas = document.createElement('canvas')
  canvas.width = W * dpr
  canvas.height = H * dpr
  Object.assign(canvas.style, {
    position: 'fixed',
    top: '14px',
    right: '14px',
    width: `${W}px`,
    height: `${H}px`,
    borderRadius: '8px',
    border: '1px solid rgba(255, 196, 120, 0.35)',
    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.35)',
    pointerEvents: 'none',
  })
  const background = drawBackground(dpr)
  const g = canvas.getContext('2d') as CanvasRenderingContext2D
  const p = new THREE.Vector3()
  const draw = () => {
    if (canvas.hidden) return
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, canvas.width, canvas.height)
    g.drawImage(background, 0, 0)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    // Where the view looks from, as a small wedge.
    view.getWorldPosition(p)
    const eye = at(p.x, p.z)
    const ahead = view.getWorldDirection(new THREE.Vector3())
    const yaw = Math.atan2(ahead.z, ahead.x)
    g.fillStyle = 'rgba(246, 231, 210, 0.16)'
    g.beginPath()
    g.moveTo(eye.cx, eye.cy)
    g.arc(eye.cx, eye.cy, 26, yaw - 0.4, yaw + 0.4)
    g.fill()
    // Devices, moving ones larger and with a heading.
    const shown = DEVICES.flatMap(({ id }) => {
      const anchor = anchors.get(id)
      if (!anchor) return []
      anchor.getWorldPosition(p)
      const { cx, cy } = at(p.x, p.z)
      return [{ id, anchor, moving: MOVING.has(id), x: clamp(cx, 4, W - 4), y: clamp(cy, 4, H - 4) }]
    })
    const taken: [number, number, number, number][] = []
    for (const { anchor, moving, x, y } of shown) {
      g.fillStyle = moving ? ACCENT : TEXT
      g.strokeStyle = 'rgba(16, 13, 11, 0.9)'
      g.lineWidth = 1.5
      g.beginPath()
      g.arc(x, y, moving ? 3.6 : 2.6, 0, Math.PI * 2)
      g.fill()
      g.stroke()
      taken.push([x - 3, y - 3, 6, 6])
      if (moving) {
        // rotation.y of the model: 0 faces +z, south, which is down the map.
        const h = anchor.rotation.y
        g.strokeStyle = ACCENT
        g.beginPath()
        g.moveTo(x, y)
        g.lineTo(x + Math.sin(h) * 9, y + Math.cos(h) * 9)
        g.stroke()
      }
    }
    // Labels, the moving devices first, each where it covers no other label or dot.
    g.font = '600 9.5px ui-monospace, "SF Mono", Menlo, monospace'
    g.textBaseline = 'middle'
    for (const { id, moving, x, y } of [...shown].sort((a, b) => Number(b.moving) - Number(a.moving))) {
      const label = SHORT[id] ?? id
      const w = g.measureText(label).width + 4
      const spots: [number, number][] = [
        [x + 6, y - 6],
        [x + 6, y + 6],
        [x - 6 - w, y - 6],
        [x - 6 - w, y + 6],
        [x - w / 2, y - 13],
        [x - w / 2, y + 13],
        [x + 6, y - 18],
        [x - 6 - w, y + 18],
      ]
      const fits = (sx: number, sy: number) =>
        sx >= 1 &&
        sx + w <= W - 1 &&
        sy - 6 >= 1 &&
        sy + 6 <= H - 1 &&
        !taken.some(([ax, ay, aw, ah]) => sx < ax + aw && sx + w > ax && sy - 6 < ay + ah && sy + 6 > ay)
      const [sx, sy] = spots.find(([sx, sy]) => fits(sx, sy)) ?? (spots[0] as [number, number])
      taken.push([sx, sy - 6, w, 12])
      g.fillStyle = 'rgba(16, 13, 11, 0.72)'
      g.fillRect(sx, sy - 6, w, 12)
      g.fillStyle = moving ? ACCENT : TEXT
      g.fillText(label, sx + 2, sy + 0.5)
    }
  }
  setInterval(draw, 250)
  draw()
  addEventListener('keydown', (e) => {
    if (e.key === 'm') {
      canvas.hidden = !canvas.hidden
      draw()
    }
  })
  return canvas
}

/** The still part, drawn once: ground, steep slopes, buildings, rocks, pads, the grid and its ticks. */
function drawBackground(dpr: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = W * dpr
  canvas.height = H * dpr
  const g = canvas.getContext('2d') as CanvasRenderingContext2D
  g.scale(dpr, dpr)
  g.fillStyle = 'rgba(16, 13, 11, 0.74)'
  g.fillRect(0, 0, W, H)
  // Steep ground from the same occupancy the devices' base map uses, without the buildings.
  const steep = occupancy([], heightAt)
  g.fillStyle = 'rgba(150, 92, 60, 0.45)'
  for (let j = 0; j < steep.h; j++)
    for (let i = 0; i < steep.w; i++)
      if (steep.cells[j * steep.w + i] === 0) {
        const x = steep.origin[0] + i * steep.resolution
        const y = steep.origin[1] + (steep.h - 1 - j) * steep.resolution
        const { cx, cy } = at(x, -(y + steep.resolution))
        g.fillRect(cx, cy, steep.resolution * SCALE + 0.5, steep.resolution * SCALE + 0.5)
      }
  // The grid: a line every 10 m, labels every 20 m, the axes through the habitat brighter.
  g.lineWidth = 1
  g.font = '9px ui-monospace, "SF Mono", Menlo, monospace'
  g.fillStyle = MUTED
  for (let x = Math.ceil(VIEW.x0 / 10) * 10; x <= VIEW.x1; x += 10) {
    const { cx } = at(x, 0)
    g.strokeStyle = x === 0 ? 'rgba(255, 196, 120, 0.45)' : 'rgba(255, 196, 120, 0.12)'
    g.beginPath()
    g.moveTo(cx + 0.5, 0)
    g.lineTo(cx + 0.5, H)
    g.stroke()
    if (x % 20 === 0) {
      g.textAlign = 'center'
      g.textBaseline = 'bottom'
      g.fillText(String(x), cx, H - 2)
    }
  }
  for (let y = Math.ceil(VIEW.y0 / 10) * 10; y <= VIEW.y1; y += 10) {
    const { cy } = at(0, -y)
    g.strokeStyle = y === 0 ? 'rgba(255, 196, 120, 0.45)' : 'rgba(255, 196, 120, 0.12)'
    g.beginPath()
    g.moveTo(0, cy + 0.5)
    g.lineTo(W, cy + 0.5)
    g.stroke()
    if (y % 20 === 0) {
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      g.fillText(String(y), 3, cy)
    }
  }
  // Pads, then the buildings and rocks that block the way.
  g.strokeStyle = 'rgba(217, 178, 58, 0.7)'
  for (const [[x, z], r] of [
    [LAYOUT.landingPad, 9],
    [LAYOUT.hopperPad, 2.6],
  ] as [readonly [number, number], number][]) {
    const { cx, cy } = at(x, z)
    g.beginPath()
    g.arc(cx, cy, r * SCALE, 0, Math.PI * 2)
    g.stroke()
  }
  g.fillStyle = 'rgba(233, 227, 216, 0.5)'
  for (const f of [...FOOTPRINTS, ...OBSTACLES.map((o) => ({ x: o.x, z: o.z, r: o.r }))]) {
    if ('r' in f) {
      const { cx, cy } = at(f.x, f.z)
      g.beginPath()
      g.arc(cx, cy, Math.max(1, f.r * SCALE), 0, Math.PI * 2)
      g.fill()
    } else {
      const { cx, cy } = at(f.x - f.w / 2, f.z - f.d / 2)
      g.fillRect(cx, cy, f.w * SCALE, f.d * SCALE)
    }
  }
  // The frame: which way is north and east, in the map frame the poses use.
  g.fillStyle = TEXT
  g.font = '600 10px ui-sans-serif, system-ui, sans-serif'
  g.textAlign = 'right'
  g.textBaseline = 'top'
  g.fillText('base map · m', W - 6, 5)
  g.font = '9px ui-monospace, "SF Mono", Menlo, monospace'
  g.fillStyle = MUTED
  g.fillText('x → east, y ↑ north', W - 6, 18)
  return canvas
}
