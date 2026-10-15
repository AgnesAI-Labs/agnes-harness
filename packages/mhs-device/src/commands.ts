import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { DEVICE_ID, NAME, observationSchema, registrationSchema } from './schema.js'
import { MhsError } from './validation.js'

const params = Type.Record(Type.String(), Type.Unknown())
const id = Type.String({ minLength: 1, maxLength: 256 })
const name = Type.String({ pattern: NAME })
const request = (method: string, input: ReturnType<typeof Type.Object>) =>
  Type.Object({ jsonrpc: Type.Literal('2.0'), id, method: Type.Literal(method), params: input })
export const commandRequestSchema = Type.Union([
  request('mhs/register', registrationSchema),
  request(
    'mhs/call',
    Type.Object({
      name: Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }),
      arguments: params,
      meta: Type.Optional(params),
    }),
  ),
  request('mhs/set', Type.Object({ values: params })),
  request('mhs/stop', Type.Object({})),
  ...['cancel', 'pause', 'resume'].map((method) => request(`mhs/${method}`, Type.Object({ call: id }))),
  request(
    'mhs/configure',
    Type.Object({
      sources: Type.Record(
        name,
        Type.Object({
          on: Type.Boolean(),
          hz: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          bitrate_kbps: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          size: Type.Optional(Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })])),
        }),
        { additionalProperties: false },
      ),
    }),
  ),
  request('mhs/keyframe', Type.Object({ source: name })),
  request('mhs/time', Type.Object({})),
  request('mhs/ping', Type.Object({})),
])
export const commandNotificationSchema = Type.Union([
  Type.Object({
    jsonrpc: Type.Literal('2.0'),
    method: Type.Literal('mhs/clip-received'),
    params: Type.Object({ id }),
  }),
  Type.Object({
    jsonrpc: Type.Literal('2.0'),
    method: Type.Literal('mhs/state'),
    params: Type.Object({ t: Type.Number(), values: params }),
  }),
  Type.Object({
    jsonrpc: Type.Literal('2.0'),
    method: Type.Literal('mhs/progress'),
    params: Type.Object({ call: id, data: Type.Optional(Type.Unknown()) }),
  }),
  Type.Object({
    jsonrpc: Type.Literal('2.0'),
    method: Type.Literal('mhs/result'),
    params: Type.Object({
      call: id,
      status: Type.Union(['done', 'error', 'interrupted', 'unknown'].map((v) => Type.Literal(v))),
      reason: Type.Optional(Type.String({ maxLength: 64 })),
      detail: Type.Optional(Type.String({ maxLength: 4096 })),
      data: Type.Optional(Type.Unknown()),
    }),
  }),
])
export const commandResponseSchema = Type.Union([
  Type.Object({ jsonrpc: Type.Literal('2.0'), id, result: Type.Unknown() }),
  Type.Object({
    jsonrpc: Type.Literal('2.0'),
    id,
    error: Type.Object({ code: Type.Integer(), message: Type.String() }),
  }),
])
export const nerveMessageSchema = Type.Union([
  observationSchema,
  Type.Object({ type: Type.Literal('hello'), device: Type.String({ pattern: DEVICE_ID }) }),
  Type.Object({
    type: Type.Literal('manual'),
    axes: Type.Record(name, Type.Number(), { additionalProperties: false }),
  }),
  Type.Object({
    type: Type.Literal('clip'),
    id,
    rate: Type.Integer({ minimum: 1, maximum: 384000 }),
    channels: Type.Integer({ minimum: 1, maximum: 8 }),
  }),
])
export function validateCommand(message: unknown): void {
  if (
    ![commandRequestSchema, commandNotificationSchema, commandResponseSchema].some((schema) =>
      Value.Check(schema, message),
    )
  )
    throw new MhsError('invalid-command')
}
export function validateNerveMessage(message: unknown): void {
  if (!Value.Check(nerveMessageSchema, message)) throw new MhsError('invalid-nerve-message')
}
