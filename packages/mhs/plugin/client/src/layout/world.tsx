/**
 * The world view: every map AgnesHub knows (hub-api.md 4.4), each in the panel's theme like the
 * device map. The floor is the occupancy grid of a device on that map when one has a `grid` source, the
 * zones are outlined areas, the landmarks labelled pins, and every device on the map a marker with
 * its name and heading: a triangle for a device that moves, a square for an installed one. A device
 * that is offline or not available stays faded at its last known position. Clicking a device opens
 * its page.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { mix, rgba } from '../core/color.js'
import { devicesOn, displayName, tone, worldExtent, worldMaps } from '../core/describe.js'
import type { Device, Place, Source, World } from '../core/types.js'
import { t } from '../i18n/i18n.js'
import { useDevices, useLocale, useNav, useSource, useVisible, useWorlds } from '../react/hooks.js'
import { paintGrid, useMapColors } from '../widgets/map.js'

type Pt = [number, number]
type GridMeta = { id: string; resolution: number; origin: Pt }

/** Walls drawn quieter than on the device map, so zones and markers stay in front. */
const WALL_WEIGHT = 0.45
const MIN_H = 220
const MAX_H = 560

export function WorldView() {
  useLocale()
  const worlds = useWorlds()
  const devices = useDevices()
  const maps = worldMaps(worlds, devices)
  if (maps.length === 0)
    return (
      <div className="mhs-empty">
        <p>{t('world.empty')}</p>
        <p className="mhs-dim">{t('world.empty.hint')}</p>
      </div>
    )
  return (
    <div className="mhs-world">
      {maps.map((w) => (
        <WorldMap key={w.map} world={w} devices={devices} />
      ))}
    </div>
  )
}

/** The device whose `grid` source draws this map's floor: one on the map first, then any. */
function gridOwner(map: string, devices: Device[]): { device: Device; source: Source } | undefined {
  const withGrid = (d: Device) => d.sources.find((s) => s.kind === 'grid')
  const owner = devicesOn(map, devices).find(withGrid) ?? devices.find((d) => d.available && withGrid(d))
  const source = owner && withGrid(owner)
  return owner && source ? { device: owner, source } : undefined
}

function WorldMap(props: { world: World; devices: Device[] }) {
  const { world, devices } = props
  const nav = useNav()
  const [box, setBoxEl] = useState<HTMLDivElement | null>(null)
  const setBox = useCallback((el: HTMLDivElement | null) => setBoxEl(el), [])
  const visible = useVisible(box)
  const colors = useMapColors(box)
  const [width, setWidth] = useState(320)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const owner = gridOwner(world.map, devices)
  const grid = useSource(owner?.device.id ?? '', owner?.source.id ?? '', owner ? 0.2 : 0, visible && !!owner)
  const [floor, setFloor] = useState<{ canvas: HTMLCanvasElement; meta: GridMeta } | null>(null)

  useEffect(() => {
    if (!box) return
    const observer = new ResizeObserver(() => setWidth(Math.max(200, box.clientWidth)))
    observer.observe(box)
    return () => observer.disconnect()
  }, [box])

  useEffect(() => {
    const meta = grid?.item.data as GridMeta | undefined
    // A grid of another map (a device that moved on) is not this map's floor.
    if (!grid?.binary || meta?.id !== world.map) return
    let live = true
    paintGrid(grid.binary, { ...colors, wall: mix(colors.free, colors.wall, WALL_WEIGHT) }).then(
      (c) => live && setFloor({ canvas: c, meta }),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [grid, world.map, colors])

  const on = devicesOn(world.map, devices)
  const corners: Pt[] = floor
    ? [
        floor.meta.origin,
        [
          floor.meta.origin[0] + floor.canvas.width * floor.meta.resolution,
          floor.meta.origin[1] + floor.canvas.height * floor.meta.resolution,
        ],
      ]
    : []
  const [x0, y0, x1, y1] = worldExtent(world, devices, corners)
  const height = Math.round(Math.max(MIN_H, Math.min(MAX_H, (width * (y1 - y0)) / (x1 - x0))))
  const scale = Math.min(width / (x1 - x0), height / (y1 - y0))
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const px = (x: number, y: number): Pt => [width / 2 + (x - cx) * scale, height / 2 - (y - cy) * scale]

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const toPx = (x: number, y: number): Pt => [width / 2 + (x - cx) * scale, height / 2 - (y - cy) * scale]
    if (floor) {
      const { resolution, origin } = floor.meta
      const [left, top] = toPx(origin[0], origin[1] + floor.canvas.height * resolution)
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(
        floor.canvas,
        left,
        top,
        floor.canvas.width * resolution * scale,
        floor.canvas.height * resolution * scale,
      )
      return
    }
    // Without a grid, a metre grid: a line every 1, 5, 10 or 50 m, about 40 px apart.
    const step = [1, 5, 10, 50, 100].find((s) => s * scale >= 32) ?? 100
    ctx.strokeStyle = rgba(colors.hud, 0.14)
    ctx.lineWidth = 1
    for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
      const [lx] = toPx(gx, 0)
      ctx.beginPath()
      ctx.moveTo(Math.round(lx) + 0.5, 0)
      ctx.lineTo(Math.round(lx) + 0.5, height)
      ctx.stroke()
    }
    for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) {
      const [, ly] = toPx(0, gy)
      ctx.beginPath()
      ctx.moveTo(0, Math.round(ly) + 0.5)
      ctx.lineTo(width, Math.round(ly) + 0.5)
      ctx.stroke()
    }
  }, [width, height, floor, x0, y0, x1, y1, cx, cy, scale, colors])

  const places = world.places ?? []
  const zones = places.filter((p) => p.points)
  const landmarks = places.filter((p) => p.at)
  const zoneName = (id: string | undefined) => places.find((p) => p.id === id)?.name ?? id
  return (
    <section className="mhs-world-card">
      <header className="mhs-world-head">
        <strong>{world.name ?? world.map}</strong>
        {world.name && world.name !== world.map && <code>{world.map}</code>}
        <span className="mhs-grow" />
        <span className="mhs-dim">
          {t('world.devices', { n: on.length })} · {t('world.places', { n: places.length })}
        </span>
      </header>
      <div className="mhs-world-map mhs-screen" ref={setBox} style={{ height }}>
        <canvas ref={canvas} style={{ width, height }} />
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-label={world.name ?? world.map}
        >
          {zones.map((z) => (
            <ZoneShape key={z.id} zone={z} px={px} />
          ))}
          {landmarks.map((l) => (
            <LandmarkPin key={l.id} landmark={l} px={px} width={width} />
          ))}
          {[...on.filter((d) => !d.available), ...on.filter((d) => d.available)].map((d) => (
            <DeviceMarker key={d.id} device={d} px={px} width={width} onOpen={() => nav.open(d.id)} />
          ))}
        </svg>
        {places.length === 0 && !world.name && (
          <div className="mhs-map-note mhs-note">{t('world.undeclared')}</div>
        )}
      </div>
      {on.length > 0 && (
        <div className="mhs-world-list">
          {on.map((d) => (
            <button type="button" key={d.id} className="mhs-world-item" onClick={() => nav.open(d.id)}>
              <span className="mhs-dot" data-tone={tone(d)} />
              <span className="mhs-world-item-name">{displayName(d)}</span>
              {d.position?.zone && <span className="mhs-dim">{zoneName(d.position.zone)}</span>}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

type Px = (x: number, y: number) => Pt

/** A label beside a marker, on its left near the right edge so it stays on the map. */
function Label(props: {
  x: number
  y: number
  width: number
  gap: number
  text: string
  note?: string | undefined
}) {
  const left = props.x > props.width * 0.72
  return (
    <text x={props.x + (left ? -props.gap : props.gap)} y={props.y} textAnchor={left ? 'end' : 'start'}>
      {props.text}
      {props.note && (
        <tspan className="mhs-world-note" dx={5}>
          {props.note}
        </tspan>
      )}
    </text>
  )
}

function ZoneShape(props: { zone: Place; px: Px }) {
  const pts = (props.zone.points ?? []).map(([x, y]) => props.px(x, y))
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const [lx, ly] = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
  return (
    <g className="mhs-world-zone">
      <title>
        {props.zone.description ? `${props.zone.name}: ${props.zone.description}` : props.zone.name}
      </title>
      <polygon points={pts.map((p) => p.join(',')).join(' ')} />
      <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle">
        {props.zone.name}
      </text>
    </g>
  )
}

function LandmarkPin(props: { landmark: Place; px: Px; width: number }) {
  const l = props.landmark
  const [x, y] = props.px(...(l.at as Pt))
  const yaw = l.yaw === undefined ? undefined : (-l.yaw * Math.PI) / 180
  return (
    <g className="mhs-world-landmark">
      <title>{l.description ? `${l.name}: ${l.description}` : l.name}</title>
      {yaw !== undefined && <line x1={x} y1={y} x2={x + 11 * Math.cos(yaw)} y2={y + 11 * Math.sin(yaw)} />}
      <path d={`M ${x} ${y} l -4.5 -8 a 5 5 0 1 1 9 0 z`} />
      <circle cx={x} cy={y - 10.5} r={1.8} />
      <Label x={x} y={y - 7} width={props.width} gap={7} text={l.name} />
    </g>
  )
}

function DeviceMarker(props: { device: Device; px: Px; width: number; onOpen: () => void }) {
  const d = props.device
  const p = d.position
  const [x, y] = props.px(p?.x ?? 0, p?.y ?? 0)
  const fixed = p?.fixed === true
  const away = !d.available
  const rotate = -(p?.yaw ?? 0)
  const shape = fixed ? 'M -5 -5 h 10 v 10 h -10 z M 5 0 h 7' : 'M 10 0 L -6 6.5 L -3 0 L -6 -6.5 Z'
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
    <g
      className="mhs-world-device"
      data-tone={tone(d)}
      data-trust={p?.trust}
      data-fixed={fixed || undefined}
      data-away={away || undefined}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') props.onOpen()
      }}
    >
      <title>{`${displayName(d)} (${d.id})`}</title>
      <circle className="mhs-world-hit" cx={x} cy={y} r={14} />
      <path d={shape} transform={`translate(${x} ${y}) rotate(${rotate})`} />
      <Label
        x={x}
        y={y + 15}
        width={props.width}
        gap={12}
        text={displayName(d)}
        note={away ? t('world.offline') : undefined}
      />
    </g>
  )
}
