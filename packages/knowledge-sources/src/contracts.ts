import type { ServiceCapability, ServiceDef } from '@agnes/extension-api'
import { type Static, Type } from '@sinclair/typebox'

export const ROW = 'ext:agnes/knowledge-sources'
export const MAX_DOCUMENT_BYTES = 65536
export const MAX_EXCERPT_BYTES = 2048
const id = Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$' })
const binding = {
  id,
  workspaceRoot: Type.String({ minLength: 1, maxLength: 4096 }),
  sessionKeys: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
  }),
  enabled: Type.Boolean(),
}
export const ConfigSchema = Type.Object(
  {
    sources: Type.Array(
      Type.Union([
        Type.Object(
          { ...binding, kind: Type.Literal('local'), path: Type.String({ minLength: 1, maxLength: 512 }) },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            ...binding,
            kind: Type.Literal('synthetic-api'),
            revision: id,
            text: Type.String({ maxLength: MAX_DOCUMENT_BYTES }),
            available: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      ]),
      { maxItems: 16 },
    ),
  },
  { additionalProperties: false },
)
export const managedConfigSchema: ServiceDef['inputSchema'] = {
  type: 'object',
  properties: ConfigSchema.properties,
  required: ['sources'],
  additionalProperties: false,
}
export type Config = Static<typeof ConfigSchema>
export type Source = Config['sources'][number]
export const CitationSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    sourceId: id,
    kind: Type.Union([Type.Literal('local'), Type.Literal('synthetic-api')]),
    locator: Type.String({ maxLength: 512 }),
    revision: Type.String({ maxLength: 80 }),
    contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    excerptHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    excerptStart: Type.Integer({ minimum: 0, maximum: MAX_DOCUMENT_BYTES }),
    excerptLength: Type.Integer({ minimum: 0, maximum: MAX_EXCERPT_BYTES }),
    retrievedAt: Type.String({ maxLength: 32 }),
    trust: Type.Literal('untrusted'),
  },
  { additionalProperties: false },
)
export const HistorySchema = Type.Array(CitationSchema, { maxItems: 32 })
export type Citation = Static<typeof CitationSchema>
export type Status = 'current' | 'stale' | 'revoked' | 'unavailable'
export type Receipt = Citation & { status: Status }
export const emptyInput = Type.Object({}, { additionalProperties: false })
export const citationInput = Type.Object(
  { id: Type.String({ pattern: '^[a-f0-9]{64}$' }) },
  { additionalProperties: false },
)
export const queryInput = Type.Object(
  { sourceId: Type.Optional(id), query: Type.Optional(Type.String({ maxLength: 256 })) },
  { additionalProperties: false },
)
export const SERVICE_CAPABILITIES: ServiceCapability[] = [
  { name: 'knowledge.history', inputSchema: emptyInput },
  { name: 'knowledge.preview', inputSchema: citationInput },
].map((item) => ({
  name: item.name,
  inputSchema: {
    type: 'object' as const,
    properties: item.inputSchema.properties,
    required: item.inputSchema.required ?? [],
    additionalProperties: false as const,
  },
  kind: 'query' as const,
  outputSchema: {},
  timeoutMs: 10000,
  maxResultBytes: 65536,
}))
export const projectionCapability = (owner: string) => ({
  name: 'citations',
  inputEventTypes: [`x/${owner}/cited`],
  maxStateBytes: 65536,
})
