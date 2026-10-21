import { type Static, Type } from '@sinclair/typebox'

/** Point-in-time verification of the hash-protected history, never an external signature. */
export const SessionIntegrityStatus = Type.Object(
  {
    state: Type.Union([
      Type.Literal('verifying'),
      Type.Literal('verified'),
      Type.Literal('failed'),
      Type.Literal('stopped'),
    ]),
    verifiedThroughSeq: Type.Integer({ minimum: 0 }),
    lastSeq: Type.Integer({ minimum: 0 }),
    legacyThroughSeq: Type.Integer({ minimum: 0 }),
    verifiedAtMs: Type.Optional(Type.Number({ minimum: 0 })),
    failureSeq: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
)
export type SessionIntegrityStatus = Static<typeof SessionIntegrityStatus>

export const SessionIntegrityParams = Type.Object(
  {
    sessionId: Type.String({ minLength: 1, maxLength: 1024 }),
    verify: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)
export type SessionIntegrityParams = Static<typeof SessionIntegrityParams>
