import { type Static, Type } from '@sinclair/typebox'

/** Explicit auxiliary defaults; null removes a preset's slot without borrowing primary. */
export const AuxiliaryModelTarget = Type.Object(
  {
    route: Type.String({ minLength: 1, maxLength: 256, pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$' }),
    model: Type.String({ minLength: 1, maxLength: 256, pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$' }),
  },
  { additionalProperties: false },
)
export const AuxiliaryModelSlots = Type.Object(
  {
    fast: Type.Optional(Type.Union([AuxiliaryModelTarget, Type.Null()])),
    verifier: Type.Optional(Type.Union([AuxiliaryModelTarget, Type.Null()])),
  },
  { additionalProperties: false },
)
export type AuxiliaryModelSlots = Static<typeof AuxiliaryModelSlots>
export const ModelSlotsSnapshot = Type.Object(
  { revision: Type.Integer({ minimum: 0 }), slots: AuxiliaryModelSlots },
  { additionalProperties: false },
)
export type ModelSlotsSnapshot = Static<typeof ModelSlotsSnapshot>
