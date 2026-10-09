import * as THREE from 'three'
import { canvasTexture, pbr, seeded } from './assets.js'
import { bake } from './bake.js'
import { buildDetails, DETAIL_FOOTPRINTS, DETAIL_POSTS } from './details.js'
import { buildFlag, buildSign } from './flag.js'
import type { Footprint } from './live/map.js'
import { heightAt } from './terrain.js'

/** Where the buildings stand, in metres; devices.ts places the movable devices around them. */
export const LAYOUT = {
  habitat: [0, 0] as const,
  airlockDoor: [0, 12.2] as const,
  greenhouse: [18.5, -2] as const,
  garage: [-17, 1] as const,
  solar: [21, 20] as const,
  battery: [10.5, 20] as const,
  landingPad: [6, 42] as const,
  /** The rocket hopper's pad, where it lands and refuels. */
  hopperPad: [27, 8] as const,
  dock: [-15.5, 15.5] as const,
  lab: [-24, 15.5] as const,
  camBase: [-4, 28] as const,
  weather: [-4.5, -15] as const,
  comms: [-13, -12] as const,
  /** The Agnes flag and the base's name board, beside the airlock. */
  flag: [-6.5, 12] as const,
  /** The rock outcrop out in the field, where the astronaut works. */
  field: [-31, 27] as const,
  /** Where Monolith waits, beside the airlock. */
  monolith: [3.4, 15.4] as const,
  /** Spots at the outcrop the astronaut walks between on their own, stopping at each to work. */
  worksite: [
    [-31, 27],
    [-29.8, 28],
    [-30.3, 25.8],
  ] as const,
}

const std = (
  color: number,
  roughness = 0.55,
  metalness = 0,
  extra: THREE.MeshStandardMaterialParameters = {},
) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra })
const glow = (color: number, intensity: number) =>
  new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity })

export function part(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material)
  m.position.set(x, y, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

/** Hull panels: off-white composite with faint seams and a little dust. */
function hullMaterial(u: number, v: number, dusty = true): THREE.MeshStandardMaterial {
  const seams = canvasTexture(512, (g, s) => {
    g.fillStyle = '#e9e3d8'
    g.fillRect(0, 0, s, s)
    const random = seeded(3)
    for (let i = 0; i < 900; i++) {
      g.fillStyle = `rgba(150, 95, 60, ${random() * 0.05})`
      g.fillRect(random() * s, random() * s, 2 + random() * 30, 2 + random() * 30)
    }
    g.strokeStyle = 'rgba(70, 60, 50, 0.45)'
    g.lineWidth = 3
    g.strokeRect(1.5, 1.5, s - 3, s - 3)
    g.strokeStyle = 'rgba(70, 60, 50, 0.2)'
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(s / 2, 0)
    g.lineTo(s / 2, s)
    g.stroke()
    if (dusty) {
      const grad = g.createLinearGradient(0, s * 0.6, 0, s)
      grad.addColorStop(0, 'rgba(176, 96, 55, 0)')
      grad.addColorStop(1, 'rgba(176, 96, 55, 0.18)')
      g.fillStyle = grad
      g.fillRect(0, 0, s, s)
    }
  })
  seams.repeat.set(u, v)
  return std(0xffffff, 0.62, 0.02, { map: seams })
}

const metal = () => std(0x8d9298, 0.38, 0.75)
const dark = () => std(0x2b2d31, 0.5, 0.4)

/** A half cylinder lying along x, arched over y >= 0. */
function archGeometry(radius: number, length: number, segments = 48): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, length, segments, 1, true, 0, Math.PI)
  g.rotateZ(Math.PI / 2)
  return g
}

function onGround(object: THREE.Object3D, x: number, z: number, lift = 0): THREE.Object3D {
  object.position.set(x, heightAt(x, z) + lift, z)
  return object
}

function habitat(): THREE.Group {
  const g = new THREE.Group()
  const hull = hullMaterial(16, 4)
  g.add(part(new THREE.CylinderGeometry(7, 7, 1.4, 64, 1, true), hull, 0, 0.7, 0))
  g.add(
    part(
      new THREE.SphereGeometry(7, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2),
      hullMaterial(18, 5, false),
      0,
      1.4,
      0,
    ),
  )
  // Regolith piled around the foot of the dome, for radiation shielding.
  const berm = pbr('rock_face', [10, 1], { color: new THREE.Color(1, 0.72, 0.58) })
  g.add(part(new THREE.CylinderGeometry(7.15, 9.6, 1.7, 64, 1, true), berm, 0, 0.8, 0))
  // A ring of warm windows; their look follows the habitat's mode, so it stays its own material.
  const window = glow(0xffc387, 1.45)
  window.name = 'habitat-windows'
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + 0.11
    if (Math.abs(Math.sin(a)) > 0.97 && Math.cos(a) > -0.2) continue
    const w = part(new THREE.BoxGeometry(0.95, 0.42, 0.06), window)
    const r = 6.86
    w.position.set(Math.sin(a) * r, 2.75, Math.cos(a) * r)
    w.lookAt(0, 2.75 - 1.3, 0)
    w.rotateY(Math.PI)
    g.add(w)
  }
  // Roof hatch, mast and a beacon.
  g.add(part(new THREE.CylinderGeometry(0.9, 1, 0.3, 32), metal(), 0, 8.5, 0))
  g.add(part(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8), metal(), 0.5, 9.6, 0.3))
  const beacon = part(new THREE.SphereGeometry(0.08, 12, 8), glow(0xff2a1a, 6), 0.5, 10.75, 0.3)
  beacon.name = 'beacon'
  g.add(beacon)
  return g
}

function airlock(): { group: THREE.Group; door: THREE.Object3D } {
  const g = new THREE.Group()
  const body = part(new THREE.CylinderGeometry(1.75, 1.75, 5.4, 48), hullMaterial(6, 2))
  body.rotation.x = Math.PI / 2
  body.position.set(0, 1.9, 9.4)
  g.add(body)
  g.add(part(new THREE.BoxGeometry(2.6, 0.5, 5.2), dark(), 0, 0.25, 9.4))
  const ring = part(new THREE.TorusGeometry(1.75, 0.12, 12, 48), metal(), 0, 1.9, 12.1)
  g.add(ring)
  // The outer door swings on a hinge at its east edge.
  const door = new THREE.Group()
  door.position.set(1.45, 1.9, 12.12)
  const leaf = new THREE.Group()
  leaf.position.x = -1.45
  door.add(leaf)
  leaf.add(part(new THREE.CircleGeometry(1.45, 48), std(0xd9d4cb, 0.5, 0.2)))
  leaf.add(part(new THREE.CircleGeometry(0.32, 32), std(0x223344, 0.05, 0.6), 0, 0.55, 0.01))
  leaf.add(part(new THREE.TorusGeometry(0.34, 0.04, 8, 32), metal(), 0, 0.55, 0.015))
  leaf.add(part(new THREE.BoxGeometry(0.5, 0.08, 0.06), metal(), 0, -0.2, 0.04))
  g.add(door)
  g.add(part(new THREE.BoxGeometry(0.16, 0.16, 0.05), glow(0x46ff7a, 5), 1.15, 3.0, 12.15))
  g.add(part(new THREE.BoxGeometry(0.16, 0.16, 0.05), glow(0xffa21a, 5), -1.15, 3.0, 12.15))
  // A ramp down to the ground.
  const ramp = part(new THREE.BoxGeometry(2.2, 0.1, 1.9), pbr('metal_plate', [2, 2]), 0, 0.28, 13.0)
  ramp.rotation.x = 0.12
  g.add(ramp)
  // A floodlight over the door, for dusk.
  const flood = new THREE.SpotLight(0xffe1b8, 18, 16, Math.PI / 4, 0.6, 1.5)
  flood.position.set(0, 3.9, 12.6)
  flood.target.position.set(0, 0, 16)
  g.add(flood, flood.target, part(new THREE.BoxGeometry(0.5, 0.18, 0.25), glow(0xfff1d6, 3), 0, 3.85, 12.25))
  // The tunnel to the greenhouse.
  const tunnel = part(new THREE.CylinderGeometry(1.15, 1.15, 4.6, 32), hullMaterial(4, 1))
  tunnel.rotation.z = Math.PI / 2
  tunnel.position.set(9, 1.35, -2)
  g.add(tunnel)
  return { group: g, door }
}

/** The greenhouse: a glass arch with ribs, grow lights, two rows of tomato plants. */
function greenhouse(): THREE.Group {
  const g = new THREE.Group()
  const [gx, gz] = LAYOUT.greenhouse
  const length = 16
  const radius = 3.4
  g.position.set(gx, 0, gz)
  const glass = std(0xcfe2ee, 0.06, 0.1, {
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const shell = new THREE.Mesh(archGeometry(radius, length), glass)
  shell.position.y = 0.4
  g.add(shell)
  for (const side of [-1, 1]) {
    const end = new THREE.Mesh(new THREE.CircleGeometry(radius, 32, 0, Math.PI), glass)
    end.rotation.y = (side * Math.PI) / 2
    end.position.set((side * length) / 2, 0.4, 0)
    g.add(end)
  }
  const ribMaterial = metal()
  for (let i = 0; i <= 8; i++) {
    const rib = part(new THREE.TorusGeometry(radius, 0.06, 6, 40, Math.PI), ribMaterial)
    rib.rotation.y = Math.PI / 2
    rib.position.set(-length / 2 + i * (length / 8), 0.4, 0)
    g.add(rib)
  }
  g.add(part(new THREE.BoxGeometry(length + 0.4, 0.4, radius * 2 + 0.4), hullMaterial(8, 2), 0, 0.2, 0))
  g.add(part(new THREE.BoxGeometry(length, 0.04, radius * 2 - 0.3), pbr('metal_plate', [8, 3]), 0, 0.42, 0))
  // Planters and plants.
  const soil = std(0x3b2418, 0.95)
  const leaves = std(0x4c8f33, 0.7)
  const fruit = std(0xc8321e, 0.35)
  const random = seeded(11)
  const plantGeo = new THREE.IcosahedronGeometry(0.32, 1)
  const fruitGeo = new THREE.SphereGeometry(0.055, 10, 8)
  const plants = new THREE.InstancedMesh(plantGeo, leaves, 2 * 24)
  const tomatoes = new THREE.InstancedMesh(fruitGeo, fruit, 2 * 24 * 4)
  const m = new THREE.Matrix4()
  let p = 0
  let t = 0
  for (const z of [-1.75, 1.75]) {
    g.add(part(new THREE.BoxGeometry(length - 1.2, 0.5, 1.0), std(0xd8d2c6, 0.6), 0, 0.67, z))
    g.add(part(new THREE.BoxGeometry(length - 1.4, 0.04, 0.85), soil, 0, 0.93, z))
    for (let i = 0; i < 24; i++) {
      const x = -length / 2 + 1.1 + i * 0.58
      const s = 0.8 + random() * 0.5
      m.compose(
        new THREE.Vector3(x, 1.2 + random() * 0.1, z + (random() - 0.5) * 0.2),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, random() * 6, 0)),
        new THREE.Vector3(s, s * 1.4, s),
      )
      plants.setMatrixAt(p++, m)
      for (let k = 0; k < 4; k++) {
        m.makeTranslation(x + (random() - 0.5) * 0.45, 1.0 + random() * 0.55, z + (random() - 0.5) * 0.45)
        tomatoes.setMatrixAt(t++, m)
      }
    }
  }
  plants.castShadow = true
  g.add(plants, tomatoes)
  // Grow lights along the ridge, and their light.
  for (const z of [-1.1, 1.1])
    g.add(part(new THREE.BoxGeometry(length - 1, 0.05, 0.12), glow(0xffc4f0, 0.55), 0, 3.35, z))
  const growLight = new THREE.PointLight(0xffb8e8, 10, 14, 1.6)
  growLight.position.set(0, 3.0, 0)
  g.add(growLight)
  return g
}

/** The rover garage: a corrugated arch open to the south. */
function garage(): THREE.Group {
  const g = new THREE.Group()
  const [x, z] = LAYOUT.garage
  g.position.set(x, 0, z)
  const corrugated = canvasTexture(256, (c, s) => {
    for (let i = 0; i < 16; i++) {
      c.fillStyle = i % 2 ? '#cfc8bc' : '#e8e1d5'
      c.fillRect(0, (i * s) / 16, s, s / 16)
    }
  })
  corrugated.repeat.set(1, 30)
  const shell = part(
    archGeometry(4.3, 10),
    std(0xffffff, 0.5, 0.35, { map: corrugated, side: THREE.DoubleSide }),
  )
  shell.rotation.y = Math.PI / 2
  shell.position.y = 0.2
  g.add(shell)
  const back = part(new THREE.CircleGeometry(4.3, 32, 0, Math.PI), hullMaterial(3, 2))
  back.position.set(0, 0.2, -5)
  g.add(back)
  g.add(part(new THREE.BoxGeometry(8.4, 0.2, 13), pbr('metal_plate', [4, 6]), 0, 0.1, 1.3))
  g.add(part(new THREE.BoxGeometry(0.15, 0.05, 9), glow(0xfff0d8, 2.2), 0, 4.3, 0))
  const lamp = new THREE.PointLight(0xfff0d8, 6, 10, 1.6)
  lamp.position.set(0, 3.6, 0)
  g.add(lamp)
  return g
}

/** Panel tilt of the solar array in use, in degrees; stowed panels stand nearly on edge. */
export const PANEL_TILT = { deployed: 24, stowed: 80 }

/** The solar array of the power system: rows of panels tilted to the south, one instanced mesh. */
function solarField(): { group: THREE.Group; tilt(deg: number): void } {
  const g = new THREE.Group()
  const cells = canvasTexture(512, (c, s) => {
    c.fillStyle = '#0d1a33'
    c.fillRect(0, 0, s, s)
    c.strokeStyle = 'rgba(170, 190, 220, 0.55)'
    c.lineWidth = 2
    for (let i = 0; i <= 8; i++) {
      c.beginPath()
      c.moveTo((i * s) / 8, 0)
      c.lineTo((i * s) / 8, s)
      c.stroke()
    }
    for (let i = 0; i <= 4; i++) {
      c.beginPath()
      c.moveTo(0, (i * s) / 4)
      c.lineTo(s, (i * s) / 4)
      c.stroke()
    }
  })
  const frame = metal()
  const [cx, cz] = LAYOUT.solar
  const panels = new THREE.InstancedMesh(
    new THREE.BoxGeometry(2.6, 0.06, 1.5),
    std(0xffffff, 0.22, 0.5, { map: cells }),
    24,
  )
  panels.castShadow = true
  panels.receiveShadow = true
  g.add(panels)
  const mounts: THREE.Vector3[] = []
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 6; col++) {
      const x = cx - 7.5 + col * 3
      const z = cz - 5 + row * 3.4
      const unit = new THREE.Group()
      onGround(unit, x, z)
      unit.add(part(new THREE.CylinderGeometry(0.06, 0.08, 1.1, 8), frame, 0, 0.55, 0))
      unit.add(part(new THREE.BoxGeometry(0.12, 0.12, 0.3), frame, 0, 1.1, 0))
      g.add(unit)
      mounts.push(new THREE.Vector3(x, unit.position.y + 1.15, z))
    }
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const one = new THREE.Vector3(1, 1, 1)
  const tilt = (deg: number) => {
    q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(deg))
    for (const [i, at] of mounts.entries()) panels.setMatrixAt(i, m.compose(at, q, one))
    panels.instanceMatrix.needsUpdate = true
    panels.computeBoundingSphere()
  }
  tilt(PANEL_TILT.deployed)
  return { group: g, tilt }
}

/** The rover dock: a marked bay south of the garage, with a charging post on its east side. */
function dock(): { group: THREE.Group; charger: THREE.Object3D } {
  const g = new THREE.Group()
  const [x, z] = LAYOUT.dock
  onGround(g, x, z)
  const stripes = canvasTexture(512, (c, s) => {
    c.fillStyle = '#5d5853'
    c.fillRect(0, 0, s, s)
    c.strokeStyle = '#d9b23a'
    c.lineWidth = 22
    c.strokeRect(14, 14, s - 28, s - 28)
    c.fillStyle = '#d9b23a'
    for (let i = 0; i < 6; i++) c.fillRect(s * 0.3 + i * s * 0.07, s * 0.06, s * 0.035, s * 0.07)
  })
  g.add(part(new THREE.BoxGeometry(4.6, 0.08, 7), std(0xffffff, 0.85, 0.1, { map: stripes }), 0, 0.04, 0))
  // The charging post, with a cable and a green ready light.
  const charger = new THREE.Group()
  charger.position.set(2.8, 0, -2.2)
  charger.add(part(new THREE.BoxGeometry(0.5, 1.5, 0.4), hullMaterial(1, 2), 0, 0.75, 0))
  charger.add(part(new THREE.BoxGeometry(0.3, 0.12, 0.05), glow(0x46ff7a, 5), 0, 1.25, 0.21))
  charger.add(part(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 8), dark(), -0.45, 0.45, 0).rotateZ(-1.1))
  g.add(charger)
  return { group: g, charger }
}

/** The lab: a small module next to the dock, with a sample port facing the bay. */
function lab(): { group: THREE.Group; roof: THREE.Object3D } {
  const g = new THREE.Group()
  const [x, z] = LAYOUT.lab
  onGround(g, x, z)
  g.add(part(new THREE.BoxGeometry(4.4, 0.4, 7), dark(), 0, 0.2, 0))
  const body = part(new THREE.CylinderGeometry(2, 2, 6.4, 40), hullMaterial(6, 2))
  body.rotation.x = Math.PI / 2
  body.position.y = 2.3
  g.add(body)
  for (const side of [-1, 1])
    g.add(part(new THREE.TorusGeometry(2, 0.1, 10, 40), metal(), 0, 2.3, side * 3.2))
  // Windows along the side that faces the dock, and the sample port under them.
  for (const dz of [-1.6, 0, 1.6]) {
    const w = part(new THREE.BoxGeometry(0.06, 0.4, 0.9), glow(0xffc387, 1.4), 1.98, 2.9, dz)
    g.add(w)
  }
  g.add(part(new THREE.BoxGeometry(0.5, 0.7, 1.0), metal(), 2.05, 1.35, 0))
  g.add(part(new THREE.BoxGeometry(0.06, 0.4, 0.7), std(0x223344, 0.05, 0.6), 2.32, 1.4, 0))
  const roof = new THREE.Object3D()
  roof.position.set(0, 4.3, 0)
  g.add(roof)
  return { group: g, roof }
}

/** The battery bank of the power system, beside the solar array. */
function batteryBank(): THREE.Group {
  const g = new THREE.Group()
  const [x, z] = LAYOUT.battery
  onGround(g, x, z)
  g.add(part(new THREE.BoxGeometry(3.6, 0.3, 2.6), dark(), 0, 0.15, 0))
  g.add(part(new THREE.BoxGeometry(3.2, 1.9, 2.2), hullMaterial(3, 2), 0, 1.25, 0))
  // Radiator fins on the roof.
  for (let i = 0; i < 7; i++)
    g.add(part(new THREE.BoxGeometry(0.05, 0.45, 2.0), metal(), -1.3 + i * 0.43, 2.42, 0))
  // A row of charge lights on the front.
  for (let i = 0; i < 5; i++)
    g.add(
      part(
        new THREE.BoxGeometry(0.22, 0.1, 0.04),
        glow(i < 4 ? 0x46ff7a : 0x333333, 4),
        -0.6 + i * 0.3,
        1.7,
        1.12,
      ),
    )
  // The conduit to the array.
  g.add(part(new THREE.BoxGeometry(5, 0.14, 0.14), metal(), 4.1, 0.1, 0))
  return g
}

/**
 * The rocket hopper's pad: a slab of sintered regolith scorched by the engine, with a ring to land
 * in, and the propellant service unit at its south edge, hosed to the pad.
 */
function hopperPad(): THREE.Group {
  const g = new THREE.Group()
  const [x, z] = LAYOUT.hopperPad
  onGround(g, x, z)
  const top = canvasTexture(512, (c, s) => {
    c.fillStyle = '#86807a'
    c.fillRect(0, 0, s, s)
    const random = seeded(13)
    for (let i = 0; i < 1500; i++) {
      c.fillStyle = `rgba(${90 + random() * 50}, ${70 + random() * 30}, 55, ${random() * 0.12})`
      c.fillRect(random() * s, random() * s, 2 + random() * 10, 2 + random() * 10)
    }
    const scorch = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.36)
    scorch.addColorStop(0, 'rgba(24, 20, 18, 0.85)')
    scorch.addColorStop(0.6, 'rgba(40, 32, 26, 0.45)')
    scorch.addColorStop(1, 'rgba(40, 32, 26, 0)')
    c.fillStyle = scorch
    c.fillRect(0, 0, s, s)
    c.strokeStyle = '#d9b23a'
    c.lineWidth = 12
    c.beginPath()
    c.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2)
    c.stroke()
    c.fillStyle = '#d9b23a'
    for (let i = 0; i < 4; i++) {
      c.save()
      c.translate(s / 2, s / 2)
      c.rotate((i * Math.PI) / 2)
      c.fillRect(-6, -s * 0.49, 12, s * 0.06)
      c.restore()
    }
  })
  g.add(
    part(
      new THREE.CylinderGeometry(2.6, 2.75, 0.12, 48),
      [
        std(0x86807a, 0.9),
        std(0xffffff, 0.85, 0, { map: top }),
        std(0x86807a, 0.9),
      ] as unknown as THREE.Material,
      0,
      0.06,
      0,
    ),
  )
  // The service unit makes propellant from the oxygen plant's output and fills the hopper's tanks.
  const unit = new THREE.Group()
  unit.position.set(0, 0, 3.6)
  unit.rotation.y = Math.PI / 2
  unit.add(part(new THREE.BoxGeometry(0.7, 1.0, 0.9), hullMaterial(1, 1), 0, 0.5, 0))
  unit.add(part(new THREE.BoxGeometry(0.72, 0.12, 0.92), std(0xd2671f, 0.55, 0.1), 0, 0.82, 0))
  unit.add(part(new THREE.BoxGeometry(0.04, 0.12, 0.26), glow(0x46ff7a, 4), -0.37, 0.62, 0))
  unit.add(part(new THREE.CylinderGeometry(0.04, 0.04, 1.3, 8).rotateZ(Math.PI / 2), dark(), -0.95, 0.06, 0))
  g.add(unit)
  return g
}

function pads(): THREE.Group {
  const g = new THREE.Group()
  const marking = canvasTexture(1024, (c, s) => {
    c.fillStyle = '#8f8a84'
    c.fillRect(0, 0, s, s)
    const random = seeded(5)
    for (let i = 0; i < 4000; i++) {
      c.fillStyle = `rgba(${120 + random() * 60}, ${80 + random() * 40}, 60, ${random() * 0.15})`
      c.fillRect(random() * s, random() * s, 3 + random() * 14, 3 + random() * 14)
    }
    c.strokeStyle = '#d9b23a'
    c.lineWidth = 18
    c.beginPath()
    c.arc(s / 2, s / 2, s * 0.43, 0, Math.PI * 2)
    c.stroke()
    // The base's name across the north of the pad, upright for someone looking north from the base.
    // The cap maps canvas +x to world south and canvas +y to world west, hence the turn.
    c.save()
    c.translate(s * 0.135, s / 2)
    c.rotate(-Math.PI / 2)
    c.fillStyle = 'rgba(232, 228, 220, 0.92)'
    c.font = '700 84px "Helvetica Neue", Helvetica, Arial, sans-serif'
    c.letterSpacing = '12px'
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText('AGNES BASE', 0, 0)
    c.restore()
    c.strokeStyle = '#e8e4dc'
    c.lineWidth = 26
    for (const a of [0, Math.PI / 2]) {
      c.beginPath()
      c.moveTo(s / 2 + Math.cos(a) * s * 0.3, s / 2 + Math.sin(a) * s * 0.3)
      c.lineTo(s / 2 - Math.cos(a) * s * 0.3, s / 2 - Math.sin(a) * s * 0.3)
      c.stroke()
    }
  })
  const [px, pz] = LAYOUT.landingPad
  const pad = part(new THREE.CylinderGeometry(9, 9.4, 0.3, 64), [
    std(0x8f8a84, 0.9),
    std(0xffffff, 0.85, 0, { map: marking }),
    std(0x8f8a84, 0.9),
  ] as unknown as THREE.Material)
  onGround(pad, px, pz, 0.05)
  g.add(pad)
  const random = seeded(9)
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2
    const light = part(
      new THREE.BoxGeometry(0.18, 0.08, 0.18),
      glow(i % 2 ? 0x5ab0ff : 0xffffff, 3 + random()),
    )
    onGround(light, px + Math.cos(a) * 9.6, pz + Math.sin(a) * 9.6, 0.1)
    g.add(light)
  }
  g.add(hopperPad())
  return g
}

export interface Base {
  group: THREE.Group
  /** Anchors for the devices that are buildings: habitat-01, airlock-01, lab-01, power-01. */
  anchors: Map<string, THREE.Object3D>
  /** The airlock's outer door, on its hinge: rotation.y opens it. */
  door: THREE.Object3D
  /** The habitat's window glow, which shows its mode. */
  windows: THREE.MeshStandardMaterial
  /** Tilts every solar panel, in degrees. */
  tiltPanels(deg: number): void
  update(t: number): void
}

/**
 * What blocks the way at the base, in world coordinates (x east, z south), for the base map:
 * buildings, masts, the oxygen plant, cargo. Pads and the dock are open ground.
 */
export const FOOTPRINTS: Footprint[] = [
  { x: 0, z: 0, r: 9.6 },
  { x: 0, z: 9.6, w: 3.6, d: 6 },
  { x: 9, z: -2, w: 4.6, d: 2.4 },
  { x: 18.5, z: -2, w: 16.4, d: 7.2 },
  { x: -17, z: 1, w: 8.8, d: 10.2 },
  { x: 21, z: 20.1, w: 18.6, d: 12 },
  { x: 11.5, z: 20, w: 5.6, d: 2.6 },
  { x: -24, z: 15.5, w: 4.4, d: 7 },
  { x: -19.2, z: 15.5, w: 0.6, d: 4.5 },
  { x: -12.7, z: 13.3, w: 0.6, d: 0.6 },
  { x: -13, z: -12, r: 1.2 },
  { x: -4.5, z: -15, r: 0.5 },
  { x: -4, z: 28, r: 0.4 },
  { x: -6.5, z: 12, r: 0.4 },
  { x: 27, z: 11.6, w: 1, d: 0.8 },
  { x: -4.9, z: 13.4, w: 3.4, d: 0.4 },
  ...DETAIL_FOOTPRINTS.map((f) => ({ x: f.x, z: f.z, w: f.w, d: f.d })),
  ...DETAIL_POSTS.map(([x, z]) => ({ x, z, r: 0.4 })),
]

export function buildBase(): Base {
  const group = new THREE.Group()
  const anchors = new Map<string, THREE.Object3D>()
  const hab = habitat()
  group.add(hab)
  const habitatTop = new THREE.Object3D()
  // On the dome's east shoulder, so its tag clears the weather station and the airlock.
  habitatTop.position.set(4.2, 6.2, 1.5)
  hab.add(habitatTop)
  anchors.set('habitat-01', habitatTop)
  const lock = airlock()
  group.add(lock.group)
  anchors.set('airlock-01', lock.door)
  group.add(greenhouse(), garage())
  const solar = solarField()
  group.add(solar.group)
  const bank = batteryBank()
  group.add(bank)
  // The tag sits over the bank itself, not over the bank and its conduit together.
  const bankTop = new THREE.Object3D()
  bankTop.position.set(0, 2.75, 0)
  bank.add(bankTop)
  anchors.set('power-01', bankTop)
  group.add(dock().group)
  const module = lab()
  group.add(module.group)
  anchors.set('lab-01', module.roof)
  group.add(pads())
  group.add(buildDetails())
  const beacon = hab.getObjectByName('beacon') as THREE.Mesh
  let windows: THREE.MeshStandardMaterial | undefined
  hab.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && (mesh.material as THREE.Material).name === 'habitat-windows')
      windows = mesh.material as THREE.MeshStandardMaterial
  })
  bake(group, [beacon, lock.door, bank, module.roof, habitatTop])
  bake(bank)
  // The flag moves, so it stays out of the merged meshes.
  const [fx, fz] = LAYOUT.flag
  const flag = buildFlag(fx, fz)
  const sign = buildSign(fx + 1.6, fz + 1.4, 0.15)
  group.add(flag.group, sign)
  return {
    group,
    anchors,
    door: lock.door,
    windows: windows as THREE.MeshStandardMaterial,
    tiltPanels: solar.tilt,
    update(t) {
      ;(beacon.material as THREE.MeshStandardMaterial).emissiveIntensity = Math.sin(t * 3) > 0.6 ? 8 : 0.2
      flag.update(t)
    },
  }
}
