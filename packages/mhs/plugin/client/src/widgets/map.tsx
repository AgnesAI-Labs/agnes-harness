/**
 * The device map (mhs-ui-design section 8): the device's own `grid` as the floor (a blank metre grid
 * without one), its position and heading by the trust AgnesHub gives it, and the target or route of
 * the job it is running when the arguments carry map coordinates. Tool parameters marked
 * `ui.pick` are chosen by clicking it. Maps follow the panel's theme through its --mhs-map-* tokens.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { mix, type Rgb, rgba, rgbOf } from '../core/color.js'
import { targetsOf } from '../core/describe.js'
import type { Device, Source } from '../core/types.js'
import { t } from '../i18n/i18n.js'
import { useSource, useVisible } from '../react/hooks.js'

type Pt = [number, number]
type GridMeta = { id: string; resolution: number; origin: [number, number] }

export type Pick = { mode: 'map-point' | 'map-pose' | 'map-polygon'; onPick: (value: unknown) => void }

export type MapColors = {
  bg: Rgb
  free: Rgb
  unknown: Rgb
  wall: Rgb
  ink: Rgb
  accent: Rgb
  hud: Rgb
  good: Rgb
  warn: Rgb
  bad: Rgb
}

/** The dark theme's map, until the tokens are read. */
const DARK: MapColors = {
  bg: [5, 7, 10],
  free: [16, 22, 28],
  unknown: [36, 43, 50],
  wall: [180, 196, 210],
  ink: [211, 219, 232],
  accent: [105, 131, 252],
  hud: [141, 152, 179],
  good: [78, 230, 160],
  warn: [255, 181, 71],
  bad: [255, 92, 92],
}

/**
 * A map's colours from the panel's --mhs-map-* tokens on `element`, read again every second so a
 * theme switch shows. Unknown cells lie between free space and walls, closer to free space.
 */
export function useMapColors(element: Element | null): MapColors {
  const [colors, setColors] = useState(DARK)
  useEffect(() => {
    if (!element) return
    const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
    let key = ''
    const read = () => {
      const style = getComputedStyle(element)
      const get = (name: keyof MapColors) =>
        rgbOf(ctx, style.getPropertyValue(`--mhs-map-${name}`).trim() || rgba(DARK[name], 1), DARK[name])
      const free = get('free')
      const wall = get('wall')
      const next: MapColors = {
        bg: get('bg'),
        free,
        unknown: mix(free, wall, 0.12),
        wall,
        ink: get('ink'),
        accent: get('accent'),
        hud: get('hud'),
        good: get('good'),
        warn: get('warn'),
        bad: get('bad'),
      }
      const k = JSON.stringify(next)
      if (k === key) return
      key = k
      setColors(next)
    }
    read()
    const timer = setInterval(read, 1000)
    return () => clearInterval(timer)
  }, [element])
  return colors
}

/** Recolours an 8-bit occupancy PNG (255 free, 0 occupied, 128 unknown) in a map's colours. */
export async function paintGrid(
  bytes: ArrayBuffer,
  colors: { free: Rgb; unknown: Rgb; wall: Rgb },
): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const c = document.createElement('canvas')
  c.width = bitmap.width
  c.height = bitmap.height
  const ctx = c.getContext('2d') as CanvasRenderingContext2D
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const img = ctx.getImageData(0, 0, c.width, c.height)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i] as number
    const [r, g, b] = v > 200 ? colors.free : v < 60 ? colors.wall : colors.unknown
    img.data[i] = r
    img.data[i + 1] = g
    img.data[i + 2] = b
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}

export function MapView(props: { device: Device; pick?: Pick | undefined; compact?: boolean }) {
  const { device } = props
  const gridSource = device.sources.find((s: Source) => s.kind === 'grid')
  const poseSource = device.sources.find((s: Source) => s.kind === 'pose')
  const box = useRef<HTMLDivElement | null>(null)
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null)
  const setBox = useCallback((el: HTMLDivElement | null) => {
    box.current = el
    setBoxEl(el)
  }, [])
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const visible = useVisible(boxEl)
  const colors = useMapColors(boxEl)
  const grid = useSource(device.id, gridSource?.id ?? '', gridSource ? 0.2 : 0, visible && !!gridSource)
  const pose = useSource(
    device.id,
    poseSource?.id ?? '',
    poseSource ? Math.min(poseSource.hz ?? 5, 5) : 0,
    visible && !!poseSource,
  )
  const [floor, setFloor] = useState<{ canvas: HTMLCanvasElement; meta: GridMeta } | null>(null)
  const [width, setWidth] = useState(320)
  const [draft, setDraft] = useState<Pt[]>([])
  const view = useRef<{ cx: number; cy: number; scale: number }>({ cx: 0, cy: 0, scale: 20 })

  useEffect(() => {
    const el = boxEl
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(Math.max(200, Math.min(640, el.clientWidth))))
    observer.observe(el)
    return () => observer.disconnect()
  }, [boxEl])

  useEffect(() => {
    if (!grid?.binary) return
    let live = true
    const meta = grid.item.data as GridMeta
    paintGrid(grid.binary, colors).then(
      (c) => live && setFloor({ canvas: c, meta }),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [grid, colors])

  const livePose = pose?.item.data as { x: number; y: number; yaw: number; ok: boolean } | undefined
  const where = device.position
  const x = livePose?.x ?? where?.x
  const y = livePose?.y ?? where?.y
  const yaw = livePose?.yaw ?? where?.yaw ?? 0
  const trust = where?.trust ?? 'lost'
  const job = (device.jobs ?? [])[0]
  const targets = targetsOf(job?.arguments)
  const height = Math.round(width * (props.compact ? 0.6 : 0.75))

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = rgba(colors.bg, 1)
    ctx.fillRect(0, 0, width, height)
    // The view: the whole grid when there is one, otherwise 16 m around the device.
    if (floor) {
      const { resolution, origin } = floor.meta
      const wM = floor.canvas.width * resolution
      const hM = floor.canvas.height * resolution
      const scale = Math.min(width / wM, height / hM)
      view.current = { cx: origin[0] + wM / 2, cy: origin[1] + hM / 2, scale }
    } else view.current = { cx: x ?? 0, cy: y ?? 0, scale: Math.min(width, height) / 16 }
    const v = view.current
    const toPx = (mx: number, my: number): Pt => [
      width / 2 + (mx - v.cx) * v.scale,
      height / 2 - (my - v.cy) * v.scale,
    ]
    if (floor) {
      const { resolution, origin } = floor.meta
      const [px, py] = toPx(origin[0], origin[1] + floor.canvas.height * resolution)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(
        floor.canvas,
        px,
        py,
        floor.canvas.width * resolution * v.scale,
        floor.canvas.height * resolution * v.scale,
      )
    } else {
      ctx.strokeStyle = rgba(colors.hud, 0.16)
      ctx.lineWidth = 1
      const step = v.scale >= 15 ? 1 : 5
      const x0 = Math.floor(v.cx - width / 2 / v.scale)
      const y0 = Math.floor(v.cy - height / 2 / v.scale)
      for (let gx = x0 - (x0 % step); gx < v.cx + width / 2 / v.scale; gx += step) {
        const [px] = toPx(gx, 0)
        ctx.beginPath()
        ctx.moveTo(px, 0)
        ctx.lineTo(px, height)
        ctx.stroke()
      }
      for (let gy = y0 - (y0 % step); gy < v.cy + height / 2 / v.scale; gy += step) {
        const [, py] = toPx(0, gy)
        ctx.beginPath()
        ctx.moveTo(0, py)
        ctx.lineTo(width, py)
        ctx.stroke()
      }
    }
    // The running job's route and target.
    ctx.strokeStyle = rgba(colors.accent, 1)
    ctx.fillStyle = rgba(colors.accent, 1)
    ctx.lineWidth = 2
    if (targets.route) {
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      targets.route.forEach(([rx, ry], i) => {
        const [px, py] = toPx(rx, ry)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.stroke()
      ctx.setLineDash([])
    }
    if (targets.point) {
      const [px, py] = toPx(...targets.point)
      ctx.beginPath()
      ctx.arc(px, py, 6, 0, Math.PI * 2)
      ctx.stroke()
    }
    // A pick in progress.
    ctx.strokeStyle = rgba(colors.warn, 1)
    ctx.fillStyle = rgba(colors.warn, 1)
    draft.forEach(([dx, dy], i) => {
      const [px, py] = toPx(dx, dy)
      ctx.beginPath()
      ctx.arc(px, py, 4, 0, Math.PI * 2)
      ctx.fill()
      if (i > 0) {
        const [qx, qy] = toPx(...(draft[i - 1] as Pt))
        ctx.beginPath()
        ctx.moveTo(qx, qy)
        ctx.lineTo(px, py)
        ctx.stroke()
      }
    })
    // The device.
    if (x !== undefined && y !== undefined) {
      const [px, py] = toPx(x, y)
      const a = (-yaw * Math.PI) / 180
      const size = 9
      ctx.save()
      ctx.translate(px, py)
      ctx.rotate(a)
      ctx.beginPath()
      ctx.moveTo(size, 0)
      ctx.lineTo(-size * 0.7, size * 0.6)
      ctx.lineTo(-size * 0.7, -size * 0.6)
      ctx.closePath()
      const color = rgba(
        trust === 'trusted' ? colors.good : trust === 'uncertain' ? colors.warn : colors.hud,
        1,
      )
      ctx.strokeStyle = color
      ctx.fillStyle = trust === 'trusted' ? color : 'transparent'
      if (trust === 'uncertain') ctx.setLineDash([3, 2])
      ctx.lineWidth = 2
      ctx.fill()
      ctx.stroke()
      ctx.restore()
      if (trust !== 'trusted') {
        ctx.fillStyle = color
        ctx.font = '12px ui-monospace, monospace'
        ctx.fillText(trust === 'uncertain' ? '?' : '×', px + 10, py - 8)
      }
    }
  }, [
    width,
    height,
    floor,
    x,
    y,
    yaw,
    trust,
    targets.point?.[0],
    targets.point?.[1],
    targets.route?.length,
    draft,
    colors,
  ])

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pick = props.pick
    if (!pick) return
    const rect = e.currentTarget.getBoundingClientRect()
    const v = view.current
    const mx = Math.round((v.cx + (e.clientX - rect.left - width / 2) / v.scale) * 100) / 100
    const my = Math.round((v.cy - (e.clientY - rect.top - height / 2) / v.scale) * 100) / 100
    if (pick.mode === 'map-point') pick.onPick({ x: mx, y: my })
    else if (pick.mode === 'map-pose') {
      if (draft.length === 0) setDraft([[mx, my]])
      else {
        const [sx, sy] = draft[0] as Pt
        const heading = Math.round((Math.atan2(my - sy, mx - sx) * 180) / Math.PI)
        setDraft([])
        pick.onPick({ x: sx, y: sy, yaw: heading })
      }
    } else setDraft([...draft, [mx, my]])
  }

  return (
    <div className="mhs-map" ref={setBox}>
      <canvas
        ref={canvas}
        style={{ width, height, cursor: props.pick ? 'crosshair' : 'default' }}
        onClick={onClick}
        onDoubleClick={() => {
          if (props.pick?.mode === 'map-polygon' && draft.length >= 3) {
            props.pick.onPick(draft.map(([px, py]) => [px, py]))
            setDraft([])
          }
        }}
      />
      {!floor && x === undefined && <div className="mhs-map-note mhs-note">{t('data.map.empty')}</div>}
      {props.pick && <div className="mhs-map-note mhs-note">{t('tool.picking')}</div>}
    </div>
  )
}
