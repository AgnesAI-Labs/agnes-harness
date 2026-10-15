import type { JsonValue } from '@agnes/protocol'
import { Button } from '@agnes/web-ui'
import { useState } from 'react'
import { gridSources, MapGrid } from './grid.js'
import { array, type Data, type Device, number, record, text } from './model.js'
import { useMhs } from './react.js'
export type PickMode = 'point' | 'pose' | 'polygon'
export function extent(map: Data, devices: readonly Device[]): [number, number, number, number] {
  const b = array(map.bounds)
  if (
    b.length === 4 &&
    b.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    number(b[2]) > number(b[0]) &&
    number(b[3]) > number(b[1])
  )
    return b as [number, number, number, number]
  const points: [number, number][] = []
  for (const d of devices)
    if (d.position.map === map.id) points.push([number(d.position.x), number(d.position.y)])
  for (const raw of array(map.places)) {
    const p = record(raw)
    if (Array.isArray(p.at)) points.push([number(p.at[0]), number(p.at[1])])
    for (const xy of array(p.points)) {
      const a = array(xy)
      points.push([number(a[0]), number(a[1])])
    }
  }
  if (!points.length) return [-5, -5, 5, 5]
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1])
  return [Math.min(...xs) - 2, Math.min(...ys) - 2, Math.max(...xs) + 2, Math.max(...ys) + 2]
}
export function pickValue(
  mode: PickMode,
  map: string,
  points: readonly [number, number][],
): JsonValue | undefined {
  if (mode === 'point' && points[0]) return { map, x: points[0][0], y: points[0][1] }
  if (mode === 'pose' && points[0] && points[1])
    return {
      map,
      x: points[0][0],
      y: points[0][1],
      yaw: (Math.atan2(points[1][1] - points[0][1], points[1][0] - points[0][0]) * 180) / Math.PI,
    }
  if (mode === 'polygon' && points.length >= 3) return { map, points: points.map((p) => [...p]) }
  return undefined
}
export function WorldMap({
  maps,
  devices,
  mode,
  onPick,
  onCancel,
}: {
  maps: readonly Data[]
  devices: readonly Device[]
  mode?: PickMode
  onPick?: (v: JsonValue) => void
  onCancel?: () => void
}) {
  const { t, openDevice } = useMhs(),
    [selected, setSelected] = useState(''),
    [points, setPoints] = useState<[number, number][]>([]),
    [x, setX] = useState('0'),
    [y, setY] = useState('0')
  const allMaps = [...maps]
  for (const d of devices) {
    const id = text(d.position.map)
    if (id && !allMaps.some((m) => m.id === id)) allMaps.push({ id })
  }
  const map = allMaps.find((m) => m.id === selected) ?? allMaps[0]
  if (!map)
    return (
      <div className="mhs-empty">
        {t('noMap')}
        {onCancel && <Button onClick={onCancel}>{t('cancelPick')}</Button>}
      </div>
    )
  const [x0, y0, x1, y1] = extent(map, devices),
    xy = (px: number, py: number): [number, number] => [
      ((px - x0) / (x1 - x0)) * 100,
      100 - ((py - y0) / (y1 - y0)) * 100,
    ]
  const add = (point: [number, number]) => {
    if (points.some((p) => p[0] === point[0] && p[1] === point[1])) return
    const next = [...points, point].slice(0, 256)
    setPoints(next)
    if (mode && mode !== 'polygon') {
      const v = pickValue(mode, text(map.id), next)
      if (v !== undefined) onPick?.(v)
    }
  }
  const finish = () => {
    if (mode) {
      const v = pickValue(mode, text(map.id), points)
      if (v !== undefined) onPick?.(v)
    }
  }
  return (
    <section className="mhs-world">
      <label>
        {t('mhs.map')}
        <select
          value={text(map.id)}
          onChange={(e) => {
            setSelected(e.target.value)
            setPoints([])
          }}
        >
          {allMaps.map((m) => (
            <option key={text(m.id)} value={text(m.id)}>
              {text(m.name) || text(m.id)}
            </option>
          ))}
        </select>
      </label>
      <div className="mhs-map-surface">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={text(map.name) || text(map.id)}
        >
          {!mode &&
            gridSources(devices, text(map.id))
              .slice(0, 1)
              .map(({ device, source }) => (
                <MapGrid
                  key={`${device.id}:${device.revision}:${source}:${text(map.id)}`}
                  map={text(map.id)}
                  device={device}
                  source={source}
                  xy={xy}
                />
              ))}
          {array(map.places).map((raw, i) => {
            const p = record(raw),
              at = array(p.at),
              vertices = array(p.points)
                .map((v) => {
                  const a = array(v)
                  return xy(number(a[0]), number(a[1])).join(',')
                })
                .join(' ')
            const [px, py] = xy(number(at[0]), number(at[1]))
            return (
              <g key={text(p.id) || i}>
                {vertices && <polygon points={vertices} />}
                <text x={px} y={py}>
                  {text(p.name)}
                </text>
              </g>
            )
          })}
          {devices
            .filter((d) => d.position.map === map.id)
            .flatMap((d) =>
              d.jobs
                .filter((job) => job.state !== 'terminal')
                .map((job) => {
                  const progress = record(job.navigation),
                    route = array(progress.route ?? progress.points),
                    target = array(progress.target)
                  return (
                    <g key={`${d.id}:${text(job.id)}`} aria-label={`${d.name} route`}>
                      {route.length > 0 && (
                        <polyline
                          points={[[d.position.x, d.position.y], ...route]
                            .map((p) => {
                              const a = array(p)
                              return xy(number(a[0]), number(a[1])).join(',')
                            })
                            .join(' ')}
                        />
                      )}
                      {target.length === 2 && (
                        <circle
                          cx={xy(number(target[0]), number(target[1]))[0]}
                          cy={xy(number(target[0]), number(target[1]))[1]}
                          r="1.5"
                        >
                          <title>{`${d.name} target`}</title>
                        </circle>
                      )}
                    </g>
                  )
                }),
            )}
          {points.length > 0 && <polyline points={points.map((p) => xy(...p).join(',')).join(' ')} />}
          {points.map((p) => {
            const [px, py] = xy(...p)
            return <circle key={`${px}-${py}`} cx={px} cy={py} r="1" />
          })}
        </svg>
        {mode && (
          <button
            type="button"
            className="mhs-map-pick-canvas"
            aria-label={t('pick')}
            onClick={(e) => {
              if (e.detail > 1) return
              const r = e.currentTarget.getBoundingClientRect()
              if (r.width > 0 && r.height > 0)
                add([
                  x0 + ((e.clientX - r.left) / r.width) * (x1 - x0),
                  y1 - ((e.clientY - r.top) / r.height) * (y1 - y0),
                ])
            }}
            onDoubleClick={finish}
          />
        )}
        {!mode &&
          devices
            .filter((d) => d.position.map === map.id)
            .map((d) => {
              const [px, py] = xy(number(d.position.x), number(d.position.y))
              return (
                <button
                  type="button"
                  key={d.id}
                  className="mhs-map-marker"
                  data-state={!d.online ? 'offline' : d.trust === 'trusted' ? 'online' : 'stale'}
                  style={{ left: `${px}%`, top: `${py}%` }}
                  onClick={() => openDevice(d.id)}
                >
                  {d.name} · {t(!d.online ? 'offline' : d.trust === 'trusted' ? 'online' : 'stale')}
                </button>
              )
            })}
      </div>
      {mode && (
        <div className="mhs-pick-controls">
          <label>
            {t('mapX')}
            <input type="number" value={x} onChange={(e) => setX(e.target.value)} />
          </label>
          <label>
            {t('mapY')}
            <input type="number" value={y} onChange={(e) => setY(e.target.value)} />
          </label>
          <Button
            disabled={x === '' || y === '' || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y))}
            onClick={() => add([Number(x), Number(y)])}
          >
            {t('addPoint')}
          </Button>
          {mode === 'polygon' && (
            <Button disabled={points.length < 3} onClick={finish}>
              {t('finish')}
            </Button>
          )}
          <Button onClick={onCancel}>{t('cancelPick')}</Button>
        </div>
      )}
    </section>
  )
}
