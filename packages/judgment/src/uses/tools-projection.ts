import { createHash } from 'node:crypto'
import type { PluginProjectionDef } from '@agnes/extension-api'
import { object } from '../questions.js'

export const TOOL_SESSION = 'tools.session'
export type ToolSession = { sessionHash: string | null; child: boolean }
export const sessionHash = (key: string) => createHash('sha256').update(key).digest('hex')
export function createToolsProjection(): PluginProjectionDef<ToolSession> {
  return {
    name: TOOL_SESSION,
    stateVersion: 1,
    inputEventTypes: ['session/start'],
    maxStateBytes: 256,
    stateSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionHash', 'child'],
      properties: {
        sessionHash: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-f0-9]{64}$' }] },
        child: { type: 'boolean' },
      },
    },
    init: () => ({ sessionHash: null, child: true }),
    apply(state, event) {
      if (event.type !== 'session/start' || event.origin !== 'system' || event.trust !== 'trusted')
        return state
      const data = event.data
      if (!object(data) || typeof data.key !== 'string' || !data.key || data.key.length > 512)
        return { sessionHash: null, child: true }
      return {
        sessionHash: sessionHash(data.key),
        child: Object.hasOwn(data, 'parent') || Object.hasOwn(data, 'delegation'),
      }
    },
  }
}
