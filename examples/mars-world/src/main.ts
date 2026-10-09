import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { coveredTextures } from './assets.js'
import { buildBase, LAYOUT } from './base.js'
import { DETAIL_AREAS } from './details.js'
import { buildDevices, DEVICES } from './devices.js'
import { connectDevices } from './live/index.js'
import { buildMinimap } from './minimap.js'
import { applyShot, SHOTS } from './shots.js'
import { buildSky, lightAt, sunElevation, type TimeOfDay } from './sky.js'
import { buildRocks, buildTerrain, PAD_RADIUS } from './terrain.js'

const params = new URLSearchParams(location.search)
const app = document.getElementById('app') as HTMLElement

// ?quality=high renders at the full Retina resolution with ambient occlusion; balanced (the default)
// caps the pixel ratio and leaves ambient occlusion out, which costs a quarter of the GPU's frame
// for shading that is hard to see at these distances; low renders at one pixel per CSS pixel.
const QUALITY = params.get('quality') ?? 'balanced'
const PIXEL_RATIO =
  QUALITY === 'high'
    ? Math.min(devicePixelRatio, 2)
    : QUALITY === 'low'
      ? 1
      : Math.min(devicePixelRatio, 1.25)
const TIME = (
  ['morning', 'noon', 'sunset'].includes(params.get('time') ?? '') ? params.get('time') : 'morning'
) as TimeOfDay

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: params.has('shot'),
})
renderer.setPixelRatio(PIXEL_RATIO)
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.AgXToneMapping
renderer.toneMappingExposure = 1.0
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
// Nothing large moves yet, so the sun's shadow map is redrawn three times a second, not every frame.
renderer.shadowMap.autoUpdate = false
app.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 4000)

// Sky, sunlight, and the dusty air that softens everything in the distance.
const light = lightAt(TIME)
const sky = buildSky(light)
scene.add(sky)
const skyScene = new THREE.Scene()
skyScene.add(buildSky(light))
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(skyScene, 0.02).texture
scene.environmentIntensity = 0.35 + 0.25 * light.day
scene.fog = new THREE.FogExp2(light.horizon.clone().multiplyScalar(0.95), 0.0032 - 0.0012 * light.day)
const sun = new THREE.DirectionalLight(
  new THREE.Color(1, 0.9, 0.8).lerp(new THREE.Color(1, 0.62, 0.42), 1 - light.day),
  1.4 + 3.4 * light.day,
)
sun.position.copy(light.sun).multiplyScalar(120)
sun.castShadow = true
sun.shadow.mapSize.setScalar(QUALITY === 'high' ? 4096 : 2048)
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 10, far: 320 })
sun.shadow.bias = -0.0004
sun.shadow.normalBias = 0.04
scene.add(sun, sun.target)
scene.add(new THREE.HemisphereLight(light.horizon, new THREE.Color(0.22, 0.1, 0.06), 0.25 + 0.15 * light.day))

const status = document.getElementById('status') as HTMLElement
scene.add(buildTerrain())
const base = buildBase()
scene.add(base.group)
const devices = await buildDevices(base)
scene.add(devices.group)
const keepClear = (x: number, z: number) =>
  Math.hypot(x, z) < 13 ||
  (Math.abs(x - 18.5) < 11 && Math.abs(z + 2) < 6) ||
  (x > -28 && x < -10 && z > -6 && z < 22) ||
  Math.hypot(x - LAYOUT.camBase[0], z - LAYOUT.camBase[1]) < 2 ||
  Math.hypot(x - LAYOUT.flag[0], z - LAYOUT.flag[1]) < 4 ||
  Math.hypot(x - LAYOUT.field[0], z - LAYOUT.field[1]) < 2.5 ||
  (x > 8 && x < 36 && z > 10 && z < 30) ||
  Math.hypot(x - 6, z - 42) < 13 ||
  Math.hypot(x, z) < PAD_RADIUS * 0.5 ||
  Math.hypot(x + 9, z + 13.5) < 8 ||
  DETAIL_AREAS.some((a) => Math.hypot(x - a.x, z - a.z) < a.r) ||
  // The west field stays clear for the rover's and the hopper's work there.
  (x > -54 && x < -12 && z > 14 && z < 54)
const rocks = await buildRocks(keepClear)
scene.add(rocks.group)
// Every render, the main view's and each device camera's, picks the rocks that camera needs.
scene.onBeforeRender = (_renderer, _scene, view) => rocks.pick(view)

// Post-processing: ambient occlusion, bloom on lamps and beacons, a soft vignette, then tone mapping.
const composer = new EffectComposer(renderer)
composer.addPass(new RenderPass(scene, camera))
// ?ao=1 or ?ao=0 overrides what the quality level picks.
if (params.get('ao') === '1' || (QUALITY === 'high' && params.get('ao') !== '0')) {
  const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight)
  gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1, scale: 1.0 })
  composer.addPass(gtao)
}
if (params.get('bloom') !== '0')
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.3, 0.45, 0.92))
composer.addPass(
  new ShaderPass({
    uniforms: { tDiffuse: { value: null }, strength: { value: 0.28 } },
    vertexShader:
      'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv;
      void main() { vec4 c = texture2D(tDiffuse, vUv); float d = distance(vUv, vec2(0.5)); c.rgb *= 1.0 - strength * smoothstep(0.4, 0.9, d); gl_FragColor = c; }`,
  }),
)
composer.addPass(new OutputPass())

// Fixed viewpoints: keys 1–9 and 0, or ?shot=<name>.
let shot = applyShot(camera, params.get('shot') ?? 'overview')
const shotLabel = () => SHOTS.find((s) => s.name === shot)?.label ?? ''

// Name tags over the devices.
const tags = document.getElementById('tags') as HTMLElement
const tagEls = DEVICES.map((d) => {
  const el = document.createElement('div')
  el.className = 'tag'
  el.innerHTML = `<b>${d.name}</b><span>${d.id}</span>`
  tags.appendChild(el)
  return { el, anchor: devices.anchors.get(d.id) as THREE.Object3D, top: new THREE.Vector3() }
})
tags.hidden = params.get('tags') === '0'
// What Monolith says over the radio, in a bubble over it while it speaks.
const speech = document.createElement('div')
speech.className = 'speech'
speech.hidden = true
tags.appendChild(speech)
const mouth = new THREE.Vector3()
// The minimap in the top-right corner; M toggles it.
const minimap = buildMinimap(devices.anchors, camera)
minimap.hidden = params.get('minimap') === '0'
document.body.appendChild(minimap)
addEventListener('keydown', (e) => {
  if (e.key === 'l') tags.hidden = !tags.hidden
  const n = e.key === '0' ? 10 : Number(e.key)
  const next = SHOTS[n - 1]
  if (n >= 1 && next) shot = applyShot(camera, next.name)
})
const v = new THREE.Vector3()
const box = new THREE.Box3()
// The follow view keeps behind and above the device it follows, easing after it as it turns.
const eye = new THREE.Vector3()
const aim = new THREE.Vector3()
const ahead = new THREE.Vector3()
let following: THREE.Object3D | undefined
function follow(dt: number) {
  const name = SHOTS.find((s) => s.name === shot)?.follow
  const target = name ? devices.anchors.get(name) : undefined
  if (!target) {
    following = undefined
    return
  }
  const h = target.rotation.y
  const p = target.position
  const [back, up, round = 0] = SHOTS.find((s) => s.name === shot)?.behind ?? [10, 5]
  eye.set(p.x - Math.sin(h + round) * back, p.y + up, p.z - Math.cos(h + round) * back)
  const lead = round ? 1 : 4
  aim.set(p.x + Math.sin(h) * lead, p.y + 0.5, p.z + Math.cos(h) * lead)
  // A view just switched to jumps there; after that it eases.
  const k = following === target ? Math.min(1, dt * 2.5) : 1
  following = target
  camera.position.lerp(eye, k)
  ahead.copy(camera.position).add(camera.getWorldDirection(v).multiplyScalar(10))
  camera.lookAt(ahead.lerp(aim, k))
}
function placeSpeech() {
  const { monolith } = devices.parts
  const { text, until } = monolith.speech
  speech.hidden = tags.hidden || performance.now() > until
  if (speech.hidden) return
  if (speech.textContent !== text) speech.textContent = text
  mouth.copy(monolith.group.position)
  mouth.y += 2.1
  mouth.project(camera)
  speech.hidden = mouth.z > 1
  speech.style.transform = `translate(${((mouth.x + 1) / 2) * innerWidth}px, ${((1 - mouth.y) / 2) * innerHeight}px) translate(-50%, -100%)`
}
function placeTags() {
  if (tags.hidden) return
  const shown = SHOTS.find((s) => s.name === shot)?.devices
  for (const [i, { el, anchor, top }] of tagEls.entries()) {
    if (shown && !shown.includes((DEVICES[i] as { id: string }).id)) {
      el.style.display = 'none'
      continue
    }
    // Measuring a model walks all its parts, so where a tag sits is refreshed twice a second.
    if (frames % 15 === 0) {
      // An anchor without meshes (a point on a building) marks the spot itself.
      if (box.setFromObject(anchor).isEmpty()) anchor.getWorldPosition(top)
      else {
        box.getCenter(top)
        top.y = box.max.y + 0.15
      }
    }
    v.copy(top).project(camera)
    const visible = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05
    el.style.display = visible ? '' : 'none'
    el.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
  composer.setSize(innerWidth, innerHeight)
})

// Nothing here moves fast, so frames are capped at 30 a second by default; ?fps=60 lifts the cap.
const FPS = Number(params.get('fps')) || 30
const clock = new THREE.Clock()
let frames = 0
let last = 0
let lastT = 0
let fpsFrames = 0
let fpsSince = performance.now()
const hint = () =>
  `${shotLabel()} · keys 1–9, 0 views · L tags · M map${params.has('hub') ? ' · R reset' : ''} · ${TIME}`
status.textContent = hint()
// ?stats adds the draw calls, triangles and JavaScript time of an average frame to the status line
// (averaged, since every tenth frame also redraws the shadow map).
const STATS = params.has('stats')
let cpu = 0
let draws = 0
let triangles = 0
renderer.info.autoReset = false
renderer.setAnimationLoop(() => {
  const start = performance.now()
  if (start - last < 1000 / FPS - 4) return
  last = start
  renderer.info.reset()
  const t = clock.getElapsedTime()
  const dt = t - lastT
  lastT = t
  if (frames % 10 === 0) renderer.shadowMap.needsUpdate = true
  base.update(t)
  devices.update(t)
  follow(dt)
  sky.position.copy(camera.position)
  composer.render()
  placeTags()
  placeSpeech()
  cpu += performance.now() - start
  draws += renderer.info.render.calls
  triangles += renderer.info.render.triangles
  frames += 1
  fpsFrames += 1
  const now = performance.now()
  if (now - fpsSince > 1000) {
    const stats = STATS
      ? ` · ${Math.round(draws / fpsFrames)} draws · ${(triangles / fpsFrames / 1e6).toFixed(1)} M tris · ${(cpu / fpsFrames).toFixed(1)} ms js/frame`
      : ''
    status.textContent = `${hint()} · ${Math.round((fpsFrames * 1000) / (now - fpsSince))} fps (${QUALITY})${stats}`
    cpu = 0
    draws = 0
    triangles = 0
    fpsFrames = 0
    fpsSince = now
  }
  // Screenshots wait for this marker: a few frames after everything has loaded.
  if (frames === 30) {
    document.body.dataset.ready = '1'
    document.body.dataset.covered = coveredTextures.join(',')
  }
})
const hub = params.get('hub')
const live = hub
  ? connectDevices(
      hub,
      renderer,
      scene,
      devices.parts,
      sky,
      sunElevation(TIME),
      (line) => console.log(line),
      params.get('devices')?.split(','),
    )
  : undefined
// Reset (the button, or R): every device back to how the page started it, without reloading, so
// the devices stay connected to the hub. A demo control of the page, not part of any device.
const resetButton = document.getElementById('reset') as HTMLButtonElement
resetButton.hidden = !live
let resetting = false
const reset = async () => {
  if (!live || resetting) return
  resetting = true
  resetButton.disabled = true
  await live.reset()
  resetButton.disabled = false
  resetting = false
}
resetButton.addEventListener('click', () => void reset())
addEventListener('keydown', (e) => {
  if (e.key === 'r') void reset()
})
