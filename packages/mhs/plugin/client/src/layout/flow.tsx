/**
 * The flow view: the brain at the top, AgnesHub below it as a bus down the left edge, and every
 * device in a column of wide cards, each joined to the bus by two lanes: MHS, the command channel
 * (calls, control, state, results), and MOS, the Nerve data channel (data streams, manual input).
 * It only moves when something is exchanged: a comet per call (bright, down) and per result (dim,
 * up) on MHS, particles at the rate AgnesHub counted on Nerve (hub/traffic), amber ones while a
 * person drives.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { type Rgb, rgba, rgbOf } from '../core/color.js'
import { displayName, keyFields, previewImage, tone } from '../core/describe.js'
import type { BrainPulse, Traffic } from '../core/store.js'
import type { Device } from '../core/types.js'
import { num, t } from '../i18n/i18n.js'
import { useBrainPulses, useDevices, useLocale, useNav, useTraffic } from '../react/hooks.js'
import { FieldView } from '../widgets/fields.js'
import { ImageView, VideoView } from '../widgets/image.js'
import type { Brain } from './panel.js'
import { Doing, HealthText, PositionText, StatePill } from './parts.js'

/** The two bus lines down the left edge, and where the cards start. */
const MHS_X = 22
const NERVE_X = 34
const CARD_X = 56
const BRAIN_Y = 10
const BRAIN_H = 48
const BRAIN_X = 36
const HUB_Y = 84
const HUB_H = 28
/** A card's text part until the card is measured; a device with a picture shows it above, as wide as the card. */
const INFO_H = 184
const CARD_GAP = 16
const PICTURE_MAX = 260
/** Where each lane enters a card, from its top. */
const MHS_IN = 24
const NERVE_IN = 50
const TRIP_MS = 900
/** Data rides slower than calls, so a sparse stream stays visible. */
const tripOf = (d: { kind: string }) => (d.kind === 'data' || d.kind === 'drive' ? 1500 : TRIP_MS)
/** At most this many particles per lane per second, whatever the traffic. */
const MAX_DOTS = 6

type Lane = 'mhs' | 'nerve' | 'brain'
type Kind = 'call' | 'result' | 'data' | 'drive'
interface Dot {
  lane: Lane
  kind: Kind
  device?: string | undefined
  up: boolean
  start: number
}

interface Geometry {
  width: number
  height: number
  /** Card tops by device id. */
  cards: Map<string, number>
  /** Picture heights by device id: 0 for a device without one. */
  pictures: Map<string, number>
  /** The AgnesHub bar's top: under the brain, or at the top on a page without one. */
  hub: number
}

/** Devices in one column to the right of the bus, so each card can be wide and as tall as its content. */
function layout(devices: Device[], width: number, heights: Map<string, number>, hub: number): Geometry {
  const cards = new Map<string, number>()
  const pictures = new Map<string, number>()
  const picture = Math.min(PICTURE_MAX, Math.round(((width - CARD_X - 12) * 9) / 16))
  let y = hub + HUB_H + 20
  for (const d of devices) {
    const h = previewImage(d) ? picture : 0
    cards.set(d.id, y)
    pictures.set(d.id, h)
    y += (heights.get(d.id) ?? h + INFO_H) + CARD_GAP
  }
  return { width, height: y, cards, pictures, hub }
}

/** The polyline a lane follows, from AgnesHub (t = 0) to the device, or up to the brain (t = 1). */
function path(g: Geometry, lane: Lane, device?: string): [number, number][] {
  if (lane === 'brain')
    return [
      [BRAIN_X, g.hub],
      [BRAIN_X, BRAIN_Y + BRAIN_H],
    ]
  const top = g.cards.get(device ?? '')
  if (top === undefined) return []
  const x = lane === 'mhs' ? MHS_X : NERVE_X
  const y = top + (lane === 'mhs' ? MHS_IN : NERVE_IN)
  return [
    [x, g.hub + HUB_H],
    [x, y],
    [CARD_X, y],
  ]
}

function pointAt(points: [number, number][], t: number): [number, number] {
  if (points.length < 2) return points[0] ?? [0, 0]
  const lengths = points.slice(1).map((p, i) => {
    const [x, y] = points[i] as [number, number]
    return Math.hypot(p[0] - x, p[1] - y)
  })
  let left = Math.max(0, Math.min(1, t)) * lengths.reduce((a, b) => a + b, 0)
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i] as number
    const [ax, ay] = points[i] as [number, number]
    const [bx, by] = points[i + 1] as [number, number]
    if (left <= len || i === lengths.length - 1) {
      const f = len > 0 ? Math.min(1, left / len) : 0
      return [ax + (bx - ax) * f, ay + (by - ay) * f]
    }
    left -= len
  }
  return points[points.length - 1] as [number, number]
}

const line = (pts: [number, number][]) => pts.map(([x, y]) => `${x},${y}`).join(' ')

function rate(n: number): string {
  return n > 0 ? `${num(n, 0)}/s` : '—'
}

function kbps(bytes: number): string {
  if (bytes <= 0) return ''
  return bytes >= 1_000_000 ? ` · ${num(bytes / 1_000_000, 1)} MB/s` : ` · ${num(bytes / 1000, 0)} kB/s`
}

const THUMB_HZ = 5

function DeviceCard(props: {
  device: Device
  top: number
  width: number
  picture: number
  traffic: Traffic | undefined
  onHeight: (id: string, height: number) => void
}) {
  const nav = useNav()
  const d = props.device
  const tr = props.traffic
  const picture = props.picture > 0 ? previewImage(d) : undefined
  const card = useRef<HTMLElement | null>(null)
  const { onHeight } = props

  // The card sizes itself to its content; the layout places the cards below it by that height.
  useEffect(() => {
    const el = card.current
    if (!el) return
    const observer = new ResizeObserver(() => onHeight(d.id, el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [d.id, onHeight])

  return (
    <article
      ref={card}
      className="mhs-flow-device"
      data-tone={tone(d)}
      style={{ left: CARD_X, top: props.top, width: props.width }}
    >
      {picture && (
        <div className="mhs-flow-thumb" style={{ height: props.picture }}>
          {picture.kind === 'video' ? (
            <VideoView device={d} source={picture} compact />
          ) : (
            <ImageView device={d} source={picture} hz={THUMB_HZ} compact />
          )}
        </div>
      )}
      <div className="mhs-flow-info">
        <button type="button" className="mhs-flow-name" onClick={() => nav.open(d.id)}>
          <span className="mhs-mark">{displayName(d)}</span>
          <code className="mhs-dim">{d.id}</code>
        </button>
        <StatePill device={d} />
        <span className="mhs-flow-status">
          <HealthText health={d.health} />
          {d.position && <PositionText position={d.position} detail />}
        </span>
        <Doing device={d} compact />
        <span className="mhs-fields mhs-flow-fields">
          {keyFields(d, 3).map(([name, field]) => (
            <FieldView key={name} name={name} field={field} value={d.state.values[name]} />
          ))}
        </span>
        <span className="mhs-flow-rates">
          <span data-lane="mhs" title={t('flow.lane.mhs')}>
            <b>MHS</b> ↓{rate(tr?.mhs_down ?? 0)} ↑{rate(tr?.mhs_up ?? 0)}
          </span>
          <span data-lane="nerve" title={t('flow.lane.mos')}>
            <b>MOS</b> ↑{rate(tr?.nerve_up ?? 0)}
            {kbps(tr?.bytes_up ?? 0)}
            {tr?.nerve_down ? ` ↓${rate(tr.nerve_down)}` : ''}
          </span>
        </span>
      </div>
    </article>
  )
}

export function Flow(props: { brain?: Brain | undefined }) {
  useLocale()
  const devices = useDevices()
  const traffic = useTraffic()
  const pulses = useBrainPulses()
  const [width, setWidth] = useState(360)
  const [heights, setHeights] = useState(() => new Map<string, number>())
  const onHeight = useCallback(
    (id: string, h: number) => setHeights((m) => (m.get(id) === h ? m : new Map(m).set(id, h))),
    [],
  )
  const box = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const dots = useRef<Dot[]>([])
  const seenPulse = useRef(0)
  // A page without a session (the standalone page) has no brain to draw.
  const g = layout(devices, width, heights, props.brain ? HUB_Y : BRAIN_Y)
  const geometry = useRef(g)
  geometry.current = g

  useEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(Math.max(280, el.clientWidth)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Each traffic report becomes particles spread over the next second.
  useEffect(() => {
    const now = performance.now()
    for (const [device, tr] of Object.entries(traffic.devices)) {
      const lanes: [Lane, Kind, boolean, number][] = [
        ['mhs', 'result', true, tr.mhs_up],
        ['mhs', 'call', false, tr.mhs_down],
        ['nerve', 'data', true, tr.nerve_up],
        ['nerve', 'drive', false, tr.nerve_down],
      ]
      for (const [lane, kind, up, n] of lanes) {
        const shown = Math.min(n, MAX_DOTS)
        for (let i = 0; i < shown; i++)
          dots.current.push({ lane, kind, device, up, start: now + (i * 1000) / shown })
      }
    }
  }, [traffic])

  // The brain's calls ride its line down, then the device's MHS lane; results come back up.
  useEffect(() => {
    const now = performance.now()
    for (const p of pulses as BrainPulse[]) {
      if (p.id <= seenPulse.current) continue
      seenPulse.current = p.id
      const kind: Kind = p.dir === 'down' ? 'call' : 'result'
      if (p.dir === 'down') {
        dots.current.push({ lane: 'brain', kind, up: false, start: now })
        if (p.device)
          dots.current.push({ lane: 'mhs', kind, device: p.device, up: false, start: now + TRIP_MS * 0.6 })
      } else {
        if (p.device) dots.current.push({ lane: 'mhs', kind, device: p.device, up: true, start: now })
        dots.current.push({ lane: 'brain', kind, up: true, start: now + TRIP_MS * 0.6 })
      }
    }
  }, [pulses])

  // One animation loop draws every comet and particle, in the panel's own colours.
  useEffect(() => {
    let raf = 0
    let colors: { accent: Rgb; dim: Rgb; warn: Rgb; glow: boolean } = {
      accent: [50, 72, 175],
      dim: [66, 70, 86],
      warn: [128, 94, 33],
      glow: false,
    }
    let colorsAt = -Infinity
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      const geo = geometry.current
      if (!c) return
      const now = performance.now()
      const dpr = window.devicePixelRatio || 1
      if (c.width !== geo.width * dpr || c.height !== geo.height * dpr) {
        c.width = geo.width * dpr
        c.height = geo.height * dpr
      }
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      if (now - colorsAt > 1000) {
        const style = getComputedStyle(c)
        const read = (name: string, fallback: Rgb) =>
          rgbOf(ctx, style.getPropertyValue(name).trim() || rgba(fallback, 1), fallback)
        const glow = style.getPropertyValue('--mhs-glow').trim()
        colors = {
          accent: read('--mhs-accent', colors.accent),
          dim: read('--mhs-text-3', colors.dim),
          warn: read('--mhs-warn', colors.warn),
          glow: glow !== '' && glow !== 'transparent',
        }
        colorsAt = now
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, geo.width, geo.height)
      dots.current = dots.current.filter((d) => now - d.start < tripOf(d))
      for (const d of dots.current) {
        const t = (now - d.start) / tripOf(d)
        if (t < 0) continue
        const pts = path(geo, d.lane, d.device)
        if (pts.length === 0) continue
        // Lanes run from AgnesHub outwards; the brain's line runs from AgnesHub up.
        const at = (s: number) => (d.lane === 'brain' ? (d.up ? s : 1 - s) : d.up ? 1 - s : s)
        const [x, y] = pointAt(pts, at(t))
        if (d.kind === 'call' || d.kind === 'result') {
          // A comet: a head and a tail of the same colour fading out behind it.
          const [tx, ty] = pointAt(pts, at(Math.max(0, t - 0.14)))
          const color = d.kind === 'call' ? colors.accent : colors.dim
          const tail = ctx.createLinearGradient(tx, ty, x, y)
          tail.addColorStop(0, rgba(color, 0))
          tail.addColorStop(1, rgba(color, 0.9))
          ctx.strokeStyle = tail
          ctx.lineWidth = d.kind === 'call' ? 2.5 : 2
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(tx, ty)
          ctx.lineTo(x, y)
          ctx.stroke()
          ctx.shadowColor = d.kind === 'call' && colors.glow ? rgba(color, 1) : 'rgba(0, 0, 0, 0)'
          ctx.shadowBlur = 8
          ctx.fillStyle = rgba(color, 1)
          ctx.beginPath()
          ctx.arc(x, y, d.kind === 'call' ? 3 : 2.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.shadowBlur = 0
        } else {
          // A data particle: a small dot that fades in and out, so a busy stream stays a dotted line.
          const color = d.kind === 'drive' ? colors.warn : colors.accent
          const fade = Math.min(1, t * 6, (1 - t) * 6)
          ctx.shadowColor = colors.glow || d.kind === 'drive' ? rgba(color, 0.8) : 'rgba(0, 0, 0, 0)'
          ctx.shadowBlur = 5
          ctx.fillStyle = rgba(color, (d.kind === 'drive' ? 0.9 : 0.6) * fade)
          ctx.beginPath()
          ctx.arc(x, y, 2, 0, Math.PI * 2)
          ctx.fill()
          ctx.shadowBlur = 0
        }
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  const fresh = Date.now() - traffic.at < 2500
  const recent = (pulses as BrainPulse[]).slice(-4)
  const last = recent[recent.length - 1]
  const thinking = props.brain?.thinking === true
  return (
    <div className="mhs-flow" ref={box} style={{ height: g.height }}>
      <svg className="mhs-flow-lines" width={g.width} height={g.height} aria-hidden="true">
        {props.brain && <polyline points={line(path(g, 'brain'))} className="mhs-flow-brainline" />}
        {devices.map((d) => {
          const top = g.cards.get(d.id) ?? 0
          return (
            <g key={d.id}>
              <polyline points={line(path(g, 'mhs', d.id))} className="mhs-flow-mhs" />
              <polyline points={line(path(g, 'nerve', d.id))} className="mhs-flow-nerve" />
              <circle cx={MHS_X} cy={top + MHS_IN} r={2.5} className="mhs-flow-port" />
              <rect
                x={NERVE_X - 2.5}
                y={top + NERVE_IN - 2.5}
                width={5}
                height={5}
                transform={`rotate(45 ${NERVE_X} ${top + NERVE_IN})`}
                className="mhs-flow-port"
                data-lane="nerve"
              />
            </g>
          )
        })}
      </svg>
      <canvas ref={canvas} className="mhs-flow-dots" style={{ width: g.width, height: g.height }} />
      {props.brain && (
        <div
          className="mhs-flow-brain"
          style={{ left: 12, top: BRAIN_Y }}
          data-thinking={thinking || undefined}
        >
          <span className="mhs-flow-core">
            <i />
            <i />
            <i />
          </span>
          <span className="mhs-flow-brain-text">
            <b>{t('flow.brain')}</b>
            <span>
              {thinking ? <em>{t('flow.thinking')}</em> : t('flow.idle')}
              {last && Date.now() - last.at < 15_000
                ? ` · ${last.tool}${last.device ? ` → ${last.device}` : ''}`
                : ''}
            </span>
          </span>
        </div>
      )}
      {props.brain && (
        <div className="mhs-flow-term" style={{ top: BRAIN_Y }}>
          {recent.map((p) => (
            <span key={p.id} data-dir={p.dir}>
              {p.tool}
              {p.device ? ` ${p.device}` : ''}
            </span>
          ))}
        </div>
      )}
      <div className="mhs-flow-hub" style={{ top: g.hub, left: 12, width: g.width - 24, height: HUB_H }}>
        <b>AgnesHub</b>
        <span className="mhs-dim">
          <span title={t('flow.lane.mhs')}>
            <i className="mhs-flow-key" data-lane="mhs" />
            MHS
          </span>
          <span title={t('flow.lane.mos')}>
            <i className="mhs-flow-key" data-lane="nerve" />
            MOS
          </span>
        </span>
      </div>
      {devices.map((d) => {
        const top = g.cards.get(d.id)
        if (top === undefined) return null
        return (
          <DeviceCard
            key={d.id}
            device={d}
            top={top}
            width={g.width - CARD_X - 12}
            picture={g.pictures.get(d.id) ?? 0}
            traffic={fresh ? traffic.devices[d.id] : undefined}
            onHeight={onHeight}
          />
        )
      })}
    </div>
  )
}
