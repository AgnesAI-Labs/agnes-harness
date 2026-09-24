import type { TSchema } from '@sinclair/typebox'
import * as H from '../gen/ts/hooks.js'
import { type ValidationResult, validateAgainst } from './validate.js'

export const HOOK_EVENTS = [
  'session_start',
  'resources_discover',
  'before_step',
  'context',
  'before_request',
  'before_provider_headers',
  'request_error',
  'tool_call',
  'tool_result',
  'turn_stopping',
  'approval_request',
  'before_compact',
  'compact',
  'subagent_start',
  'subagent_end',
  'format_deviation',
  'shutdown',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]
export type HookTableRow = {
  mode: 'emit' | 'parallel' | 'serial' | 'waterfall'
  category: 'observe' | 'transform' | 'directive'
  failPolicy: 'open' | 'closed'
  timeoutMs: number
  replayOnResume: boolean
}

/**
 * The five-tuple table, read out of the schema document rather than restated here. It is a data
 * source of truth: the extension host and the hooks runner both read it and nothing else pins it,
 * so a wrong timeout or a wrong failPolicy would otherwise ship in silence.
 */
export const HOOK_TABLE: Record<HookEvent, HookTableRow> = H.X_AGNES_HOOK_TABLE
const IO = H.X_AGNES_HOOK_IO as Record<HookEvent, readonly [string, string]>

// Both tables are typed as Record over a literal union, which is a mapped type: the type checker
// believes every key is present even when the generated table is a row short. Assert it once, at
// load, so a truncated table is a startup failure rather than an undefined at the call site.
for (const e of HOOK_EVENTS) {
  const row = HOOK_TABLE[e] as HookTableRow | undefined
  if (!row) throw new Error(`hooks.json is missing the table row for ${e}`)
  const legal =
    (row.category === 'observe' && (row.mode === 'emit' || row.mode === 'parallel')) ||
    (row.category === 'transform' && row.mode === 'waterfall') ||
    (row.category === 'directive' && row.mode === 'serial')
  if (!legal) throw new Error(`hooks.json declares an illegal mode/category pair for ${e}`)
  const pair = IO[e] as readonly [string, string] | undefined
  if (pair?.length !== 2) throw new Error(`hooks.json is missing the payload/return pair for ${e}`)
  for (const name of pair)
    if (!(name in (H as unknown as Record<string, unknown>)))
      throw new Error(`hooks.json names a definition that does not exist: ${name}`)
}

export function isHookEvent(s: string): s is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(s)
}

export function validateHook(
  event: HookEvent,
  side: 'payload' | 'return',
  x: unknown,
): ValidationResult<unknown> {
  const name = IO[event][side === 'payload' ? 0 : 1]
  return validateAgainst((H as unknown as Record<string, TSchema>)[name] as TSchema, x)
}
