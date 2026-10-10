import * as THREE from 'three'
import { nasaModel } from './assets.js'
import { bake } from './bake.js'
import { type Base, LAYOUT, part } from './base.js'
import { buildMonolith, type Monolith } from './monolith.js'
import { heightAt } from './terrain.js'

/** The four-slab robot: its id and display name, in one place so it is easy to rename. */
export const MONOLITH = { id: 'monolith-01', name: 'Monolith' } as const

/** The MHS devices of Agnes Base, in the order the overview tags them. */
export const DEVICES: { id: string; name: string }[] = [
  { id: 'habitat-01', name: 'Habitat' },
  { id: 'airlock-01', name: 'Airlock' },
  { id: 'suit-01', name: 'Suit' },
  { id: 'rover-01', name: 'Rover' },
  { id: 'hopper-01', name: 'Hopper' },
  { id: MONOLITH.id, name: MONOLITH.name },
  { id: 'lab-01', name: 'Lab' },
  { id: 'power-01', name: 'Power' },
  { id: 'weather-01', name: 'Weather station' },
  { id: 'comms-01', name: 'Comms dish' },
  { id: 'cam-base', name: 'Base camera' },
]

/** How far the weather station is turned from facing south, in radians. */
export const WEATHER_TURN = 0.3

const std = (color: number, roughness = 0.5, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness })
const glow = (color: number, intensity: number) =>
  new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity })
const white = () => std(0xe9e5dd, 0.45, 0.05)
const metal = () => std(0x8d9298, 0.35, 0.75)
const dark = () => std(0x26282c, 0.45, 0.4)

function place(object: THREE.Object3D, x: number, z: number, turn = 0, lift = 0): THREE.Object3D {
  object.position.set(x, heightAt(x, z) + lift, z)
  object.rotation.y = turn
  return object
}

/** The lab's arm on a short rail, scaled to reach a sample on the docked rover. */
function labArm(): { group: THREE.Group; joints: THREE.Object3D[]; wrist: THREE.Object3D } {
  const g = new THREE.Group()
  g.add(part(new THREE.BoxGeometry(3, 0.12, 0.3), metal(), 0, 0.06, 0))
  const carriage = new THREE.Group()
  carriage.position.x = 0.4
  g.add(carriage)
  carriage.add(part(new THREE.BoxGeometry(0.6, 0.25, 0.5), dark(), 0, 0.25, 0))
  carriage.add(part(new THREE.CylinderGeometry(0.16, 0.2, 0.2, 32), dark(), 0, 0.47, 0))
  const base = new THREE.Group()
  base.position.y = 0.57
  carriage.add(base)
  base.add(part(new THREE.CylinderGeometry(0.12, 0.14, 0.35, 32), white(), 0, 0.17, 0))
  const shoulder = new THREE.Group()
  shoulder.position.y = 0.35
  shoulder.rotation.z = -0.55
  base.add(shoulder)
  shoulder.add(part(new THREE.SphereGeometry(0.13, 24, 16), dark()))
  shoulder.add(part(new THREE.CylinderGeometry(0.08, 0.09, 0.9, 24), white(), 0, 0.45, 0))
  const elbow = new THREE.Group()
  elbow.position.y = 0.9
  elbow.rotation.z = 1.25
  shoulder.add(elbow)
  elbow.add(part(new THREE.SphereGeometry(0.1, 24, 16), dark()))
  elbow.add(part(new THREE.CylinderGeometry(0.06, 0.07, 0.75, 24), white(), 0, 0.37, 0))
  const wrist = new THREE.Group()
  wrist.position.y = 0.75
  elbow.add(wrist)
  wrist.add(part(new THREE.CylinderGeometry(0.06, 0.05, 0.16, 16), dark(), 0, 0.08, 0))
  wrist.add(part(new THREE.SphereGeometry(0.035, 12, 8), glow(0x6cf2ff, 4), 0, 0.2, 0.04))
  for (const side of [-1, 1])
    wrist.add(part(new THREE.BoxGeometry(0.025, 0.12, 0.05), metal(), side * 0.04, 0.22, 0))
  return { group: g, joints: [base, shoulder, elbow], wrist }
}

function weatherStation(): { group: THREE.Group; cups: THREE.Object3D } {
  const g = new THREE.Group()
  g.add(part(new THREE.BoxGeometry(0.6, 0.12, 0.6), dark(), 0, 0.06, 0))
  g.add(part(new THREE.CylinderGeometry(0.05, 0.06, 3.4, 12), metal(), 0, 1.7, 0))
  g.add(part(new THREE.BoxGeometry(0.34, 0.42, 0.2), white(), 0, 1.25, 0.12))
  const panel = part(new THREE.BoxGeometry(0.7, 0.03, 0.45), std(0x0f1d38, 0.25, 0.5), 0, 2.0, -0.26)
  panel.rotation.x = -0.6
  g.add(panel, part(new THREE.BoxGeometry(0.05, 0.05, 0.22), metal(), 0, 2.0, -0.1))
  g.add(part(new THREE.BoxGeometry(1.0, 0.04, 0.04), metal(), 0, 3.25, 0))
  const cups = new THREE.Group()
  cups.position.set(0.45, 3.35, 0)
  g.add(cups)
  cups.add(part(new THREE.CylinderGeometry(0.015, 0.015, 0.12, 8), metal(), 0, -0.06, 0))
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    const arm = part(
      new THREE.BoxGeometry(0.22, 0.012, 0.012),
      metal(),
      Math.cos(a) * 0.11,
      0,
      Math.sin(a) * 0.11,
    )
    arm.rotation.y = -a
    cups.add(arm)
    cups.add(
      part(
        new THREE.SphereGeometry(0.04, 12, 8, 0, Math.PI),
        white(),
        Math.cos(a) * 0.22,
        0,
        Math.sin(a) * 0.22,
      ),
    )
  }
  const vane = part(new THREE.BoxGeometry(0.32, 0.12, 0.01), white(), -0.55, 3.38, 0)
  g.add(vane, part(new THREE.SphereGeometry(0.03, 8, 6), glow(0x46ff7a, 4), 0, 3.5, 0))
  return { group: g, cups }
}

function commsDish(): { group: THREE.Group; head: THREE.Object3D } {
  const g = new THREE.Group()
  g.add(part(new THREE.BoxGeometry(1.6, 0.4, 1.6), std(0x8f8a84, 0.9), 0, 0.2, 0))
  g.add(part(new THREE.CylinderGeometry(0.16, 0.2, 3.6, 16), metal(), 0, 2.2, 0))
  const head = new THREE.Group()
  head.position.y = 4.1
  head.rotation.set(-0.95, 0.75, 0)
  g.add(head)
  const profile: THREE.Vector2[] = []
  for (let i = 0; i <= 16; i++) {
    const r = (i / 16) * 2.4
    profile.push(new THREE.Vector2(r, (r * r) / 4.8))
  }
  const dish = part(
    new THREE.LatheGeometry(profile, 64),
    new THREE.MeshStandardMaterial({
      color: 0xece8e0,
      roughness: 0.4,
      metalness: 0.1,
      side: THREE.DoubleSide,
    }),
  )
  head.add(dish)
  // Three struts from the rim to the feed horn.
  const feed = new THREE.Vector3(0, 2.0, 0)
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    const rim = new THREE.Vector3(Math.cos(a) * 2.2, (2.2 * 2.2) / 4.8, Math.sin(a) * 2.2)
    const strut = part(new THREE.CylinderGeometry(0.02, 0.02, rim.distanceTo(feed), 6), metal())
    strut.position.copy(rim).add(feed).multiplyScalar(0.5)
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), feed.clone().sub(rim).normalize())
    head.add(strut)
  }
  head.add(part(new THREE.CylinderGeometry(0.12, 0.08, 0.35, 16), dark(), 0, 2.0, 0))
  g.add(part(new THREE.SphereGeometry(0.07, 10, 8), glow(0xff2a1a, 6), 0, 4.0, 0))
  return { group: g, head }
}

function camera(pole: number): THREE.Group {
  const g = new THREE.Group()
  if (pole > 0) g.add(part(new THREE.CylinderGeometry(0.06, 0.08, pole, 10), metal(), 0, pole / 2, 0))
  else
    for (let i = 0; i < 3; i++) {
      const leg = part(new THREE.CylinderGeometry(0.02, 0.025, 1.4, 6), metal())
      const a = (i / 3) * Math.PI * 2
      leg.position.set(Math.cos(a) * 0.3, 0.65, Math.sin(a) * 0.3)
      leg.rotation.set(Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4)
      g.add(leg)
    }
  const top = pole > 0 ? pole : 1.3
  const head = new THREE.Group()
  head.position.y = top + 0.15
  g.add(head)
  head.add(part(new THREE.BoxGeometry(0.22, 0.2, 0.42), white()))
  head.add(part(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 20), dark(), 0, 0, 0.24).rotateX(Math.PI / 2))
  head.add(part(new THREE.CircleGeometry(0.05, 20), std(0x112233, 0.05, 0.7), 0, 0, 0.285))
  head.add(part(new THREE.SphereGeometry(0.02, 8, 6), glow(0xff3020, 6), 0.08, 0.08, 0.21))
  head.name = 'head'
  return g
}

/** A thin rod from `a` to `b`. */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, material: THREE.Material): THREE.Mesh {
  const m = part(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 8), material)
  m.position.copy(a).add(b).multiplyScalar(0.5)
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  return m
}

/**
 * The rocket hopper: a small lander on four legs, with two gold-wrapped propellant tanks, a main
 * engine pointing down, thruster pods on the deck's rim, and a plume under the nozzle that shows
 * the thrust. It faces +z; `frame` holds everything that leans into a move.
 */
function hopperModel(): {
  group: THREE.Group
  frame: THREE.Group
  plume: THREE.Object3D
  plumeLook: THREE.MeshBasicMaterial
  dust: THREE.Mesh
} {
  const group = new THREE.Group()
  const frame = new THREE.Group()
  group.add(frame)
  const hull = white()
  const steel = metal()
  const black = dark()
  const foil = std(0xc9a144, 0.32, 0.85)
  // The deck, an octagon with a flat side to the front, and the thrust structure under it.
  frame.add(part(new THREE.CylinderGeometry(0.8, 0.8, 0.22, 8).rotateY(Math.PI / 8), hull, 0, 1.05, 0))
  frame.add(part(new THREE.CylinderGeometry(0.36, 0.46, 0.24, 16), black, 0, 0.82, 0))
  // The main engine: throat and bell, open at the bottom.
  frame.add(part(new THREE.CylinderGeometry(0.12, 0.12, 0.14, 16), steel, 0, 0.66, 0))
  const bell = new THREE.MeshStandardMaterial({
    color: 0x2e2a28,
    roughness: 0.4,
    metalness: 0.8,
    side: THREE.DoubleSide,
  })
  frame.add(part(new THREE.CylinderGeometry(0.1, 0.24, 0.4, 24, 1, true), bell, 0, 0.4, 0))
  // Fuel and oxidizer tanks in gold foil, and the avionics box between them at the back.
  for (const side of [-1, 1]) {
    frame.add(part(new THREE.SphereGeometry(0.36, 24, 16), foil, side * 0.4, 1.5, 0.05))
    frame.add(part(new THREE.CylinderGeometry(0.05, 0.05, 0.2, 8), steel, side * 0.4, 1.2, 0.05))
  }
  frame.add(part(new THREE.BoxGeometry(0.5, 0.3, 0.36), hull, 0, 1.31, -0.5))
  frame.add(part(new THREE.CylinderGeometry(0.012, 0.012, 0.7, 6), steel, 0.18, 1.8, -0.55))
  frame.add(part(new THREE.SphereGeometry(0.03, 8, 6), glow(0xff3020, 6), 0.18, 2.16, -0.55))
  // Four legs, each a strut and a brace down to a footpad.
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    const foot = new THREE.Vector3(c * 1.25, 0.08, s * 1.25)
    frame.add(rod(new THREE.Vector3(c * 0.62, 1.0, s * 0.62), foot, 0.035, steel))
    frame.add(rod(new THREE.Vector3(c * 0.34, 0.78, s * 0.34), foot, 0.025, steel))
    frame.add(part(new THREE.CylinderGeometry(0.15, 0.18, 0.06, 16), black, foot.x, 0.04, foot.z))
    // A thruster pod on the rim between the legs, nozzles out to both sides.
    const b = a + Math.PI / 4
    const pod = part(
      new THREE.BoxGeometry(0.12, 0.1, 0.12),
      black,
      Math.cos(b) * 0.84,
      1.05,
      Math.sin(b) * 0.84,
    )
    pod.rotation.y = -b
    frame.add(pod)
  }
  // The forward camera under the front of the deck, and the downward camera beside the engine.
  frame.add(part(new THREE.BoxGeometry(0.16, 0.12, 0.16), black, 0, 0.9, 0.72))
  frame.add(part(new THREE.CircleGeometry(0.04, 16), std(0x112233, 0.05, 0.7), 0, 0.9, 0.805))
  frame.add(part(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 16), black, 0.45, 0.88, 0.3))

  // The plume: faint, bluish at the nozzle and fading as it spreads in the thin air. Additive, so
  // it glows over whatever lies behind it, and bright enough for the bloom pass.
  const plumeLook = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    side: THREE.DoubleSide,
  })
  const plume = new THREE.Group()
  plume.position.y = 0.2
  plume.visible = false
  const cone = (top: number, bottom: number, length: number, near: THREE.Color, far: THREE.Color) => {
    const g = new THREE.CylinderGeometry(top, bottom, length, 24, 8, true).translate(0, -length / 2, 0)
    const at = g.getAttribute('position')
    const colors = new Float32Array(at.count * 4)
    for (let i = 0; i < at.count; i++) {
      const k = -at.getY(i) / length
      const c = near.clone().lerp(far, k)
      colors.set([c.r, c.g, c.b, (1 - k) ** 2], i * 4)
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 4))
    return new THREE.Mesh(g, plumeLook)
  }
  plume.add(cone(0.23, 0.9, 2.6, new THREE.Color(1.6, 1.3, 2.0), new THREE.Color(1.4, 0.6, 0.25)))
  plume.add(cone(0.17, 0.08, 0.9, new THREE.Color(3, 3, 4), new THREE.Color(1.8, 1.5, 2.2)))
  frame.add(plume)
  // Dust blown off the ground under the engine when it flies low.
  const dust = new THREE.Mesh(
    new THREE.RingGeometry(0.6, 2.2, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xc4895f, transparent: true, opacity: 0, depthWrite: false }),
  )
  dust.visible = false
  group.add(dust)
  bake(frame, [plume])
  return { group, frame, plume, plumeLook, dust }
}

/** The moving parts the live devices (src/live) drive. */
export interface Parts {
  rover: THREE.Object3D
  hopper: THREE.Object3D
  /** The hopper's engine thrust, 0 (off) to 1 (full); the plume follows it. */
  thrust: { level: number }
  /** The astronaut out in the field, wearing suit-01. */
  astronaut: THREE.Object3D
  /** The four-slab robot. */
  monolith: Monolith
  /** The lab arm's turntable, shoulder and elbow, and its wrist; `busy` stops its idle sweep. */
  arm: { joints: THREE.Object3D[]; wrist: THREE.Object3D; busy: boolean }
  dishHead: THREE.Object3D
  /** The base camera's head: rotation.y pans, rotation.x tilts. */
  camHead: THREE.Object3D
  /** The airlock's outer door on its hinge. */
  door: THREE.Object3D
  windows: THREE.MeshStandardMaterial
  tiltPanels(deg: number): void
}

export interface Devices {
  group: THREE.Group
  anchors: Map<string, THREE.Object3D>
  parts: Parts
  update(t: number): void
}

export async function buildDevices(base: Base): Promise<Devices> {
  const group = new THREE.Group()
  const anchors = new Map(base.anchors)

  const [rover, astronaut] = await Promise.all([
    nasaModel('perseverance', 3.0),
    nasaModel('mark3_suit', 1.85),
  ])
  // The rover stands in its dock, nose to the garage, its side to the lab's sample port.
  const [kx, kz] = LAYOUT.dock
  group.add(place(rover, kx, kz + 0.4, Math.PI))
  anchors.set('rover-01', rover)
  const hopper = hopperModel()
  const [hx, hz] = LAYOUT.hopperPad
  group.add(place(hopper.group, hx, hz, -Math.PI / 2, 0.12))
  anchors.set('hopper-01', hopper.group)
  // The astronaut works at the rock outcrop out in the west field.
  const [fx, fz] = LAYOUT.field
  group.add(place(astronaut, fx, fz, -2.3))
  anchors.set('suit-01', astronaut)

  // Monolith waits beside the airlock, facing south over the base.
  const monolith = buildMonolith()
  const [mx, mz] = LAYOUT.monolith
  group.add(place(monolith.group, mx, mz, 0.45))
  anchors.set(MONOLITH.id, monolith.group)

  // The lab's arm stands between the lab and the dock and reaches over the rover.
  const arm = labArm()
  const [lx, lz] = LAYOUT.lab
  place(arm.group, lx + 4.8, lz, Math.PI / 2, 0.02)
  arm.group.scale.setScalar(1.5)
  group.add(arm.group)

  const weather = weatherStation()
  group.add(place(weather.group, LAYOUT.weather[0], LAYOUT.weather[1], WEATHER_TURN))
  anchors.set('weather-01', weather.group)

  const dish = commsDish()
  group.add(place(dish.group, LAYOUT.comms[0], LAYOUT.comms[1]))
  anchors.set('comms-01', dish.group)

  // The base camera on a tall mast south of the base, looking north over the dock, airlock and hopper pad.
  const [cx, cz] = LAYOUT.camBase
  const baseCam = camera(6)
  group.add(place(baseCam, cx, cz))
  ;(baseCam.getObjectByName('head') as THREE.Object3D).lookAt(cx + 2, 0, cz - 30)
  anchors.set('cam-base', baseCam)

  bake(weather.group, [weather.cups])
  bake(dish.group, [dish.head])
  const camHead = baseCam.getObjectByName('head') as THREE.Object3D
  bake(baseCam, [camHead])

  const thrust = { level: 0 }

  const parts: Parts = {
    rover,
    hopper: hopper.group,
    thrust,
    astronaut,
    monolith,
    arm: { joints: arm.joints, wrist: arm.wrist, busy: false },
    dishHead: dish.head,
    camHead,
    door: base.door,
    windows: base.windows,
    tiltPanels: base.tiltPanels,
  }
  let lastT = 0
  const was = hopper.group.position.clone()
  let lean = 0
  const monolithWas = monolith.group.position.clone()
  return {
    group,
    anchors,
    parts,
    update(t) {
      const dt = Math.min(0.1, t - lastT)
      lastT = t
      weather.cups.rotation.y = t * 5
      // The plume flickers with the thrust; the hopper leans a little into its forward speed.
      const { level } = thrust
      const h = hopper.group
      hopper.plume.visible = level > 0.02
      if (hopper.plume.visible) {
        const flicker = 1 + 0.07 * Math.sin(t * 47) + 0.05 * Math.sin(t * 29)
        hopper.plume.scale.set(0.8 + 0.2 * level, (0.5 + 0.6 * level) * flicker, 0.8 + 0.2 * level)
        hopper.plumeLook.opacity = level * (0.85 + 0.15 * Math.sin(t * 61))
      }
      if (dt > 0) {
        const forward =
          ((h.position.x - was.x) * Math.sin(h.rotation.y) +
            (h.position.z - was.z) * Math.cos(h.rotation.y)) /
          dt
        lean += (Math.max(-0.2, Math.min(0.2, forward * 0.025)) - lean) * Math.min(1, dt * 4)
        hopper.frame.rotation.x = lean
      }
      was.copy(h.position)
      // Monolith's slabs follow how fast it moves forward.
      const m = monolith.group
      const ahead =
        dt > 0
          ? ((m.position.x - monolithWas.x) * Math.sin(m.rotation.y) +
              (m.position.z - monolithWas.z) * Math.cos(m.rotation.y)) /
            dt
          : 0
      monolithWas.copy(m.position)
      monolith.update(dt, ahead)
      const ground = heightAt(h.position.x, h.position.z)
      const altitude = h.position.y - ground
      hopper.dust.visible = level > 0.02 && altitude < 6
      if (hopper.dust.visible) {
        hopper.dust.position.y = ground + 0.05 - h.position.y
        hopper.dust.scale.setScalar(0.8 + altitude * 0.35)
        ;(hopper.dust.material as THREE.MeshBasicMaterial).opacity = 0.45 * level * (1 - altitude / 6)
      }
      // The arm idles, sweeping slowly over the docked rover until it gets work.
      if (!parts.arm.busy) {
        const [b, s] = arm.joints as [THREE.Object3D, THREE.Object3D]
        b.rotation.y = Math.sin(t * 0.3) * 0.5
        s.rotation.z = -0.55 + Math.sin(t * 0.45) * 0.08
      }
    },
  }
}
