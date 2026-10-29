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
/** The account model an unset slot follows. */
export const AutomaticModelTarget = Type.Object(
  {
    accountId: Type.String({ minLength: 1, maxLength: 48 }),
    route: AuxiliaryModelTarget.properties.route,
    model: AuxiliaryModelTarget.properties.model,
  },
  { additionalProperties: false },
)
export type AutomaticModelTarget = Static<typeof AutomaticModelTarget>
export const ModelSlotsSnapshot = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    slots: AuxiliaryModelSlots,
    /**
     * Read-only. `auto.fast` is present while the fast slot is unset and the default account has a
     * model to follow; a save accepts and ignores it. The verifier slot is never automatic.
     */
    auto: Type.Optional(
      Type.Object({ fast: Type.Optional(AutomaticModelTarget) }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
)
export type ModelSlotsSnapshot = Static<typeof ModelSlotsSnapshot>
