import { type Static, Type } from '@sinclair/typebox'

export const DEVICE_ID = '^[a-z0-9][a-z0-9-]{0,31}$'
export const NAME = '^[a-z][a-z0-9_]{0,31}$'
const name = Type.String({ pattern: NAME })
const finite = Type.Number()
const vec2 = Type.Tuple([finite, finite])
const vec3 = Type.Tuple([finite, finite, finite])
const hints = Type.Record(Type.String(), Type.Unknown())
const scalar = Type.Union([finite, Type.String({ maxLength: 4096 }), Type.Boolean()])
export const fieldSchema = Type.Object({
  type: Type.Union(['number', 'integer', 'string', 'boolean'].map((v) => Type.Literal(v))),
  min: Type.Optional(finite),
  max: Type.Optional(finite),
  enum: Type.Optional(Type.Array(scalar, { maxItems: 128 })),
  writable: Type.Optional(Type.Boolean()),
  role: Type.Optional(name),
  unit: Type.Optional(Type.String({ maxLength: 32 })),
  description: Type.Optional(Type.String({ maxLength: 1024 })),
  of: Type.Optional(name),
  ui: Type.Optional(hints),
  alert: Type.Optional(Type.Object({ warn: finite, bad: finite, below: Type.Optional(Type.Boolean()) })),
})
export const sourceSchema = Type.Object({
  id: name,
  kind: Type.String({
    pattern:
      '^(image|video|scan|points|audio|imu|odometry|gnss|values|switch|text|detections|pose|grid|transcript|world|x_[a-z0-9_]+)$',
  }),
  description: Type.String({ maxLength: 1024 }),
  hz: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1000 })),
  of: Type.Optional(name),
  switchable: Type.Optional(Type.Boolean()),
  default: Type.Optional(Type.Boolean()),
  mime: Type.Optional(Type.Union([Type.Literal('image/png'), Type.Literal('image/jpeg')])),
  fields: Type.Optional(Type.Record(name, fieldSchema, { additionalProperties: false })),
  codec: Type.Optional(Type.Literal('h264')),
  gop_s: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2 })),
  encoding: Type.Optional(Type.String()),
  size: Type.Optional(vec2),
  sizes: Type.Optional(Type.Array(vec2, { maxItems: 32 })),
  fov_deg: Type.Optional(vec2),
  range_m: Type.Optional(vec2),
  bitrate_kbps: Type.Optional(vec2),
  mount: Type.Optional(Type.Object({ xyz: vec3, rpy: vec3 })),
  model: Type.Optional(Type.Object({ name: Type.String(), version: Type.String() })),
  labels: Type.Optional(Type.Array(Type.String(), { maxItems: 256 })),
  rate: Type.Optional(Type.Integer({ minimum: 1, maximum: 384000 })),
  channels: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  max_error_m: Type.Optional(finite),
  ui: Type.Optional(hints),
})
export const toolSchema = Type.Object({
  name: Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }),
  description: Type.String({ maxLength: 4096 }),
  inputSchema: Type.Record(Type.String(), Type.Unknown()),
  uses: Type.Optional(Type.Array(name, { maxItems: 64, uniqueItems: true })),
  motion: Type.Optional(Type.Boolean()),
  readOnly: Type.Optional(Type.Boolean()),
  pausable: Type.Optional(Type.Boolean()),
  needs: Type.Optional(Type.Array(name, { maxItems: 64 })),
  ui: Type.Optional(hints),
  timeout: Type.Number({ exclusiveMinimum: 0, maximum: 86400 }),
})
export const mapSchema = Type.Object({
  id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }),
  name: Type.Optional(Type.String({ maxLength: 128 })),
  bounds: Type.Optional(Type.Tuple([finite, finite, finite, finite])),
  anchor: Type.Optional(hints),
  places: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }),
        name: Type.String({ maxLength: 128 }),
        at: Type.Optional(vec2),
        yaw: Type.Optional(finite),
        points: Type.Optional(Type.Array(vec2, { minItems: 3, maxItems: 256 })),
        description: Type.Optional(Type.String({ maxLength: 1024 })),
      }),
      { maxItems: 256 },
    ),
  ),
})
export const registrationSchema = Type.Object({
  protocol: Type.Literal('mhs/v1'),
  profile: Type.Optional(hints),
  ui: Type.Optional(hints),
  device: Type.Object({
    id: Type.String({ pattern: DEVICE_ID }),
    kind: Type.String({ minLength: 1, maxLength: 40 }),
    name: Type.Optional(Type.String({ maxLength: 40 })),
    mobile: Type.Optional(Type.Boolean()),
    model: Type.Optional(Type.String({ maxLength: 40 })),
    vendor: Type.Optional(Type.String({ maxLength: 40 })),
    firmware: Type.Optional(Type.String({ maxLength: 40 })),
    radius: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  resources: Type.Optional(
    Type.Record(name, Type.Union([Type.Literal('reject'), Type.Literal('queue')]), {
      additionalProperties: false,
    }),
  ),
  tools: Type.Optional(Type.Array(toolSchema, { maxItems: 64 })),
  state: Type.Optional(Type.Record(name, fieldSchema, { additionalProperties: false })),
  sources: Type.Optional(Type.Array(sourceSchema, { maxItems: 64 })),
  maps: Type.Optional(Type.Array(mapSchema, { maxItems: 32 })),
  localization: Type.Optional(Type.Union(['none', 'fixed', 'self', 'external'].map((v) => Type.Literal(v)))),
  placement: Type.Optional(Type.Object({ map: Type.String(), x: finite, y: finite, yaw: finite })),
  manual: Type.Optional(
    Type.Object({
      axes: Type.Array(
        Type.Object({
          id: name,
          min: finite,
          max: finite,
          role: Type.Optional(name),
          keys: Type.Optional(
            Type.Tuple([
              Type.String({ minLength: 1, maxLength: 32 }),
              Type.String({ minLength: 1, maxLength: 32 }),
            ]),
          ),
          unit: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
        }),
        { minItems: 1, maxItems: 16 },
      ),
      rate_hz: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100 })),
      deadman_s: Type.Number({ exclusiveMinimum: 0, maximum: 2 }),
    }),
  ),
})
export const observationSchema = Type.Object({
  type: Type.Literal('data'),
  source: name,
  seq: Type.Integer({ minimum: 0 }),
  t: finite,
  data: Type.Optional(Type.Unknown()),
  bytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 16777216 })),
  mime: Type.Optional(Type.String({ maxLength: 64 })),
})
export type Registration = Static<typeof registrationSchema>
export type DeviceTool = Static<typeof toolSchema>
export type Field = Static<typeof fieldSchema>
export type Source = Static<typeof sourceSchema>
export type Observation = Static<typeof observationSchema>
export type DeviceMap = Static<typeof mapSchema>
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type ResourceHolder = { call: string; job?: string; tool: string; caller?: string } | { manual: true }
export type Outcome = {
  holder?: ResourceHolder
  needs?: string[]
  status: 'done' | 'error' | 'interrupted' | 'rejected' | 'unknown'
  reason?: string
  detail?: string
  data?: Json
  notes?: string[]
}
