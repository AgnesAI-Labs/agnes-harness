import { Value } from '@sinclair/typebox/value'
import { type HarnessMeta, HarnessMeta as HarnessMetaSchema } from '../gen/ts/agnes-v1.js'
import { META_KEY } from './constants.js'

export function getHarnessMeta(msg: { _meta?: Record<string, unknown> }): HarnessMeta | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined
  const raw = msg._meta?.[META_KEY]
  return Value.Check(HarnessMetaSchema, raw) ? raw : undefined
}

export function setHarnessMeta<T extends object>(
  msg: T,
  meta: HarnessMeta,
): T & { _meta: Record<string, unknown> } {
  const existing = ((msg as { _meta?: Record<string, unknown> })._meta ?? {}) as Record<string, unknown>
  return { ...msg, _meta: { ...existing, [META_KEY]: meta } }
}
