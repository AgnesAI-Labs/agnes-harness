import { type Static, Type } from '@sinclair/typebox'
import { JsonValue } from '../gen/ts/session-v1.js'

export const SessionToolsParams = Type.Object(
  { sessionId: Type.String({ minLength: 1, maxLength: 1024 }) },
  { additionalProperties: false },
)
export const SessionToolsResult = Type.Object(
  {
    sessionId: Type.String(),
    tools: Type.Array(
      Type.Object(
        {
          name: Type.String(),
          description: Type.String(),
          parameters: JsonValue,
          source: Type.String(),
          deferred: Type.Boolean(),
          readOnly: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    resources: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          kind: Type.String(),
          name: Type.String(),
          description: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
export type SessionToolsResult = Static<typeof SessionToolsResult>
