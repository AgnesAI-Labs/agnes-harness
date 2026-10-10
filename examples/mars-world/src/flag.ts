import * as THREE from 'three'
import { AGNES_MARK } from './agnes-mark.js'
import { bake } from './bake.js'
import { heightAt } from './terrain.js'

/** The deep indigo of the Agnes logo. */
export const AGNES_BLUE = '#3d4194'

const POLE = 9
const WIDTH = 3.6
const HEIGHT = 2.4
const COLS = 24
const ROWS = 14

/** The Agnes mark, white, centred in a box of the canvas. */
export function drawMark(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color = '#ffffff',
): void {
  g.save()
  g.translate(x, y)
  g.scale(size, size)
  g.fillStyle = color
  g.fill(new Path2D(AGNES_MARK), 'evenodd')
  g.restore()
}

/** The flag's face: the logo, the white mark on the indigo field, on a 3:2 cloth. */
function flagTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 1536
  canvas.height = 1024
  const g = canvas.getContext('2d') as CanvasRenderingContext2D
  const [w, h] = [canvas.width, canvas.height]
  g.fillStyle = AGNES_BLUE
  g.fillRect(0, 0, w, h)
  // A little dust settles on everything on Mars, more towards the free edge.
  const dust = g.createLinearGradient(0, 0, w, h)
  dust.addColorStop(0, 'rgba(190, 120, 80, 0)')
  dust.addColorStop(1, 'rgba(190, 120, 80, 0.12)')
  g.fillStyle = dust
  g.fillRect(0, 0, w, h)
  const size = h * 0.8
  drawMark(g, (w - size) / 2, (h - size) / 2, size)
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

/**
 * The Agnes flag on a tall pole, with a crossbar along its top edge so it stays open in the thin
 * air, rippling in the wind with an occasional gust. The cloth is moved on the CPU, a few hundred
 * vertices a frame with normals from the wave's slope, so its shadow follows without a custom depth
 * shader.
 */
export function buildFlag(x: number, z: number, turn = 0): { group: THREE.Group; update(t: number): void } {
  const group = new THREE.Group()
  group.position.set(x, heightAt(x, z), z)
  group.rotation.y = turn
  const metal = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.3, metalness: 0.85 })
  const shadowed = (m: THREE.Mesh) => {
    m.castShadow = true
    m.receiveShadow = true
    return m
  }
  const pole = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, POLE, 12), metal))
  pole.position.y = POLE / 2
  const bar = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, WIDTH + 0.1, 8), metal))
  bar.rotation.z = Math.PI / 2
  bar.position.set((WIDTH + 0.1) / 2, POLE - 0.08, 0)
  const finial = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 10), metal))
  finial.position.y = POLE + 0.06
  const foot = shadowed(
    new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.45, 0.25, 24),
      new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.8 }),
    ),
  )
  foot.position.y = 0.1
  group.add(pole, bar, finial, foot)
  // The pole, crossbar and finial draw as one mesh; only the cloth moves.
  bake(group)

  const geometry = new THREE.PlaneGeometry(WIDTH, HEIGHT, COLS, ROWS)
  // The pole edge at x = 0, the top edge under the crossbar.
  geometry.translate(WIDTH / 2 + 0.06, POLE - 0.1 - HEIGHT / 2, 0)
  const rest = Float32Array.from(geometry.attributes.position?.array ?? [])
  const cloth = shadowed(
    new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        map: flagTexture(),
        roughness: 0.95,
        side: THREE.DoubleSide,
      }),
    ),
  )
  group.add(cloth)

  const position = geometry.attributes.position as THREE.BufferAttribute
  const normal = geometry.attributes.normal as THREE.BufferAttribute
  return {
    group,
    update(t) {
      // Gusts: slow swells of the wind, now and then stronger.
      const swell = 0.5 + 0.5 * Math.sin(t * 0.21) * Math.sin(t * 0.083 + 1.3)
      const gust = Math.max(0, Math.sin(t * 0.37 + 0.6)) ** 6
      const amplitude = 0.05 + 0.1 * swell + 0.12 * gust
      const speed = 2.2 + 2.5 * gust
      for (let i = 0; i < position.count; i++) {
        const px = rest[i * 3] as number
        const py = rest[i * 3 + 1] as number
        // Free to move away from the pole; the top edge is held by the crossbar.
        const u = Math.min(1, px / WIDTH)
        const along = u ** 1.15
        const v = Math.min(1, (POLE - 0.1 - py) / HEIGHT)
        const down = 0.35 + 0.65 * v
        const a = px * 2.6 - t * speed + py * 0.9
        const b = px * 5.3 - t * speed * 1.7
        const wave = Math.sin(a) + 0.35 * Math.sin(b)
        position.setZ(i, amplitude * along * down * wave)
        position.setY(i, py - amplitude * 0.25 * along * down * Math.abs(wave))
        // Normals from the slope of the displacement, cheaper than recomputing them from faces.
        const dx =
          amplitude *
          down *
          ((1.15 * u ** 0.15 * wave) / WIDTH + along * (2.6 * Math.cos(a) + 1.855 * Math.cos(b)))
        const dy = amplitude * along * ((-0.65 / HEIGHT) * wave + down * 0.9 * Math.cos(a))
        const n = 1 / Math.hypot(dx, dy, 1)
        normal.setXYZ(i, -dx * n, -dy * n, n)
      }
      position.needsUpdate = true
      normal.needsUpdate = true
    },
  }
}

/** Text squeezed to a width if the font is wider than expected. */
export function fitText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
): void {
  const measured = g.measureText(text).width
  g.save()
  g.translate(x, y)
  if (measured > width) g.scale(width / measured, 1)
  g.fillText(text, 0, 0)
  g.restore()
}

/** The base's name board: "AGNES BASE" beside the mark, on two posts. */
export function buildSign(x: number, z: number, turn = 0): THREE.Group {
  const group = new THREE.Group()
  group.position.set(x, heightAt(x, z), z)
  group.rotation.y = turn
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const g = canvas.getContext('2d') as CanvasRenderingContext2D
  g.fillStyle = AGNES_BLUE
  g.fillRect(0, 0, 1024, 256)
  g.strokeStyle = 'rgba(255, 255, 255, 0.55)'
  g.lineWidth = 6
  g.strokeRect(14, 14, 996, 228)
  drawMark(g, 40, 34, 188)
  g.fillStyle = '#ffffff'
  g.textBaseline = 'alphabetic'
  g.font = '700 100px "Helvetica Neue", Helvetica, Arial, sans-serif'
  g.letterSpacing = '6px'
  fitText(g, 'AGNES BASE', 262, 146, 720)
  g.font = '500 38px "Helvetica Neue", Helvetica, Arial, sans-serif'
  g.letterSpacing = '7px'
  g.fillStyle = 'rgba(255, 255, 255, 0.8)'
  fitText(g, 'JEZERO CRATER · MARS', 266, 206, 720)
  const face = new THREE.CanvasTexture(canvas)
  face.colorSpace = THREE.SRGBColorSpace
  face.anisotropy = 8
  const W = 3.2
  const H = 0.8
  const frame = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.6, metalness: 0.5 })
  const board = new THREE.Mesh(new THREE.BoxGeometry(W + 0.06, H + 0.06, 0.08), frame)
  board.position.y = 1.15
  const front = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ map: face, roughness: 0.6 }),
  )
  front.position.set(0, 1.15, 0.041)
  for (const m of [board, front]) m.castShadow = m.receiveShadow = true
  group.add(board, front)
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 0.1), frame)
    post.position.set(side * (W / 2 - 0.3), 0.4, -0.02)
    post.castShadow = true
    group.add(post)
  }
  // The frame and posts draw as one mesh, the face as another.
  bake(group)
  return group
}
