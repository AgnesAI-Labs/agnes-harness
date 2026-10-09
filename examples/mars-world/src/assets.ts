import * as THREE from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { bake } from './bake.js'

/** Where tools/fetch-assets.mjs puts the files listed in assets/manifest.json. */
const CACHE = 'assets/cache'

// NASA's models are Draco-compressed; tools/draco.mjs copies the decoder next to the bundle.
const gltfLoader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath('dist/draco/'))
const textureLoader = new THREE.TextureLoader()
const scenes = new Map<string, Promise<THREE.Group>>()

function shadows(root: THREE.Object3D): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true
      o.receiveShadow = true
    }
  })
}

/** A Poly Haven model by id, with shadows on; every call returns a fresh clone. */
export async function model(id: string): Promise<THREE.Group> {
  let loading = scenes.get(id)
  if (!loading) {
    loading = gltfLoader.loadAsync(`${CACHE}/models/${id}/${id}.gltf`).then((gltf) => {
      shadows(gltf.scene)
      bake(gltf.scene)
      return gltf.scene
    })
    scenes.set(id, loading)
  }
  return (await loading).clone()
}

/** The first mesh of a Poly Haven model, for instancing many copies of it. */
export async function meshOf(id: string): Promise<THREE.Mesh> {
  let mesh: THREE.Mesh | undefined
  ;(await model(id)).traverse((o) => {
    if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh
  })
  if (!mesh) throw new Error(`${id} has no mesh`)
  return mesh
}

/**
 * Rectangles to paint over in NASA textures, as fractions of the image: x0, y0, x1, y1, and the
 * point whose color fills them. NASA's media usage guidelines do not allow its insignia to be
 * reused, so the NASA, JPL and mission marks, flags and patches are covered when a model loads.
 */
const COVERS: Record<string, [number, number, number, number, number, number][]> = {
  arm_graphics: [
    [0, 0, 1, 0.45, 0.02, 0.47],
    [0.18, 0.52, 0.6, 0.69, 0.08, 0.6],
  ],
  blade: [
    [0, 0.32, 0.18, 0.54, 0.005, 0.33],
    [0.86, 0.45, 1, 1, 0.995, 0.47],
  ],
  mars_2020_03: [
    [0.175, 0.866, 0.282, 0.915, 0.17, 0.89],
    [0.378, 0.828, 0.468, 0.872, 0.372, 0.85],
  ],
  // The Mark III suit's chest decal is the NASA insignia alone; it becomes plain suit fabric.
  texturelogo: [[0, 0, 1, 1, 0.02, 0.02]],
}

/** Names of the textures that were covered, for the check in tools/screenshot.mjs. */
export const coveredTextures: string[] = []

function covered(texture: THREE.Texture): THREE.Texture {
  const key = Object.keys(COVERS).find((k) => texture.name === k || texture.name.startsWith(`${k}.`))
  const image = texture.image as CanvasImageSource & { width: number; height: number }
  if (!key || !image?.width) return texture
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const g = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
  g.drawImage(image, 0, 0)
  const { width: w, height: h } = canvas
  for (const [x0, y0, x1, y1, sx, sy] of COVERS[key] ?? []) {
    const [r, gr, b] = g.getImageData(Math.min(w - 1, sx * w), Math.min(h - 1, sy * h), 1, 1).data
    g.fillStyle = `rgb(${r}, ${gr}, ${b})`
    g.fillRect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h)
  }
  coveredTextures.push(texture.name)
  const result = texture.clone()
  result.image = canvas
  result.needsUpdate = true
  return result
}

const nasa = new Map<string, Promise<THREE.Group>>()

/** A NASA model by id (nasa/<id>.glb), insignia covered, scaled so its largest side is `size` m. */
export async function nasaModel(id: string, size: number): Promise<THREE.Group> {
  let loading = nasa.get(id)
  if (!loading) {
    loading = gltfLoader.loadAsync(`${CACHE}/nasa/${id}.glb`).then((gltf) => {
      const done = new Map<THREE.Texture, THREE.Texture>()
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of materials as THREE.MeshPhysicalMaterial[]) {
          // Transmission makes the renderer draw every opaque object a second time, into a target
          // the refraction samples, in every view and every device camera, every frame. These
          // models only use it for glass and, by an export slip, for the suit's fabric and steel:
          // glass becomes plainly see-through, everything else opaque.
          if (m.transmission > 0) {
            m.transmission = 0
            if (/glass/i.test(m.name)) {
              m.transparent = true
              m.opacity = 0.35
            }
          }
          if (!m.map) continue
          let map = done.get(m.map)
          if (!map) {
            map = covered(m.map)
            done.set(m.map, map)
          }
          m.map = map
        }
      })
      shadows(gltf.scene)
      bake(gltf.scene)
      return gltf.scene
    })
    nasa.set(id, loading)
  }
  const root = (await loading).clone()
  const dims = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3())
  root.scale.setScalar(size / Math.max(dims.x, dims.y, dims.z))
  // Stand it on the ground, centred on its own origin.
  const box = new THREE.Box3().setFromObject(root)
  const centre = box.getCenter(new THREE.Vector3())
  root.position.set(-centre.x, -box.min.y, -centre.z)
  const holder = new THREE.Group()
  holder.add(root)
  return holder
}

/** A Poly Haven PBR texture set (color, normal, roughness), tiled `repeat` times. */
export function pbrMaps(id: string, repeat: [number, number]) {
  const load = (map: string, color: boolean) => {
    const t = textureLoader.load(`${CACHE}/textures/${id}/${map}.jpg`)
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    t.repeat.set(...repeat)
    t.anisotropy = 8
    if (color) t.colorSpace = THREE.SRGBColorSpace
    return t
  }
  return { map: load('diff', true), normalMap: load('nor', false), roughnessMap: load('rough', false) }
}

/** A material from a Poly Haven PBR texture set. */
export function pbr(
  id: string,
  repeat: [number, number],
  options: THREE.MeshStandardMaterialParameters = {},
) {
  return new THREE.MeshStandardMaterial({ ...pbrMaps(id, repeat), ...options })
}

/** A texture drawn on a canvas, for patterns no asset provides (panel seams, markings, solar cells). */
export function canvasTexture(
  size: number,
  draw: (g: CanvasRenderingContext2D, size: number) => void,
  color = true,
) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d') as CanvasRenderingContext2D
  draw(g, size)
  const t = new THREE.CanvasTexture(canvas)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  if (color) t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

/** Deterministic random numbers, so the scene looks the same on every load. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
