import { Fields } from './fields.js'
import type { Sample } from './media.js'
import { array, type Data, jsonText, number, record, text } from './model.js'
import { useMhs } from './react.js'

/** MOS points are interleaved IEEE754 float32 LE; field order is part of the frame. */
export function pointCloud(sample: Sample): [number, number, number][] {
  const fields = array(sample.data.fields),
    n = number(sample.data.n, -1),
    bytes = sample.bytes
  if (
    !bytes ||
    !Number.isInteger(n) ||
    n < 0 ||
    n > 1_000_000 ||
    fields.length < 3 ||
    fields.length > 16 ||
    bytes.length !== n * fields.length * 4
  )
    throw new Error('invalid-points')
  const indices = ['x', 'y', 'z'].map((key) => fields.indexOf(key))
  if (indices.some((i) => i < 0)) throw new Error('invalid-points-fields')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    out: [number, number, number][] = []
  for (let i = 0; i < n; i += Math.max(1, Math.ceil(n / 4096))) {
    const p = indices.map((j) => view.getFloat32((i * fields.length + j) * 4, true)) as [
      number,
      number,
      number,
    ]
    if (p.every(Number.isFinite)) out.push(p)
  }
  return out
}
export function Telemetry({
  kind,
  sample,
  source,
  history,
}: {
  kind: string
  sample: Sample
  source: Data
  history: readonly Data[]
}) {
  const { t } = useMhs()
  const data = sample.data
  if (kind === 'text' || kind === 'transcript') {
    // A partial transcript replaces the previous partial utterance.
    const lines = history
      .reduce<Data[]>((out, line) => [...(out.at(-1)?.final === false ? out.slice(0, -1) : out), line], [])
      .slice(-30)
    return (
      <div role="log">
        {lines.map((line) => (
          <p key={number(line._id)} data-partial={line.final === false}>
            {text(line.text)}
          </p>
        ))}
      </div>
    )
  }
  if (kind === 'points') {
    let points: [number, number, number][]
    try {
      points = pointCloud(sample)
    } catch {
      return <p role="status">{t('invalidPoints')}</p>
    }
    const span = Math.max(1, ...points.flatMap(([x, y]) => [Math.abs(x), Math.abs(y)]))
    return (
      <svg viewBox={`${-span} ${-span} ${span * 2} ${span * 2}`} role="img" aria-label={t('pointCloud')}>
        {points.map(([x, y, z], i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Point slots are replaced together on each frame and hold no child state.
          <circle key={i} cx={x} cy={-y} r={span / 150}>
            <title>{`x ${x}, y ${y}, z ${z}`}</title>
          </circle>
        ))}
      </svg>
    )
  }
  if (kind === 'detections')
    return (
      <svg viewBox={`0 0 ${number(data.w, 1)} ${number(data.h, 1)}`} role="img" aria-label={t('detections')}>
        {array(data.items).map((raw) => {
          const d = record(raw),
            b = array(d.box)
          return (
            <g key={`${text(d.label)}:${jsonText(d.box)}:${number(d.track)}`}>
              <rect
                x={number(b[0])}
                y={number(b[1])}
                width={Math.max(0, number(b[2]) - number(b[0]))}
                height={Math.max(0, number(b[3]) - number(b[1]))}
              />
              <text
                x={number(b[0])}
                y={number(b[1])}
              >{`${text(d.label)} ${Math.round(number(d.conf) * 100)}%`}</text>
              <title>{jsonText(d)}</title>
            </g>
          )
        })}
      </svg>
    )
  if (kind === 'pose' || kind === 'odometry' || kind === 'world') {
    const poses = kind === 'world' ? array(data.entities).map(record) : [data]
    const trail = history.filter((p) => typeof p.x === 'number' && typeof p.y === 'number')
    const span =
      Math.max(5, ...[...poses, ...trail].flatMap((p) => [Math.abs(number(p.x)), Math.abs(number(p.y))])) + 2
    return (
      <>
        <p>
          {text(data.map)} {data.ok === false ? t('unlocalized') : ''}
        </p>
        <svg
          viewBox={`${-span} ${-span} ${span * 2} ${span * 2}`}
          role="img"
          aria-label={t(kind === 'world' ? 'worldEntities' : 'positionHeading')}
        >
          <polyline points={trail.map((p) => `${number(p.x)},${-number(p.y)}`).join(' ')} />
          {poses.map((p) => (
            <g
              key={text(p.device) || kind}
              transform={`translate(${number(p.x)},${-number(p.y)}) rotate(${-number(p.yaw)})`}
            >
              <path d="M 2 0 L -1 -1 L -1 1 Z" />
              <title>{text(p.device) || jsonText(p)}</title>
            </g>
          ))}
        </svg>
        <Fields
          fields={Object.fromEntries(
            ['x', 'y', 'yaw', 'v', 'w']
              .filter((k) => k in data)
              .map((k) => [k, { unit: k === 'yaw' ? '°' : k === 'w' ? '°/s' : k === 'v' ? 'm/s' : 'm' }]),
          )}
          values={data}
        />
      </>
    )
  }
  if (kind === 'imu')
    return (
      <>
        <Fields
          fields={{ accel: { unit: 'm/s²' }, gyro: { unit: '°/s' }, rpy: { unit: '°' } }}
          values={data}
        />
        <svg viewBox="-2 -2 4 4" role="img" aria-label={t('imuOrientation')}>
          <path transform={`rotate(${-number(array(data.rpy)[2])})`} d="M 1 0 L -1 -0.5 L -1 0.5 Z" />
        </svg>
      </>
    )
  if (kind === 'gnss')
    return (
      <>
        <p role="status">{`GNSS ${text(data.fix)} · ±${number(data.acc_m)} m`}</p>
        <Fields fields={{ lat: { unit: '°' }, lon: { unit: '°' }, alt: { unit: 'm' } }} values={data} />
      </>
    )
  const fields = record(source.fields),
    first = Object.keys(fields).find((k) => typeof data[k] === 'number')
  const values = first ? history.map((d) => number(d[first])) : []
  const lo = Math.min(...values),
    span = Math.max(...values) - lo || 1
  return (
    <>
      <Fields
        fields={
          Object.keys(fields).length ? fields : Object.fromEntries(Object.keys(data).map((key) => [key, {}]))
        }
        values={data}
      />
      {kind === 'values' && values.length > 1 && (
        <svg viewBox="0 0 100 30" role="img" aria-label={t('trend')}>
          <polyline
            points={values
              .map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - lo) / span) * 26}`)
              .join(' ')}
          />
        </svg>
      )}
    </>
  )
}
