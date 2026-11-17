import { createHash } from 'node:crypto'
import { type PluginProjectionDef, TOOL_NAME_PATTERN } from '@agnes/extension-api'
import { object } from '../questions.js'
export const RULES = 'rules.reminders'
export type RulesState = { sessionHash: string | null; child: boolean; identities: string[] }
export const sessionHash = (key: string): string => createHash('sha256').update(key).digest('hex')
export const ruleIdentity = (session: string, version: string, tool: string): string =>
  sessionHash(JSON.stringify([session, version, tool]))
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' }
export function createRulesProjection(owner: string): PluginProjectionDef<RulesState> {
  const marker = `x/${owner}/rules.reminded`
  return {
    name: RULES,
    stateVersion: 1,
    stateSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionHash', 'child', 'identities'],
      properties: {
        sessionHash: { anyOf: [hash, { type: 'null' }] },
        child: { type: 'boolean' },
        identities: { type: 'array', maxItems: 2048, items: hash },
      },
    },
    inputEventTypes: ['session/start', marker],
    maxStateBytes: 150000,
    init: () => ({ sessionHash: null, child: false, identities: [] }),
    apply(state, event) {
      const data = event.data
      if (
        event.type === 'session/start' &&
        event.origin === 'system' &&
        event.trust === 'trusted' &&
        object(data)
      ) {
        const key = typeof data.key === 'string' && data.key.length ? sessionHash(data.key) : null
        const child = ['parent', 'delegation', 'fork'].some((field) => Object.hasOwn(data, field))
        if (key === state.sessionHash && child === state.child) return state
        return { sessionHash: key, child, identities: [] }
      }
      if (
        event.type !== marker ||
        event.origin !== `ext:${owner}` ||
        !state.sessionHash ||
        state.child ||
        !object(data) ||
        Object.keys(data).length !== 3 ||
        typeof data.rulesVersion !== 'string' ||
        !/^[a-f0-9]{64}$/.test(data.rulesVersion) ||
        typeof data.tool !== 'string' ||
        !TOOL_NAME_PATTERN.test(data.tool) ||
        data.identity !== ruleIdentity(state.sessionHash, data.rulesVersion, data.tool) ||
        state.identities.includes(data.identity) ||
        state.identities.length >= 2048
      )
        return state
      return { ...state, identities: [...state.identities, data.identity] }
    },
  }
}
