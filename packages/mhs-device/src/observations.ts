import { type Static, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Json, Source } from './schema.js'
import { fieldValue, MhsError, object } from './validation.js'

const n = Type.Number()
const vec3 = Type.Tuple([n, n, n])
const size = {
  w: Type.Integer({ minimum: 1, maximum: 32768 }),
  h: Type.Integer({ minimum: 1, maximum: 32768 }),
}
export const dataSchemas = {
  image: Type.Object(size),
  video: Type.Object({ ...size, key: Type.Boolean() }),
  scan: Type.Object({
    angle_min: n,
    angle_inc: n,
    ranges: Type.Array(Type.Union([Type.Number({ minimum: 0 }), Type.Null()]), { maxItems: 65536 }),
  }),
  points: Type.Object({
    n: Type.Integer({ minimum: 0, maximum: 1000000 }),
    fields: Type.Array(Type.String(), { minItems: 3, maxItems: 16 }),
  }),
  audio: Type.Object({
    rate: Type.Integer({ minimum: 1, maximum: 384000 }),
    channels: Type.Integer({ minimum: 1, maximum: 8 }),
    speaking: Type.Optional(Type.Boolean()),
  }),
  imu: Type.Object({ accel: vec3, gyro: vec3, rpy: Type.Optional(vec3) }),
  odometry: Type.Object({ x: n, y: n, yaw: n, v: n, w: n }),
  gnss: Type.Object({
    lat: Type.Number({ minimum: -90, maximum: 90 }),
    lon: Type.Number({ minimum: -180, maximum: 180 }),
    alt: Type.Optional(n),
    fix: Type.Union(['none', '2d', '3d', 'rtk'].map((v) => Type.Literal(v))),
    acc_m: Type.Number({ minimum: 0 }),
  }),
  text: Type.Object({ text: Type.String({ maxLength: 16384 }) }),
  detections: Type.Object({
    ...size,
    items: Type.Array(
      Type.Object({
        label: Type.String({ maxLength: 256 }),
        conf: Type.Number({ minimum: 0, maximum: 1 }),
        box: Type.Tuple([n, n, n, n]),
        track: Type.Optional(Type.Integer()),
        bearing: Type.Optional(n),
        dist: Type.Optional(n),
      }),
      { maxItems: 1024 },
    ),
  }),
  pose: Type.Object({
    map: Type.String({ maxLength: 64 }),
    x: n,
    y: n,
    yaw: n,
    ok: Type.Boolean(),
    cov: Type.Optional(Type.Array(n, { minItems: 9, maxItems: 9 })),
  }),
  grid: Type.Object({
    id: Type.String(),
    resolution: Type.Number({ exclusiveMinimum: 0 }),
    origin: Type.Tuple([n, n]),
  }),
  transcript: Type.Object({
    text: Type.String({ maxLength: 16384 }),
    final: Type.Boolean(),
    start: n,
    end: n,
    lang: Type.Optional(Type.String()),
    speaking: Type.Optional(Type.Boolean()),
  }),
  world: Type.Object({
    map: Type.String(),
    entities: Type.Array(Type.Object({ device: Type.String(), x: n, y: n, yaw: n, ok: Type.Boolean() }), {
      maxItems: 512,
    }),
  }),
}
export type Pose = Static<typeof dataSchemas.pose>
export function validateObservation(source: Source, data: Json, bytes?: Uint8Array, mime?: string): void {
  const schema = dataSchemas[source.kind as keyof typeof dataSchemas]
  if (schema && !Value.Check(schema, data)) throw new MhsError('invalid-observation')
  if (source.kind === 'values' || source.kind === 'switch') {
    for (const [key, value] of Object.entries(object(data))) {
      const field = source.fields?.[key]
      if (!field || fieldValue(field, value) !== value) throw new MhsError('invalid-observation')
    }
  }
  if (['image', 'video', 'audio', 'points', 'grid'].includes(source.kind) && !bytes)
    throw new MhsError('missing-binary')
  if (source.kind === 'pose') {
    const cov = object(data).cov
    if (Array.isArray(cov) && [0, 4, 8].some((i) => Number(cov[i]) < 0))
      throw new MhsError('invalid-covariance')
  }
  if (source.kind === 'image' && !['image/png', 'image/jpeg'].includes(mime ?? ''))
    throw new MhsError('invalid-image')
  if (source.kind === 'audio' && bytes) {
    const audio = object(data)
    if (bytes.length % (Number(audio.channels) * 2) !== 0) throw new MhsError('invalid-pcm')
  }
  if (source.kind === 'points' && bytes) {
    const points = object(data)
    if (bytes.length !== Number(points.n) * (points.fields as string[]).length * 4)
      throw new MhsError('invalid-points')
  }
}
