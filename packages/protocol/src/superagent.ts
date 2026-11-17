import { Type } from '@sinclair/typebox'

/** Private bundled Superagent capability: the current service supplies its own roster. */
export const SuperagentSessionUpgradeParams = Type.Object(
  {
    integrity: Type.String({ minLength: 1, maxLength: 256 }),
    incarnation: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
)

export const SuperagentSessionUpgradeResult = Type.Object(
  { sessionIds: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { uniqueItems: true }) },
  { additionalProperties: false },
)
