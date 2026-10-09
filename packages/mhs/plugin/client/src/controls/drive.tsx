/**
 * The drive area (mhs-ui-design section 9), built from the axes a device declares: paired axes
 * (forward + turn, pitch + yaw) as a pad, the others as sticks; keys while the area is engaged.
 * Input goes out as `hub/manual` at the device's `rate_hz` while anything is held, then one
 * all-zero message. Space stops the device; Esc, a click elsewhere or a hidden tab let go.
 */
import { useEffect, useRef, useState } from 'react'
import { keysOf } from '../core/describe.js'
import type { Axis, Device, Manual } from '../core/types.js'
import { t, word } from '../i18n/i18n.js'
import { useStore } from '../react/hooks.js'
import { Segmented } from './ui.js'

function axisLabel(a: Axis): string {
  return a.role === 'joint' ? t('axis.joint', { n: a.joint ?? 0 }) : word('axis', a.role, a.id)
}

/** -1..1 per axis id → device units, scaled by the chosen speed. */
function toUnits(manual: Manual, input: Record<string, number>, scale: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of manual.axes) {
    const v = input[a.id] ?? 0
    out[a.id] = Math.round((v >= 0 ? v * a.max : -v * a.min) * scale * 1000) / 1000
  }
  return out
}

export function Drive(props: { device: Device }) {
  const store = useStore()
  const manual = props.device.manual as Manual
  const [engaged, setEngaged] = useState(false)
  const [speed, setSpeed] = useState(manual.speeds?.[0]?.label ?? '')
  const scale = manual.speeds?.find((s) => s.label === speed)?.scale ?? 1
  const keys = useRef(new Set<string>())
  const pointer = useRef<Record<string, number>>({})
  const [shown, setShown] = useState<Record<string, number>>({})
  const area = useRef<HTMLDivElement | null>(null)
  const sending = useRef(false)
  const disabled = !props.device.available || store.conn !== 'open'

  // The send loop: while anything is held, at rate_hz; once more with zeros when everything is let go.
  useEffect(() => {
    const keyMap = keysOf(manual)
    const period = 1000 / Math.max(1, manual.rate_hz)
    const timer = setInterval(() => {
      const input: Record<string, number> = { ...pointer.current }
      for (const k of keys.current) {
        const hit = keyMap.get(k)
        if (hit) input[hit[0]] = Math.max(-1, Math.min(1, (input[hit[0]] ?? 0) + hit[1]))
      }
      const active = Object.values(input).some((v) => v !== 0)
      if (active) {
        sending.current = true
        store.manual(props.device.id, toUnits(manual, input, scale))
        setShown(input)
      } else if (sending.current) {
        sending.current = false
        store.manual(props.device.id, toUnits(manual, {}, 1))
        setShown({})
      }
    }, period)
    return () => {
      clearInterval(timer)
      if (sending.current) store.manual(props.device.id, toUnits(manual, {}, 1))
      sending.current = false
    }
  }, [store, props.device.id, manual, scale])

  // Keyboard while engaged; leaving lets everything go.
  useEffect(() => {
    if (!engaged) return
    const keyMap = keysOf(manual)
    const leave = () => {
      keys.current.clear()
      setEngaged(false)
    }
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /input|textarea|select/i.test(target.tagName)) return leave()
      if (e.key === 'Escape') return leave()
      if (e.key === ' ') {
        e.preventDefault()
        keys.current.clear()
        void store.stop(props.device.id).catch(() => undefined)
        return
      }
      const k = e.key.toLowerCase()
      if (keyMap.has(k)) {
        e.preventDefault()
        keys.current.add(k)
      }
    }
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase())
    const outside = (e: PointerEvent) => {
      if (area.current && !area.current.contains(e.target as Node)) leave()
    }
    const hidden = () => document.visibilityState !== 'visible' && leave()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', leave)
    window.addEventListener('pointerdown', outside)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', leave)
      window.removeEventListener('pointerdown', outside)
      document.removeEventListener('visibilitychange', hidden)
      keys.current.clear()
    }
  }, [engaged, manual, store, props.device.id])

  const pairs: [Axis, Axis][] = []
  const used = new Set<string>()
  for (const [y, x] of [
    ['forward', 'turn'],
    ['pitch', 'yaw'],
  ] as const) {
    const ay = manual.axes.find((a) => a.role === y)
    const ax = manual.axes.find((a) => a.role === x)
    if (ay && ax) {
      pairs.push([ay, ax])
      used.add(ay.id)
      used.add(ax.id)
    }
  }
  const sticks = manual.axes.filter((a) => !used.has(a.id))
  const set = (id: string, v: number) => {
    pointer.current = { ...pointer.current, [id]: v }
  }

  return (
    <div
      className="mhs-drive"
      data-engaged={engaged || undefined}
      data-disabled={disabled || undefined}
      ref={area}
      onPointerDown={() => !disabled && setEngaged(true)}
    >
      <div className="mhs-drive-hint">{engaged ? t('drive.active') : t('drive.hint')}</div>
      <div className="mhs-drive-controls">
        {pairs.map(([ay, ax]) => (
          <Pad
            key={ay.id}
            y={ay}
            x={ax}
            value={[shown[ax.id] ?? 0, shown[ay.id] ?? 0]}
            onChange={(x, y) => {
              set(ax.id, x)
              set(ay.id, y)
            }}
            disabled={disabled}
          />
        ))}
        {sticks.map((a) => (
          <Stick
            key={a.id}
            axis={a}
            value={shown[a.id] ?? 0}
            onChange={(v) => set(a.id, v)}
            disabled={disabled}
          />
        ))}
      </div>
      {manual.speeds && manual.speeds.length > 1 && (
        <div className="mhs-drive-speed">
          <span>{t('drive.speed')}</span>
          <Segmented value={speed} options={manual.speeds.map((s) => s.label)} onChange={setSpeed} />
        </div>
      )}
    </div>
  )
}

/** Holds while the pointer is down; letting go, leaving or cancelling returns to zero. */
function usePointerHold(onMove: (e: React.PointerEvent<HTMLDivElement>) => void, onRelease: () => void) {
  return {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      onMove(e)
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) onMove(e)
    },
    onPointerUp: onRelease,
    onPointerCancel: onRelease,
    onLostPointerCapture: onRelease,
  }
}

function Pad(props: {
  x: Axis
  y: Axis
  value: [number, number]
  onChange: (x: number, y: number) => void
  disabled: boolean
}) {
  const hold = usePointerHold(
    (e) => {
      if (props.disabled) return
      const r = e.currentTarget.getBoundingClientRect()
      const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1))
      const ny = Math.max(-1, Math.min(1, 1 - ((e.clientY - r.top) / r.height) * 2))
      // Screen right is a negative turn (counter-clockwise is positive).
      props.onChange(-nx, ny)
    },
    () => props.onChange(0, 0),
  )
  const [vx, vy] = props.value
  return (
    <div className="mhs-pad-wrap">
      <div className="mhs-pad" {...hold}>
        <span className="mhs-pad-dot" style={{ left: `${(1 - vx) * 50}%`, top: `${(1 - vy) * 50}%` }} />
      </div>
      <span className="mhs-drive-label">
        {axisLabel(props.y)} · {axisLabel(props.x)}
      </span>
    </div>
  )
}

function Stick(props: { axis: Axis; value: number; onChange: (v: number) => void; disabled: boolean }) {
  const hold = usePointerHold(
    (e) => {
      if (props.disabled) return
      const r = e.currentTarget.getBoundingClientRect()
      props.onChange(Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1)))
    },
    () => props.onChange(0),
  )
  return (
    <div className="mhs-stick-wrap">
      <div className="mhs-stick" {...hold}>
        <span className="mhs-stick-dot" style={{ left: `${(props.value + 1) * 50}%` }} />
      </div>
      <span className="mhs-drive-label">
        {axisLabel(props.axis)} <small>{props.axis.unit}</small>
      </span>
    </div>
  )
}
