import type { PluginProjectionDef } from '@agnes/extension-api'
import { Value } from '@sinclair/typebox/value'
import { type Citation, CitationSchema, HistorySchema, projectionCapability } from './contracts.js'

export const createCitationProjection = (owner: string): PluginProjectionDef<{ citations: Citation[] }> => ({
  ...projectionCapability(owner),
  stateVersion: 1,
  stateSchema: {
    type: 'object',
    required: ['citations'],
    properties: { citations: HistorySchema },
    additionalProperties: false,
  },
  init: () => ({ citations: [] }),
  apply(state, event) {
    if (event.type !== `x/${owner}/cited`) return { citations: [...state.citations] }
    if (!Value.Check(CitationSchema, event.data)) return { citations: [...state.citations] }
    const citation = event.data
    return { citations: [...state.citations.filter((row) => row.id !== citation.id), citation].slice(-32) }
  },
})
