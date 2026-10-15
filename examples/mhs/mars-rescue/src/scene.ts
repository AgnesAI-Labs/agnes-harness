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
/** Original procedural geometry; no network, external textures or decoder downloads. */
export class MarsScene {
  private readonly gl: WebGLRenderingContext
  private readonly program: WebGLProgram
  private readonly buffer: WebGLBuffer
  private readonly camera: WebGLUniformLocation | null
  private disposed = false
  private projection: Float32Array | undefined
  view = 0
  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly simulation: MarsSimulation,
  ) {
    const gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true })
    if (!gl) throw new Error('WebGL unavailable; retry on a WebGL-capable browser')
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
      'attribute vec3 p; attribute vec3 c; uniform mat4 camera; varying vec3 color; void main(){gl_Position=camera*vec4(p,1.0);color=c;}',
    )
    const fragment = shader(
      gl.FRAGMENT_SHADER,
      'precision mediump float; varying vec3 color; void main(){gl_FragColor=vec4(color,1.0);}',
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
    for (let x = -90; x < 90; x += 6)
      for (let y = -90; y < 90; y += 6) {
        const point = (dx: number, dy: number) => [x + dx, heightAt(x + dx, y + dy), -(y + dy)]
        const c = [0.5 + 0.06 * Math.sin(x * y), 0.25, 0.15]
        triangle(point(0, 0), point(6, 0), point(6, 6), c)
        triangle(point(0, 0), point(6, 6), point(0, 6), c)
      }
    for (const o of OBSTACLES) box(o.x, -o.y, o.radius * 1.8, o.radius, o.radius * 1.5, colors[3]!)
    for (const [i, id] of DEVICE_IDS.entries()) {
      const p = this.simulation.pose(id),
        moving = id === 'hopper-01' || id === 'rover-01' || id === 'monolith-01' || id === 'suit-01'
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
      camera?.eye ?? [t.x + (wide ? 105 : 24), follow + (wide ? 95 : 22), -t.y + (wide ? 110 : 30)],
      camera?.target ?? [t.x, follow, -t.y],
      this.canvas.width / this.canvas.height,
      camera?.zoom ?? 1,
    )
    gl.uniformMatrix4fv(this.camera, false, this.projection)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW)
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 6)
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
    this.gl.deleteBuffer(this.buffer)
    this.gl.deleteProgram(this.program)
  }
}
