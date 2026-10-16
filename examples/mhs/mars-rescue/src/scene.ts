import { loadModels, type ModelName } from './assets.js'
import type { MarsSimulation } from './simulation.js'
import { DEVICE_IDS, heightAt, OBSTACLES, PLACES, type Point } from './world.js'

export const VIEWS = [
  'overview',
  'dock',
  'pad',
  'airlock',
  'field',
  'power',
  'flag',
  'comms',
  'hopper',
  'monolith',
] as const
const colors = [
  [0.8, 0.83, 0.87],
  [0.88, 0.5, 0.24],
  [0.28, 0.45, 0.65],
  [0.23, 0.22, 0.24],
]
function normalize(v: number[]): number[] {
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
}
function cross(a: number[], b: number[]): number[] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
}
function matrix(eye: number[], target: number[], aspect: number, zoom = 1): Float32Array {
  const z = normalize(eye.map((v, i) => v - target[i]!)),
    x = normalize(cross([0, 1, 0], z)),
    y = cross(z, x)
  const dot = (v: number[]) => -v.reduce((s, n, i) => s + n * eye[i]!, 0)
  const view = [
    x[0]!,
    y[0]!,
    z[0]!,
    0,
    x[1]!,
    y[1]!,
    z[1]!,
    0,
    x[2]!,
    y[2]!,
    z[2]!,
    0,
    dot(x),
    dot(y),
    dot(z),
    1,
  ]
  const f = zoom / Math.tan(Math.PI / 7),
    near = 0.1,
    far = 500
  const projection = [
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) / (near - far),
    -1,
    0,
    0,
    (2 * far * near) / (near - far),
    0,
  ]
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r]! += projection[k * 4 + r]! * view[c * 4 + k]!
  return out
}
/** Keep GPU/context failures distinct from missing or invalid packaged scene assets. */
export function sceneFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('asset'))
    return 'Scene assets unavailable. Reload the page or repair the example installation.'
  if (message.includes('context lost'))
    return 'The browser lost its graphics context. Close other 3D views, then retry the scene.'
  if (message.includes('WebGL unavailable'))
    return 'This browser cannot create a WebGL graphics context. Enable hardware acceleration or use a browser with graphics support, then retry.'
  return 'The 3D renderer failed. Retry the scene; if it persists, inspect browser graphics diagnostics.'
}
/** Original procedural geometry; no network, external textures or decoder downloads. */
export class MarsScene {
  private readonly gl: WebGLRenderingContext
  private readonly program: WebGLProgram
  private readonly buffer: WebGLBuffer
  private readonly camera: WebGLUniformLocation | null
  private disposed = false
  private readonly lifetime = new AbortController()
  private readonly models = new Map<ModelName, { buffer: WebGLBuffer; count: number }>()
  private assetError = false
  readonly ready: Promise<void>
  azimuth = 0.8
  elevation = 0.65
  distance = 1
  quality: 'low' | 'high' = 'high'
  time = 12
  ao = true
  bloom = true
  resetView(): void {
    this.azimuth = 0.8
    this.elevation = 0.65
    this.distance = 1
  }
  orbit(dx: number, dy: number): void {
    this.azimuth += dx
    this.elevation = Math.max(0.1, Math.min(1.5, this.elevation + dy))
  }
  zoom(delta: number): void {
    this.distance = Math.max(0.2, Math.min(4, this.distance * Math.exp(delta)))
  }

  private projection: Float32Array | undefined
  view = 0
  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly simulation: MarsSimulation,
  ) {
    const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true })
    if (!gl) throw new Error('WebGL unavailable')
    this.gl = gl
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)
      if (!s) throw new Error('WebGL allocation failed')
      gl.shaderSource(s, source)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        gl.deleteShader(s)
        throw new Error('WebGL shader failed')
      }
      return s
    }
    const vertex = shader(
      gl.VERTEX_SHADER,
      'attribute vec3 p; attribute vec3 c; uniform mat4 camera; uniform mat4 model; varying vec3 color; varying float height; void main(){vec4 world=model*vec4(p,1.0);gl_Position=camera*world;color=c;height=world.y;}',
    )
    const fragment = shader(
      gl.FRAGMENT_SHADER,
      'precision mediump float; varying vec3 color; varying float height; uniform float daylight; uniform float ao; uniform float bloom; void main(){float shade=mix(1.0,0.72+0.28*smoothstep(0.0,4.0,height),ao);vec3 lit=color*daylight*shade;gl_FragColor=vec4(lit+bloom*max(lit-vec3(0.55),vec3(0.0))*0.18,1.0);}',
    )
    const program = gl.createProgram(),
      buffer = gl.createBuffer()
    if (!program || !buffer) throw new Error('WebGL allocation failed')
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program)
      gl.deleteBuffer(buffer)
      throw new Error('WebGL link failed')
    }
    this.program = program
    this.buffer = buffer
    this.camera = gl.getUniformLocation(program, 'camera')
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    for (const [name, offset] of [
      ['p', 0],
      ['c', 12],
    ] as const) {
      const location = gl.getAttribLocation(program, name)
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 24, offset)
    }
    gl.enable(gl.DEPTH_TEST)
    this.ready = loadModels(this.lifetime.signal)
      .then((models) => {
        if (this.disposed) return
        for (const [name, values] of models) {
          const buffer = gl.createBuffer()
          if (!buffer) throw new Error('WebGL model allocation failed')
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
          gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW)
          this.models.set(name, { buffer, count: values.length / 6 })
        }
      })
      .catch((error: unknown) => {
        if (!this.disposed) {
          this.assetError = true
          throw error
        }
      })
    // The owner awaits ready; drawing callers also receive a visible error on the next frame.
    void this.ready.catch(() => {})
  }
  target(): Point {
    if (this.view === 8) return this.simulation.pose('hopper-01')
    if (this.view === 9) return this.simulation.pose('monolith-01')
    return (
      [
        PLACES.habitat,
        PLACES.dock,
        PLACES.pad,
        PLACES.airlock,
        PLACES.field,
        PLACES.power,
        PLACES.airlock,
        PLACES.comms,
      ][this.view] ?? PLACES.habitat
    )
  }
  render(camera?: { eye: number[]; target: number[]; zoom?: number }): void {
    if (this.disposed || this.gl.isContextLost()) throw new Error('WebGL context lost; retry scene')
    if (this.assetError) throw new Error('Offline scene asset unavailable')
    const gl = this.gl,
      vertices: number[] = []
    const triangle = (a: number[], b: number[], c: number[], color: number[]) => {
      for (const p of [a, b, c]) vertices.push(...p, ...color)
    }
    const box = (x: number, z: number, w: number, h: number, d: number, color: number[], altitude = 0) => {
      const floor = heightAt(x, z) + altitude
      const p = [
        [x - w / 2, floor, z - d / 2],
        [x + w / 2, floor, z - d / 2],
        [x + w / 2, floor, z + d / 2],
        [x - w / 2, floor, z + d / 2],
        [x - w / 2, floor + h, z - d / 2],
        [x + w / 2, floor + h, z - d / 2],
        [x + w / 2, floor + h, z + d / 2],
        [x - w / 2, floor + h, z + d / 2],
      ]
      for (const [i, face] of [
        [0, 1, 5, 4],
        [1, 2, 6, 5],
        [2, 3, 7, 6],
        [3, 0, 4, 7],
        [4, 5, 6, 7],
      ].entries()) {
        const shade = color.map((v) => v * (0.6 + i * 0.08))
        triangle(p[face[0]!]!, p[face[1]!]!, p[face[2]!]!, shade)
        triangle(p[face[0]!]!, p[face[2]!]!, p[face[3]!]!, shade)
      }
    }
    const step = this.quality === 'low' ? 12 : 6
    for (let x = -90; x < 90; x += step)
      for (let y = -90; y < 90; y += step) {
        const point = (dx: number, dy: number) => [x + dx, heightAt(x + dx, y + dy), -(y + dy)]
        const c = [0.5 + 0.06 * Math.sin(x * y), 0.25, 0.15]
        triangle(point(0, 0), point(step, 0), point(step, step), c)
        triangle(point(0, 0), point(step, step), point(0, step), c)
      }
    for (const o of OBSTACLES) box(o.x, -o.y, o.radius * 1.8, o.radius, o.radius * 1.5, colors[3]!)
    for (const [i, id] of DEVICE_IDS.entries()) {
      const p = this.simulation.pose(id),
        moving = id === 'hopper-01' || id === 'rover-01' || id === 'monolith-01' || id === 'suit-01'
      if (id !== 'rover-01' && id !== 'suit-01')
        box(p.x, -p.y, moving ? 2 : 5, moving ? 2.4 : 4, moving ? 3 : 5, colors[i % colors.length]!, p.z)
      if (id === 'rover-01')
        for (const side of [-1, 1])
          for (const dy of [-1, 1]) box(p.x + side * 1.2, -p.y + dy, 0.6, 0.8, 0.8, colors[3]!)
      if (id === 'power-01' && this.simulation.state(id).panels === 'deployed')
        for (let k = 0; k < 4; k++) box(p.x + 6 + k * 4, -p.y, 3, 0.5, 8, colors[2]!)
      if (id === 'monolith-01')
        for (let k = 0; k < 4; k++) box(p.x - 1.2 + k * 0.8, -p.y, 0.65, 4, 0.7, colors[0]!)
    }
    box(6, 9, 0.25, 10, 0.25, colors[0]!)
    box(8, 9, 4, 2, 0.2, colors[2]!, 7)
    const t = this.target(),
      follow = this.view === 8 ? this.simulation.pose('hopper-01').z : 0,
      wide = this.view === 0
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0.15, 0.08, 0.07, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.useProgram(this.program)
    this.projection = matrix(
      camera?.eye ?? [
        t.x + Math.cos(this.azimuth) * (wide ? 160 : 40) * this.distance * Math.cos(this.elevation),
        follow + (wide ? 160 : 40) * this.distance * Math.sin(this.elevation),
        -t.y + Math.sin(this.azimuth) * (wide ? 160 : 40) * this.distance * Math.cos(this.elevation),
      ],
      camera?.target ?? [t.x, follow, -t.y],
      this.canvas.width / this.canvas.height,
      camera?.zoom ?? 1,
    )
    gl.uniformMatrix4fv(this.camera, false, this.projection)
    gl.uniform1f(
      gl.getUniformLocation(this.program, 'daylight'),
      0.35 + 0.65 * Math.max(0, Math.cos(((this.time - 12) * Math.PI) / 24)),
    )
    gl.uniform1f(gl.getUniformLocation(this.program, 'ao'), this.ao ? 1 : 0)
    gl.uniform1f(gl.getUniformLocation(this.program, 'bloom'), this.bloom ? 1 : 0)
    const model = gl.getUniformLocation(this.program, 'model')
    gl.uniformMatrix4fv(model, false, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW)
    this.attributes()
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 6)
    const draw = (name: ModelName, x: number, y: number, size: number, altitude = 0, yaw = 0) => {
      const mesh = this.models.get(name)
      if (!mesh) return
      const c = Math.cos(yaw) * size,
        s = Math.sin(yaw) * size
      gl.uniformMatrix4fv(
        model,
        false,
        new Float32Array([c, 0, -s, 0, 0, size, 0, 0, s, 0, c, 0, x, heightAt(x, y) + altitude, -y, 1]),
      )
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer)
      this.attributes()
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count)
    }
    for (const [id, name, size] of [
      ['rover-01', 'rover', 4],
      ['suit-01', 'suit', 2.4],
    ] as const) {
      const p = this.simulation.pose(id)
      draw(name, p.x, p.y, size, p.z, p.yaw)
    }
    const rocks: ModelName[] = [
      'moon_rock_01',
      'moon_rock_03',
      'moon_rock_05',
      'moon_rock_07',
      'namaqualand_boulder_02',
    ]
    OBSTACLES.slice(2).forEach((o, i) => {
      draw(rocks[i % rocks.length]!, o.x, o.y, o.radius * 2)
    })
    draw('namaqualand_boulder_02', PLACES.sample.x, PLACES.sample.y, 3)
  }
  private attributes(): void {
    const gl = this.gl
    for (const [name, offset] of [
      ['p', 0],
      ['c', 12],
    ] as const) {
      const location = gl.getAttribLocation(this.program, name)
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 24, offset)
    }
  }
  project(pose: { x: number; y: number; z: number }): { x: number; y: number } | undefined {
    const m = this.projection
    if (!m) return
    const v = [pose.x, pose.z + 5, -pose.y, 1]
    const row = (r: number) => v.reduce((sum, value, i) => sum + value * m[i * 4 + r]!, 0)
    const w = row(3),
      x = row(0) / w,
      y = row(1) / w
    if (w <= 0 || Math.abs(x) > 1 || Math.abs(y) > 1) return
    return { x: (x + 1) * 480, y: (1 - y) * 270 }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    for (const mesh of this.models.values()) this.gl.deleteBuffer(mesh.buffer)
    this.models.clear()
    this.gl.deleteBuffer(this.buffer)
    this.gl.deleteProgram(this.program)
  }
}
