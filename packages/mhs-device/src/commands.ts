import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { MhsError } from './validation.js'

const params = Type.Record(Type.String(), Type.Unknown())
export const commandRequestSchema = Type.Object({
  jsonrpc: Type.Literal('2.0'),
  id: Type.String({ minLength: 1, maxLength: 256 }),
  method: Type.String({
    pattern: '^mhs/(register|call|set|stop|cancel|pause|resume|configure|keyframe|time|ping)$',
  }),
  params,
})
export const commandNotificationSchema = Type.Union([
  Type.Object({
    jsonrpc: Type.Literal('2.0'),
    method: Type.Literal('mhs/state'),
    params: Type.Object({ t: Type.Number(), values: params }),
  }),
  Type.Object({
    jsonrpc: Type.Literal('2.0'),
    method: Type.Literal('mhs/progress'),
    params: Type.Object({ call: Type.String(), data: Type.Optional(Type.Unknown()) }),
  }),
  Type.Object({
    jsonrpc: Type.Literal('2.0'),
    method: Type.Literal('mhs/result'),
    params: Type.Object({
      call: Type.String(),
      status: Type.Union(['done', 'error', 'interrupted', 'unknown'].map((v) => Type.Literal(v))),
      reason: Type.Optional(Type.String({ maxLength: 64 })),
      detail: Type.Optional(Type.String({ maxLength: 4096 })),
      data: Type.Optional(Type.Unknown()),
    }),
  }),
])
export const commandResponseSchema = Type.Object({
  jsonrpc: Type.Literal('2.0'),
  id: Type.String(),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Object({ code: Type.Integer(), message: Type.String() })),
})
export function validateCommand(message: unknown): void {
  if (
    ![commandRequestSchema, commandNotificationSchema, commandResponseSchema].some((schema) =>
      Value.Check(schema, message),
    )
  )
    throw new MhsError('invalid-command')
}
