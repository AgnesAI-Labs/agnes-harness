import type { RouteDecl } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { apisProfileModels } from '../src/local/methods/agnes.js'

const chat = {
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'gw',
  baseUrl: 'https://gw.invalid/v1',
  reasoning: true,
  thinkingLevelMap: { high: 'high' },
  input: ['text' as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
  toolCallFormats: ['native' as const],
  thinkingReplay: 'native' as const,
  contract_id: null,
}
const ROUTES: RouteDecl[] = [
  { route: 'gw', api: 'openai-completions', baseUrl: 'https://gw.invalid/v1', models: [chat] },
  {
    route: 'jev',
    api: 'typesafe-systemone',
    baseUrl: 'https://api.typesafe.ai/v1',
    models: [
      {
        id: 'jev-1.13.0',
        name: 'Jev',
        api: 'typesafe-systemone',
        route: 'jev',
        baseUrl: 'https://api.typesafe.ai/v1',
        kind: 'decision',
        contextWindow: 64000,
        cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  },
]

describe('apis.list profile models', () => {
  it('lists chat models with their thinking fields and never a decision model', () => {
    expect(apisProfileModels(ROUTES)).toEqual([
      { route: 'gw', id: 'm1', reasoning: true, thinkingLevelMap: { high: 'high' } },
    ])
  })
  it('lists nothing for a profile without routes', () => {
    expect(apisProfileModels(undefined)).toEqual([])
  })
})
