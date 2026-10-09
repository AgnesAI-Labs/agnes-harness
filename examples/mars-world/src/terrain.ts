import * as THREE from 'three'
import { meshOf, model, pbrMaps, seeded } from './assets.js'

/** Half the side of the terrain square, in metres. Beyond it, fog and sky. */
const HALF = 700
/** The base stands on a levelled area of this radius around the origin. */
export const PAD_RADIUS = 34
const SEGMENTS = 400
/** Spreads the terrain grid: under a metre per cell at the base, about 6 m at the horizon. */
const warp = (v: number) => {
  const u = v / HALF
  return HALF * (0.25 * u + 0.75 * u * Math.abs(u))
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function hash(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

function noise(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = x - ix
  const fz = z - iz
  const u = fx * fx * (3 - 2 * fx)
  const v = fz * fz * (3 - 2 * fz)
  const a = hash(ix, iz)
  const b = hash(ix + 1, iz)
  const c = hash(ix, iz + 1)
  const d = hash(ix + 1, iz + 1)
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1
}

function fbm(x: number, z: number, octaves = 5): number {
  let sum = 0
  let amp = 0.5
  let f = 1
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * f, z * f)
    f *= 2.03
    amp *= 0.5
  }
  return sum
}

/** How much of a point is dune sand, 0 to 1: a dune field to the east. */
function duneMask(x: number, z: number): number {
  return smooth(60, 120, x) * smooth(460, 240, Math.abs(z))
}

/** Impact craters around the base: centre, radius of the rim and depth of the bowl, in metres. */
export const CRATERS: { x: number; z: number; r: number; depth: number }[] = [
  { x: 58, z: -48, r: 11, depth: 2.4 },
  { x: -72, z: -36, r: 15, depth: 3 },
  { x: 22, z: -78, r: 7, depth: 1.6 },
  { x: -96, z: -72, r: 9, depth: 2 },
  { x: 96, z: 44, r: 8, depth: 1.6 },
  { x: -30, z: 96, r: 10, depth: 2 },
  { x: 42, z: 98, r: 22, depth: 4.5 },
  { x: -112, z: 28, r: 9, depth: 2 },
  { x: 78, z: -14, r: 4.5, depth: 1 },
  { x: 122, z: -62, r: 13, depth: 2.6 },
  { x: -150, z: 86, r: 19, depth: 4 },
  { x: 160, z: 120, r: 16, depth: 3 },
]

/** Wrinkle ridges: long, low, winding rises, as polylines of [x, z] with a height and a half-width. */
const RIDGES: { points: [number, number][]; height: number; width: number }[] = [
  {
    points: [
      [-190, 10],
      [-120, -40],
      [-70, -95],
      [-10, -128],
      [60, -150],
    ],
    height: 4,
    width: 11,
  },
  {
    points: [
      [70, 150],
      [120, 105],
      [175, 80],
      [240, 30],
    ],
    height: 3.2,
    width: 9,
  },
]

/** Flat-topped buttes with steep, rocky sides: centre, radius and height. */
const BUTTES: { x: number; z: number; r: number; h: number }[] = [
  { x: -128, z: -96, r: 16, h: 9 },
  { x: -168, z: 46, r: 11, h: 6 },
  { x: 150, z: -30, r: 13, h: 7 },
]

function toPolyline(x: number, z: number, points: [number, number][]): number {
  let best = Infinity
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1] as [number, number]
    const [bx, bz] = points[i] as [number, number]
    const dx = bx - ax
    const dz = bz - az
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz))
  }
  return best
}

/** A bowl with a raised rim and a little ejecta beyond it; `d` is the distance over the rim radius. */
function craterShape(d: number, depth: number): number {
  const bowl = d < 1 ? depth * (d * d - 1) : 0
  const rim = 0.35 * depth * Math.exp(-(((d - 1) / 0.28) ** 2))
  const ejecta = d > 1 ? 0.08 * depth * Math.exp(-(d - 1) * 1.5) : 0
  return bowl + rim + ejecta
}

/** Small craters scattered on a 24 m lattice: at most one per cell, decided by a hash. */
function smallCraters(x: number, z: number): number {
  const cell = 24
  const cx = Math.floor(x / cell)
  const cz = Math.floor(z / cell)
  let h = 0
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++) {
      const ix = cx + i
      const iz = cz + j
      if (hash(ix + 91, iz - 37) > 0.38) continue
      const r = 1.5 + 3 * hash(ix - 5, iz + 13) ** 2
      const px = (ix + 0.2 + 0.6 * hash(ix + 3, iz)) * cell
      const pz = (iz + 0.2 + 0.6 * hash(ix, iz + 7)) * cell
      const d = Math.hypot(x - px, z - pz) / r
      if (d < 2.5) h += craterShape(d, r * 0.22)
    }
  return h
}

/**
 * Ground height at (x, z). The base sits on a levelled pad; the rim of Jezero crater rises to the
 * north, with the crater floor beyond it; dunes ripple to the east; wrinkle ridges, buttes and
 * craters of every size break up the plain; low hills close the horizon.
 */
export function heightAt(x: number, z: number): number {
  const r = Math.hypot(x, z)
  let h = 1.4 * fbm(x / 45, z / 45) + 0.3 * fbm(x / 8, z / 8, 3) + 0.12 * fbm(x / 2.2, z / 2.2, 2)
  const d = Math.hypot(x, z + 430)
  h += 34 * Math.exp(-(((d - 330) / 58) ** 2)) * (1 + 0.3 * fbm(x / 70, z / 70, 3))
  h -= 28 * smooth(320, 210, d)
  const wave = (x * 0.8 + z * 0.6) / 7.5 + 1.6 * fbm(x / 55, z / 55, 3)
  h += duneMask(x, z) * 2.2 * Math.abs(Math.sin(wave)) ** 1.7
  h += 26 * fbm(x / 190 + 7, z / 190 + 3, 4) * smooth(170, 460, r)
  for (const ridge of RIDGES) {
    const w = toPolyline(x, z, ridge.points) / ridge.width
    if (w < 3) h += ridge.height * Math.exp(-w * w) * (1 + 0.35 * fbm(x / 20, z / 20, 3))
  }
  for (const b of BUTTES) {
    const k = Math.hypot(x - b.x, z - b.z) / b.r
    if (k < 1.6) h += b.h * smooth(1.25, 0.9, k + 0.12 * fbm(x / 6, z / 6, 2))
  }
  for (const c of CRATERS) {
    const k = Math.hypot(x - c.x, z - c.z) / c.r
    if (k < 3) h += craterShape(k + 0.06 * fbm(x / 5, z / 5, 2), c.depth)
  }
  h += smallCraters(x, z)
  // Level the pad: everything above fades out towards the base, keeping a little roughness.
  const away = smooth(PAD_RADIUS, 80, r)
  return h * away + 0.08 * fbm(x / 6, z / 6, 2) * (1 - away)
}

/** The ground: three Poly Haven textures blended by slope (rock) and dune sand, tinted to Mars. */
export function buildTerrain(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(HALF * 2, HALF * 2, SEGMENTS, SEGMENTS)
  geometry.rotateX(-Math.PI / 2)
  const pos = geometry.attributes.position as THREE.BufferAttribute
  const uv = geometry.attributes.uv as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const x = warp(pos.getX(i))
    const z = warp(pos.getZ(i))
    pos.setXYZ(i, x, heightAt(x, z), z)
    uv.setXY(i, x / (HALF * 2) + 0.5, 0.5 - z / (HALF * 2))
  }
  geometry.computeVertexNormals()
  const normal = geometry.attributes.normal as THREE.BufferAttribute
  const mix = new Float32Array(pos.count * 2)
  const colors = new Float32Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    mix[i * 2] = smooth(0.93, 0.78, normal.getY(i))
    mix[i * 2 + 1] = duneMask(x, z)
    // Large, soft light and dark patches hide the tiling.
    const shade = 0.86 + 0.22 * fbm(x / 30 + 11, z / 30 - 4, 3)
    colors.set([shade, shade * 0.97, shade * 0.94], i * 3)
  }
  geometry.setAttribute('aMix', new THREE.BufferAttribute(mix, 2))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  const repeat: [number, number] = [230, 230]
  const ground = pbrMaps('dry_ground_rocks', repeat)
  const rock = pbrMaps('rock_face', repeat)
  const sand = pbrMaps('sandy_gravel_02', repeat)
  const material = new THREE.MeshStandardMaterial({
    ...ground,
    vertexColors: true,
    color: new THREE.Color(1.0, 0.74, 0.58),
    roughness: 1,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.tRock = { value: rock.map }
    shader.uniforms.tSand = { value: sand.map }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aMix;\nvarying vec2 vMix;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMix = aMix;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D tRock;\nuniform sampler2D tSand;\nvarying vec2 vMix;',
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          // Two scales of the same texture, so its repeat does not show from afar.
          vec4 g = mix(texture2D(map, vMapUv), texture2D(map, vMapUv * 0.21 + 0.37), 0.45);
          vec4 r = texture2D(tRock, vMapUv * 0.45);
          vec4 s = texture2D(tSand, vMapUv * 0.6);
          diffuseColor *= mix(mix(g, s, vMix.y), r, vMix.x);
        #endif`,
      )
  }
  const mesh = new THREE.Mesh(geometry, material)
  mesh.receiveShadow = true
  return mesh
}

/** Something a device can see or must not drive into, in world coordinates (x east, z south). */
export interface Obstacle {
  id: string
  label: 'boulder' | 'unusual rock'
  x: number
  z: number
  /** Radius on the ground, in metres. */
  r: number
  object: THREE.Object3D
}

/** The boulders and the unusual rock of the west field, filled in by buildRocks. */
export const OBSTACLES: Obstacle[] = []

/** The boulder outcrop around the astronaut's worksite, and one more boulder on the way to the unusual rock. */
const BOULDERS: [number, number, number, number][] = [
  [-34.5, 30.5, 3.2, 0.8],
  [-27, 23.5, 1.8, 2.1],
  [-36, 23, 2.3, 4],
  [-41.5, 39, 1.6, 1.2],
]
/** A dark, greenish rock that does not look like the others: the sample the base wants. */
export const UNUSUAL_ROCK = { x: -46, z: 44 } as const

/** A faceted rock: an icosahedron with its corners pushed in and out. */
function lowPolyRock(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1)
  const pos = g.attributes.position as THREE.BufferAttribute
  const p = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i)
    // The same corner gets the same push in every face that shares it.
    const k = 0.75 + 0.5 * hash(Math.round(p.x * 50), Math.round(p.y * 50) + Math.round(p.z * 50) * 7)
    pos.setXYZ(i, p.x * k, p.y * k * 0.8, p.z * k)
  }
  g.computeVertexNormals()
  return g
}

/**
 * A coarse copy of `geometry` by vertex clustering: vertices that fall in the same cell of a grid
 * `cells` across its largest side become one, at their average position and texture coordinate,
 * and triangles that collapse are dropped. Crude up close, fine for a rock 30 m away.
 */
export function clustered(geometry: THREE.BufferGeometry, cells: number): THREE.BufferGeometry {
  geometry.computeBoundingBox()
  const box = geometry.boundingBox as THREE.Box3
  const size = box.getSize(new THREE.Vector3())
  const step = Math.max(size.x, size.y, size.z) / cells
  const pos = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  const cellOf = new Map<string, number>()
  const sums: number[] = []
  const vertex = new Int32Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.floor((pos.getX(i) - box.min.x) / step)},${Math.floor((pos.getY(i) - box.min.y) / step)},${Math.floor((pos.getZ(i) - box.min.z) / step)}`
    let k = cellOf.get(key)
    if (k === undefined) {
      k = cellOf.size
      cellOf.set(key, k)
      sums.push(0, 0, 0, 0, 0, 0)
    }
    vertex[i] = k
    const add = (j: number, v: number) => {
      sums[k * 6 + j] = (sums[k * 6 + j] as number) + v
    }
    add(0, pos.getX(i))
    add(1, pos.getY(i))
    add(2, pos.getZ(i))
    add(3, uv ? uv.getX(i) : 0)
    add(4, uv ? uv.getY(i) : 0)
    add(5, 1)
  }
  const n = cellOf.size
  const positions = new Float32Array(n * 3)
  const uvs = new Float32Array(n * 2)
  for (let k = 0; k < n; k++) {
    const c = sums[k * 6 + 5] as number
    for (let j = 0; j < 3; j++) positions[k * 3 + j] = (sums[k * 6 + j] as number) / c
    uvs[k * 2] = (sums[k * 6 + 3] as number) / c
    uvs[k * 2 + 1] = (sums[k * 6 + 4] as number) / c
  }
  const index: number[] = []
  const corners = geometry.index ?? { count: pos.count, getX: (i: number) => i }
  for (let t = 0; t + 2 < corners.count; t += 3) {
    const a = vertex[corners.getX(t)] as number
    const b = vertex[corners.getX(t + 1)] as number
    const c = vertex[corners.getX(t + 2)] as number
    if (a !== b && b !== c && a !== c) index.push(a, b, c)
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  out.setIndex(index)
  out.computeVertexNormals()
  return out
}

/** Instances of one rock in two levels of detail, chosen per instance for each camera that renders. */
interface RockSet {
  detail: THREE.InstancedMesh
  coarse: THREE.InstancedMesh
  matrices: THREE.Matrix4[]
  centres: THREE.Vector3[]
  radii: number[]
}

/** Rocks closer than this to the camera get the full scanned shape. */
const DETAIL_DISTANCE = 28

export interface Rocks {
  group: THREE.Group
  /**
   * Picks, for `camera`, which scanned rocks to draw and in what detail: those outside its view (with
   * a margin for their shadows) are left out, far ones get the coarse shape. Call before each render.
   */
  pick(camera: THREE.Camera): void
}

/**
 * Rocks of four Poly Haven moon-rock shapes, dusted red, scattered around the base; low-poly rocks
 * further out and on crater rims; pebbles; the boulders and the unusual rock.
 */
export async function buildRocks(avoid: (x: number, z: number) => boolean): Promise<Rocks> {
  const group = new THREE.Group()
  const dust = new THREE.Color(0.86, 0.55, 0.4)
  const random = seeded(7)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()
  const v = new THREE.Vector3()
  const scale = new THREE.Vector3()
  /** Fills `rocks` with instances at the points `where` picks, skipping ground that must stay clear. */
  const scatter = (rocks: THREE.InstancedMesh, where: () => { x: number; z: number; s: number }) => {
    for (let placed = 0; placed < rocks.count; ) {
      const { x, z, s } = where()
      if (avoid(x, z)) continue
      q.setFromEuler(e.set(random() * 0.4, random() * Math.PI * 2, random() * 0.4))
      m.compose(v.set(x, heightAt(x, z) - 0.15 * s, z), q, scale.set(s, s * 0.8, s))
      rocks.setMatrixAt(placed, m)
      placed += 1
    }
    rocks.castShadow = true
    rocks.receiveShadow = true
    group.add(rocks)
  }
  // Scanned rocks (thousands of triangles each) only near the base, where the views get close; each
  // also has a coarse copy of a few hundred triangles for when it is far from the camera.
  const sets: RockSet[] = []
  const near = () => {
    const a = random() * Math.PI * 2
    const r = 10 + random() ** 1.2 * 55
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, s: 0.25 + random() ** 2.5 * 2.6 }
  }
  for (const [n, id] of [
    [40, 'moon_rock_01'],
    [100, 'moon_rock_03'],
    [60, 'moon_rock_05'],
    [80, 'moon_rock_07'],
  ] as [number, string][]) {
    const source = await meshOf(id)
    const material = (source.material as THREE.MeshStandardMaterial).clone()
    material.color = dust
    const detail = new THREE.InstancedMesh(source.geometry, material, n)
    scatter(detail, near)
    const coarse = new THREE.InstancedMesh(clustered(source.geometry, 9), material, n)
    coarse.castShadow = true
    coarse.receiveShadow = true
    group.add(coarse)
    source.geometry.computeBoundingSphere()
    const sphere = source.geometry.boundingSphere as THREE.Sphere
    const set: RockSet = { detail, coarse, matrices: [], centres: [], radii: [] }
    for (let i = 0; i < n; i++) {
      const matrix = new THREE.Matrix4()
      detail.getMatrixAt(i, matrix)
      set.matrices.push(matrix)
      set.centres.push(sphere.center.clone().applyMatrix4(matrix))
      set.radii.push(sphere.radius * matrix.getMaxScaleOnAxis())
    }
    // Culled per instance in pick(), so the meshes as a whole are not.
    detail.frustumCulled = false
    coarse.frustumCulled = false
    sets.push(set)
  }
  // Further out, faceted low-poly rocks of 80 triangles; each crater throws some onto its rim.
  const ejecta: { x: number; z: number; s: number }[] = []
  for (const c of CRATERS)
    for (let i = 0; i < Math.round(c.r * 2.5); i++) {
      const a = random() * Math.PI * 2
      const k = 0.95 + random() ** 2 * 1.2
      ejecta.push({
        x: c.x + Math.cos(a) * c.r * k,
        z: c.z + Math.sin(a) * c.r * k,
        s: 0.3 + random() ** 2 * 1.4,
      })
    }
  const far = () => {
    const rim = ejecta.pop()
    if (rim) return rim
    const a = random() * Math.PI * 2
    const r = 55 + random() ** 1.3 * 170
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, s: 0.2 + random() ** 3 * 1.8 }
  }
  const faceted = new THREE.InstancedMesh(
    lowPolyRock(),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }),
    1100,
  )
  scatter(faceted, far)
  const tint = new THREE.Color()
  for (let i = 0; i < faceted.count; i++)
    faceted.setColorAt(
      i,
      tint.setHSL(
        0.04 + random() * 0.025,
        0.4 + random() * 0.12,
        0.33 + random() * 0.12,
        THREE.SRGBColorSpace,
      ),
    )
  // Pebbles: thousands of small stones in one draw, too small to cast shadows worth drawing.
  const pebbleGeometry = new THREE.IcosahedronGeometry(1, 0)
  const pebbles = new THREE.InstancedMesh(
    pebbleGeometry,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }),
    3000,
  )
  pebbles.receiveShadow = true
  for (let i = 0; i < pebbles.count; ) {
    const a = random() * Math.PI * 2
    const r = 6 + random() ** 1.6 * 110
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    // Clear of the buildings; out in the field, a few may lie where bigger rocks may not.
    if (avoid(x, z) && (r < 40 || random() < 0.85)) continue
    const s = 0.04 + random() ** 3 * 0.22
    q.setFromEuler(e.set(random() * 3, random() * 3, random() * 3))
    m.compose(v.set(x, heightAt(x, z) - 0.3 * s, z), q, scale.set(s, s * (0.5 + random() * 0.4), s * 1.2))
    pebbles.setMatrixAt(i, m)
    pebbles.setColorAt(
      i,
      tint.setHSL(
        0.05 + random() * 0.03,
        0.35 + random() * 0.15,
        0.3 + random() * 0.18,
        THREE.SRGBColorSpace,
      ),
    )
    i += 1
  }
  group.add(pebbles)
  const boulder = await model('namaqualand_boulder_02')
  boulder.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh) {
      const mat = (mesh.material as THREE.MeshStandardMaterial).clone()
      mat.color = new THREE.Color(1, 0.72, 0.6)
      mesh.material = mat
    }
  })
  const size = new THREE.Vector3()
  for (const [i, [x, z, scale, turn]] of BOULDERS.entries()) {
    const rock = boulder.clone()
    rock.scale.setScalar(scale)
    rock.position.set(x, heightAt(x, z) - 0.2, z)
    rock.rotation.y = turn
    group.add(rock)
    new THREE.Box3().setFromObject(rock).getSize(size)
    OBSTACLES.push({
      id: `boulder-${i + 1}`,
      label: 'boulder',
      x,
      z,
      r: Math.max(size.x, size.z) / 2,
      object: rock,
    })
  }
  const unusual = new THREE.Mesh(
    (await meshOf('moon_rock_05')).geometry,
    new THREE.MeshStandardMaterial({ color: 0x3d4a3a, roughness: 0.55, metalness: 0.15 }),
  )
  unusual.scale.set(0.9, 0.7, 0.9)
  const { x, z } = UNUSUAL_ROCK
  unusual.position.set(x, heightAt(x, z) - 0.05, z)
  unusual.castShadow = true
  unusual.receiveShadow = true
  group.add(unusual)
  new THREE.Box3().setFromObject(unusual).getSize(size)
  OBSTACLES.push({
    id: 'rock-1',
    label: 'unusual rock',
    x,
    z,
    r: Math.max(size.x, size.z) / 2,
    object: unusual,
  })
  const frustum = new THREE.Frustum()
  const view = new THREE.Matrix4()
  const sphere = new THREE.Sphere()
  const eye = new THREE.Vector3()
  const pick = (camera: THREE.Camera) => {
    view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    frustum.setFromProjectionMatrix(view)
    camera.getWorldPosition(eye)
    for (const set of sets) {
      let d = 0
      let c = 0
      for (const [i, centre] of set.centres.entries()) {
        sphere.set(centre, (set.radii[i] as number) + 6)
        if (!frustum.intersectsSphere(sphere)) continue
        const matrix = set.matrices[i] as THREE.Matrix4
        if (centre.distanceTo(eye) < DETAIL_DISTANCE) set.detail.setMatrixAt(d++, matrix)
        else set.coarse.setMatrixAt(c++, matrix)
      }
      set.detail.count = d
      set.coarse.count = c
      set.detail.instanceMatrix.needsUpdate = true
      set.coarse.instanceMatrix.needsUpdate = true
    }
  }
  return { group, pick }
}
