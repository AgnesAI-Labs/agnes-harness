/**
 * Data widgets that are mostly text: `values` and `switch` sources as field grids, `text` and
 * `transcript` as a scrolling log, `odometry` as numbers with a short trail, `imu` and `gnss` as
 * numbers, and JSON for anything else (mhs-ui-design section 8).
 */
import { useEffect, useRef, useState } from 'react'
import type { Latest } from '../core/store.js'
import type { Json } from '../core/types.js'
import { num, valueText } from '../i18n/i18n.js'
import { useStore } from '../react/hooks.js'
import { FieldView } from './fields.js'
import { Frame, type SourceProps, useLive } from './frame.js'

export function ValuesView(props: SourceProps) {
  const store = useStore()
  const { ref, latest, off } = useLive(props.device, props.source, props.hz)
  const fields = props.source.fields ?? {}
  useEffect(() => {
    if (props.source.kind === 'values') void store.readHistory(props.device.id, props.source.id)
  }, [store, props.device.id, props.source.id, props.source.kind])
  const data = (latest?.item.data as Json | undefined) ?? {}
  return (
    <Frame {...props} latest={latest} off={off} setRef={ref}>
      <div className="mhs-fields">
        {Object.entries(fields)
          .filter(([, f]) => !f.ui?.hidden)
          .map(([name, field]) => (
            <FieldView
              key={name}
              name={name}
              field={field}
              value={data[name]}
              trend={[props.device.id, props.source.id]}
            />
          ))}
      </div>
    </Frame>
  )
}

export function TextLog(props: SourceProps) {
  const store = useStore()
  const { ref, latest, off } = useLive(props.device, props.source, props.hz)
  const [lines, setLines] = useState<{ id: number; text: string; final: boolean }[]>([])
  const box = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    let n = 0
    return store.onItem(props.device.id, props.source.id, (l: Latest) => {
      const data = l.item.data as { text?: string; final?: boolean } | undefined
      if (!data?.text) return
      n += 1
      const id = n
      setLines((old) => {
        const last = old[old.length - 1]
        // A partial transcript is replaced by the next part of the same utterance.
        const kept = last && last.final === false ? old.slice(0, -1) : old
        return [...kept, { id, text: data.text ?? '', final: data.final !== false }].slice(-30)
      })
    })
  }, [store, props.device.id, props.source.id])
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [lines])
  const shown =
    lines.length > 0
      ? lines
      : latest
        ? [{ id: 0, text: String((latest.item.data as Json)?.text ?? ''), final: true }]
        : []
  return (
    <Frame {...props} latest={latest} off={off} setRef={ref}>
      <div className="mhs-log" ref={box}>
        {shown.map((l) => (
          <div key={l.id} data-partial={!l.final || undefined}>
            {l.text}
          </div>
        ))}
      </div>
    </Frame>
  )
}

export function OdometryView(props: SourceProps) {
  const store = useStore()
  const { ref, latest, off } = useLive(props.device, props.source, props.hz)
  const [trail, setTrail] = useState<[number, number][]>([])
  useEffect(
    () =>
      store.onItem(props.device.id, props.source.id, (l: Latest) => {
        const d = l.item.data as { x?: number; y?: number } | undefined
        if (typeof d?.x !== 'number' || typeof d.y !== 'number') return
        setTrail((old) => [...old, [d.x as number, d.y as number] as [number, number]].slice(-200))
      }),
    [store, props.device.id, props.source.id],
  )
  const d =
    (latest?.item.data as { x: number; y: number; yaw: number; v: number; w: number } | undefined) ??
    undefined
  const xs = trail.map((p) => p[0])
  const ys = trail.map((p) => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const span = Math.max(x1 - x0, y1 - y0, 1)
  return (
    <Frame {...props} latest={latest} off={off} setRef={ref}>
      {d && (
        <div className="mhs-odo">
          <div className="mhs-fields">
            <FieldView name="x" field={{ type: 'number', unit: 'm' }} value={d.x} />
            <FieldView name="y" field={{ type: 'number', unit: 'm' }} value={d.y} />
            <FieldView name="yaw" field={{ type: 'number', unit: '°' }} value={d.yaw} />
            <FieldView name="v" field={{ type: 'number', unit: 'm/s' }} value={d.v} />
            <FieldView name="w" field={{ type: 'number', unit: 'deg/s' }} value={d.w} />
          </div>
          {trail.length > 1 && (
            <svg className="mhs-odo-trail" viewBox="-2 -2 104 104" aria-hidden="true">
              <polyline
                points={trail
                  .map(([x, y]) => `${((x - x0) / span) * 100},${100 - ((y - y0) / span) * 100}`)
                  .join(' ')}
              />
            </svg>
          )}
        </div>
      )}
    </Frame>
  )
}

export function NumbersView(props: SourceProps) {
  const { ref, latest, off } = useLive(props.device, props.source, props.hz)
  const data = (latest?.item.data as Json | undefined) ?? {}
  return (
    <Frame {...props} latest={latest} off={off} setRef={ref}>
      <div className="mhs-fields">
        {Object.entries(data).map(([name, value]) => (
          <div className="mhs-field" key={name}>
            <span className="mhs-field-label">{name}</span>
            <span className="mhs-field-value">
              {Array.isArray(value)
                ? value.map((v) => (typeof v === 'number' ? num(v, 2) : String(v))).join(', ')
                : valueText(value)}
            </span>
          </div>
        ))}
      </div>
    </Frame>
  )
}

export function JsonView(props: SourceProps) {
  const { ref, latest, off } = useLive(props.device, props.source, props.hz)
  return (
    <Frame {...props} latest={latest} off={off} setRef={ref}>
      <pre className="mhs-json">{JSON.stringify(latest?.item.data ?? null, null, 2)}</pre>
    </Frame>
  )
}
