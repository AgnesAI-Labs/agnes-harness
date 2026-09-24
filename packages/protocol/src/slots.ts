import type { TSchema } from '@sinclair/typebox'
import * as Sl from '../gen/ts/slots.js'
import { type ValidationResult, validateAgainst } from './validate.js'

// These are the four UI slots an extension may fill. They are deliberately not called SLOT_NAMES:
// that name is already taken by the seven model slots on src/provider.ts, which core and host both
// consume. Two closed sets under one name on the root surface would not even compile.
export const UI_SLOT_NAMES = ['tool.card.inline', 'sidebar.action', 'status.line', 'notification'] as const
export type UiSlotName = (typeof UI_SLOT_NAMES)[number]
export type UiSlotTableRow = {
  // Every slot is `multi` today. The value domain keeps `single` open for whoever needs it, and
  // whoever introduces the first one owes the take-one logic in the UI projection and its tests:
  // nothing downstream branches on this field yet.
  cardinality: 'single' | 'multi'
  order: number
  surfaces: ReadonlyArray<'tui' | 'web' | 'channel'>
  failPolicy: 'open' | 'closed'
  trigger: ReadonlyArray<'tool_result' | 'turn_end' | 'tick'>
  payload: string
}
export const UI_SLOT_TABLE: Record<UiSlotName, UiSlotTableRow> = Sl.X_AGNES_SLOT_TABLE

/**
 * The size ceiling for one slot payload, in bytes. This package publishes the number and does not
 * enforce it: the truncation points are the extension host when it accepts a fill and the UI
 * projection when it renders one, neither of which lives here. Reading this constant is not the
 * same as being protected by it.
 */
export const UI_SLOT_MAX_BYTES: number = Sl.X_AGNES_MAX_BYTES

export function validateSlotPayload(slot: UiSlotName, x: unknown): ValidationResult<unknown> {
  const row = UI_SLOT_TABLE[slot] as UiSlotTableRow | undefined
  if (!row) throw new Error(`slots.json is missing the table row for ${slot}`)
  const schema = (Sl as unknown as Record<string, TSchema>)[row.payload] as TSchema | undefined
  if (!schema) throw new Error(`slots.json names a payload definition that does not exist: ${row.payload}`)
  return validateAgainst(schema, x)
}
