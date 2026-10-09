import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { canvasTexture, seeded } from './assets.js'
import { part } from './base.js'

/** The slabs, in metres: length (standing, it is this tall), width across, depth front to back. */
const SLAB = { length: 1.5, width: 0.13, depth: 0.42, gap: 0.014 }
/** Rolling as a wheel, the slabs' ends make a rim of this radius. */
export const WHEEL_RADIUS = SLAB.length / 2
/** Seconds to unfold into a wheel, or to fold back. */
export const UNFOLD_S = 1
/** How far the bottom of a slab moves in half a step, in metres. */
const STRIDE = 0.55
/** The angle of each slab around the hinge once unfolded: an eight-spoked wheel seen from the side. */
const WHEEL = [0, Math.PI / 2, Math.PI / 4, (3 * Math.PI) / 4]
/** The inner pair leans forward this far, in radians, to hold an astronaut against the robot. */
const HOLD = 0.32

/** Wraps an angle to (−π, π]. */
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

export interface Monolith {
  /** On the ground; rotation.y is the heading, and the robot faces +z. */
  group: THREE.Group
  /** What the live device asks of the model; update() moves the slabs toward it. */
  want: { wheel: boolean; hold: 'none' | 'astronaut' | 'sample' }
  /** The sample it holds, shown while it holds one. */
  sample: THREE.Object3D
  /** What it says over the radio, shown in a bubble over it until `until` (page clock, ms). */
  speech: { text: string; until: number }
  /** 0 standing on its slabs, 1 unfolded into a wheel. */
  readonly unfolded: number
  /** Animates the slabs for a frame: `speed` is how fast it moves forward, m/s. */
  update(dt: number, speed: number): void
  /** Standing on its slabs at once, holding nothing, saying nothing. */
  reset(): void
}

/** Brushed metal: faint streaks along the slab, a little dust low down. */
function brushed(seed: number, tint: number): THREE.MeshStandardMaterial {
  const map = canvasTexture(256, (g, s) => {
    const random = seeded(seed)
    const base = new THREE.Color(tint)
    g.fillStyle = `#${base.getHexString()}`
    g.fillRect(0, 0, s, s)
    for (let i = 0; i < 260; i++) {
      const light = random() > 0.5
      g.fillStyle = light ? `rgba(255, 255, 255, ${random() * 0.07})` : `rgba(0, 0, 0, ${random() * 0.08})`
      g.fillRect(random() * s, 0, 1 + random() * 2, s)
    }
    const dust = g.createLinearGradient(0, s * 0.7, 0, s)
    dust.addColorStop(0, 'rgba(160, 90, 50, 0)')
    dust.addColorStop(1, 'rgba(160, 90, 50, 0.35)')
    g.fillStyle = dust
    g.fillRect(0, 0, s, s)
  })
  return new THREE.MeshStandardMaterial({ map, roughness: 0.45, metalness: 0.4 })
}

/** The display strip's face: a row of dim cells with a few lit, like a status readout. */
function displayFace(): THREE.MeshStandardMaterial {
  const face = canvasTexture(256, (g, s) => {
    g.fillStyle = '#05080a'
    g.fillRect(0, 0, s, s)
    const random = seeded(11)
    for (let i = 0; i < 24; i++) {
      const lit = i < 15 || random() > 0.6
      g.fillStyle = lit ? `rgba(120, 235, 255, ${0.55 + random() * 0.45})` : 'rgba(60, 120, 140, 0.25)'
      g.fillRect(6 + i * 10.4, s * 0.3, 7, s * 0.4)
    }
  })
  return new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: 0.15,
    metalness: 0.3,
    emissive: 0xffffff,
    emissiveMap: face,
    emissiveIntensity: 1.6,
  })
}

/**
 * A robot of four tall metal slabs side by side, joined by a hinge through their middles, with a
 * thin display strip across the front. It walks by swinging its slabs about the hinge, the outer
 * pair against the inner pair, and unfolds them into an eight-spoked wheel to roll. Made in code.
 */
export function buildMonolith(): Monolith {
  const group = new THREE.Group()
  // `body` sits at the hinge, as high as the slabs need to stand on the ground.
  const body = new THREE.Group()
  body.position.y = SLAB.length / 2
  group.add(body)
  const groove = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6, metalness: 0.5 })
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.3, metalness: 0.9 })
  const display = displayFace()
  const slabs: THREE.Group[] = []
  const x0 = -1.5 * (SLAB.width + SLAB.gap)
  for (let i = 0; i < 4; i++) {
    const slab = new THREE.Group()
    slab.position.x = x0 + i * (SLAB.width + SLAB.gap)
    body.add(slab)
    slabs.push(slab)
    const skin = brushed(5 + i, [0xa4a8ad, 0xadb1b6, 0xa9adb2, 0x9fa3a8][i] as number)
    slab.add(part(new RoundedBoxGeometry(SLAB.width, SLAB.length, SLAB.depth, 3, 0.012), skin))
    // Panel seams around the slab, and a darker cap at each end.
    for (const y of [-0.36, 0.2, 0.5])
      slab.add(part(new THREE.BoxGeometry(SLAB.width + 0.003, 0.008, SLAB.depth + 0.003), groove, 0, y, 0))
    for (const y of [-1, 1])
      slab.add(
        part(
          new THREE.BoxGeometry(SLAB.width - 0.01, 0.03, SLAB.depth - 0.01),
          steel,
          0,
          y * (SLAB.length / 2 - 0.006),
          0,
        ),
      )
    // The hinge's bearing on each face of the slab.
    for (const side of [-1, 1])
      slab.add(
        part(
          new THREE.CylinderGeometry(0.045, 0.045, 0.006, 20).rotateZ(Math.PI / 2),
          steel,
          side * (SLAB.width / 2 + 0.002),
          0,
          0,
        ),
      )
  }
  // The hinge pin through all four, its ends showing on the outer faces.
  body.add(
    part(
      new THREE.CylinderGeometry(0.022, 0.022, 4 * SLAB.width + 3 * SLAB.gap + 0.03, 12).rotateZ(Math.PI / 2),
      steel,
    ),
  )
  // The display strip across the front of the inner pair, and the camera's lens above it.
  const [innerLeft, innerRight] = [slabs[1] as THREE.Group, slabs[2] as THREE.Group]
  for (const [slab, u] of [
    [innerLeft, 0],
    [innerRight, 0.5],
  ] as const) {
    const g = new THREE.PlaneGeometry(SLAB.width - 0.016, 0.05)
    const uv = g.getAttribute('uv') as THREE.BufferAttribute
    for (let k = 0; k < uv.count; k++) uv.setX(k, u + uv.getX(k) * 0.5)
    slab.add(part(g, display, 0, 0.47, SLAB.depth / 2 + 0.002))
  }
  innerLeft.add(
    part(
      new THREE.CylinderGeometry(0.03, 0.03, 0.012, 20).rotateX(Math.PI / 2),
      steel,
      0,
      0.6,
      SLAB.depth / 2,
    ),
  )
  innerLeft.add(
    part(
      new THREE.CircleGeometry(0.019, 20),
      new THREE.MeshStandardMaterial({ color: 0x0b1622, roughness: 0.05, metalness: 0.7 }),
      0,
      0.6,
      SLAB.depth / 2 + 0.007,
    ),
  )
  // A sample of rock, held against the front while it carries one.
  const sample = part(
    new THREE.DodecahedronGeometry(0.11, 0),
    new THREE.MeshStandardMaterial({ color: 0x3f4a3a, roughness: 0.85 }),
    0,
    1.0,
    SLAB.depth / 2 + 0.13,
  )
  sample.visible = false
  group.add(sample)

  const want: Monolith['want'] = { wheel: false, hold: 'none' }
  const speech = { text: '', until: 0 }
  const angles = [0, 0, 0, 0]
  let unfolded = 0
  let spin = 0
  let phase = 0
  let swing = 0
  return {
    group,
    want,
    sample,
    speech,
    get unfolded() {
      return unfolded
    },
    reset() {
      want.wheel = false
      want.hold = 'none'
      speech.until = 0
      unfolded = 0
      spin = 0
      swing = 0
      phase = 0
    },
    update(dt, speed) {
      unfolded = THREE.MathUtils.clamp(unfolded + (want.wheel ? dt : -dt) / UNFOLD_S, 0, 1)
      // Rolling turns the wheel by the distance over its radius; it only rolls once fully unfolded.
      if (unfolded === 1) spin = wrap(spin + (speed * dt) / WHEEL_RADIUS)
      else if (unfolded === 0) spin = 0
      // Walking swings the outer pair against the inner pair, wider the faster it goes.
      const target = unfolded === 0 ? Math.min(0.42, Math.abs(speed) * 0.35) : 0
      swing += (target - swing) * Math.min(1, dt * 6)
      phase += ((speed * dt) / STRIDE) * Math.PI
      if (swing < 0.01 && Math.abs(speed) < 0.01) phase = Math.round(phase / Math.PI) * Math.PI
      const k = unfolded * unfolded * (3 - 2 * unfolded)
      let low = 0
      for (let i = 0; i < 4; i++) {
        const outer = i === 0 || i === 3
        let walk = (outer ? 1 : -1) * swing * Math.sin(phase)
        if (!outer && want.hold === 'astronaut') walk = HOLD
        const a = (1 - k) * walk + k * wrap((WHEEL[i] as number) + spin)
        angles[i] = a
        ;(slabs[i] as THREE.Group).rotation.x = a
        // How far below the hinge this slab reaches: the hinge stands that high.
        low = Math.max(
          low,
          (SLAB.length / 2) * Math.abs(Math.cos(a)) + (SLAB.depth / 2) * Math.abs(Math.sin(a)),
        )
      }
      body.position.y = low + 0.004
      sample.visible = want.hold === 'sample'
      // The display brightens and flickers while it speaks.
      const speaking = performance.now() < speech.until
      display.emissiveIntensity = speaking ? 2.4 + Math.sin(performance.now() / 70) * 0.8 : 1.6
    },
  }
}
