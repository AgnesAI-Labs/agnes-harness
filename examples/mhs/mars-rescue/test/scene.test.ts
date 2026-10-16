// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'

const assets = vi.hoisted(() => ({ failed: false }))
vi.mock('../src/assets.js', () => ({
  loadModels: async () => {
    if (assets.failed) throw new Error('model-asset-unavailable')
    return new Map([['rover', new Float32Array([0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1])]])
  },
}))

import { MarsScene, sceneFailure, VIEWS } from '../src/scene.js'
import { MarsSimulation } from '../src/simulation.js'

it('renders every view with bounded orbit/zoom and lighting options, then releases GPU models', async () => {
  const matrices: Float32Array[] = [],
    options: Record<string, number> = {},
    removed: unknown[] = []
  let draws = 0
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    FLOAT: 6,
    DEPTH_TEST: 7,
    COLOR_BUFFER_BIT: 8,
    DEPTH_BUFFER_BIT: 16,
    STATIC_DRAW: 17,
    DYNAMIC_DRAW: 18,
    TRIANGLES: 19,
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    deleteShader() {},
    createProgram: () => ({}),
    createBuffer: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    deleteProgram(v: unknown) {
      removed.push(v)
    },
    deleteBuffer(v: unknown) {
      removed.push(v)
    },
    getUniformLocation: (_p: unknown, name: string) => name,
    useProgram() {},
    bindBuffer() {},
    getAttribLocation: () => 0,
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    enable() {},
    bufferData() {},
    isContextLost: () => false,
    viewport() {},
    clearColor() {},
    clear() {},
    uniformMatrix4fv(name: string, _transpose: boolean, value: Float32Array) {
      if (name === 'camera') matrices.push(value.slice())
    },
    uniform1f(name: string, value: number) {
      options[name] = value
    },
    drawArrays() {
      draws++
    },
  }
  const sim = new MarsSimulation()
  const unavailable = { getContext: () => null } as unknown as HTMLCanvasElement
  expect(() => new MarsScene(unavailable, sim)).toThrow('WebGL unavailable')
  expect(sceneFailure(new Error('WebGL unavailable'))).toContain('hardware acceleration')
  expect(sceneFailure(new Error('Offline scene asset unavailable'))).toContain(
    'repair the example installation',
  )
  expect(sceneFailure(new Error('WebGL context lost'))).toContain('Close other 3D views')
  const canvas = { width: 960, height: 540, getContext: () => gl } as unknown as HTMLCanvasElement
  const scene = new MarsScene(canvas, sim)
  await scene.ready
  for (let i = 0; i < VIEWS.length; i++) {
    scene.view = i
    scene.render()
  }
  expect(draws).toBeGreaterThanOrEqual(VIEWS.length * 2)
  scene.view = 0
  scene.resetView()
  scene.render()
  const initial = matrices.at(-1)
  scene.orbit(0.5, 0.2)
  scene.zoom(-0.3)
  scene.render()
  expect(matrices.at(-1)).not.toEqual(initial)
  scene.resetView()
  scene.render()
  expect(matrices.at(-1)).toEqual(initial)
  scene.quality = 'low'
  scene.time = 0
  scene.ao = false
  scene.bloom = false
  scene.render()
  expect(options).toMatchObject({ ao: 0, bloom: 0 })
  expect(options.daylight).toBeLessThan(1)
  scene.zoom(100)
  expect(scene.distance).toBe(4)
  scene.zoom(-100)
  expect(scene.distance).toBe(0.2)
  scene.dispose()
  const count = removed.length
  scene.dispose()
  expect(removed).toHaveLength(count)
  expect(count).toBe(3)
  expect(() => scene.render()).toThrow('context lost')
  assets.failed = true
  const failedScene = new MarsScene(canvas, sim)
  try {
    await expect(failedScene.ready).rejects.toThrow('model-asset-unavailable')
    expect(() => failedScene.render()).toThrow('Offline scene asset unavailable')
  } finally {
    failedScene.dispose()
    assets.failed = false
  }
  await sim.stop()
})
