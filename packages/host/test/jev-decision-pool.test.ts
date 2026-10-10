import { CoreError } from '@agnes/core'
import type { DecisionInput, PreparedModelCall } from '@agnes/jev-runtime'
import { expect, it } from 'vitest'
import {
  createJevDecisionPool,
  decisionBackendStatus,
  decisionCoordinates,
  type JevDecisionPool,
} from '../src/runtime/jev-decision-pool.js'

const signal = () => new AbortController().signal
const input: DecisionInput = { purpose: 'decision', state: {}, questions: {}, inputCursor: null }

function pool(overrides: Partial<JevDecisionPool> = {}): JevDecisionPool {
  return {
    decision: {
      backend: 'jev',
      endpoint: 'https://jev.example.invalid/v1/systemone',
      model: 'jev-latest',
      transport: { invoke: async () => ({ output: { answers: {} } }) },
    },
    ...overrides,
  }
}

it('routes each prepared decision call through the backend selected for that turn', async () => {
  const seen: string[] = []
  const options = pool({
    defaultDecisionBackend: 'jev',
    backends: {
      laya: pool({
        decision: {
          backend: 'laya',
          endpoint: 'http://127.0.0.1:8791/v1/systemone',
          model: 'multilingual',
          transport: {
            invoke: async (request) => {
              seen.push(`laya:${request.model}`)
              return { output: { answers: {} } }
            },
          },
        },
        requestCredits: { decision: 3, language: 5 },
      }),
    },
  })
  const decisions = createJevDecisionPool(options, () => 0)
  expect(decisions.selection()).toEqual(decisionCoordinates(options))
  expect(decisions.selection({ decisionBackend: 'laya' })).toEqual({
    backend: 'laya',
    endpoint: 'http://127.0.0.1:8791/v1/systemone',
    model: 'multilingual',
  })
  const jevCall = await decisions.backend.prepare(input, signal())
  expect(jevCall).toMatchObject({ backend: 'jev', requestedModel: 'jev-latest' })
  expect((await decisions.backend.invoke(jevCall, signal())).output).toBeDefined()

  decisions.select(decisions.selection({ decisionBackend: 'laya' }))
  const layaCall = await decisions.backend.prepare(input, signal())
  expect(layaCall).toMatchObject({ backend: 'laya', requestedModel: 'multilingual' })
  await decisions.backend.invoke(layaCall, signal())
  expect(seen).toEqual(['laya:multilingual'])
  // An owner is consumed exactly once; a replayed prepared call never re-dispatches.
  await expect(decisions.backend.invoke(jevCall, signal())).rejects.toThrow('no prepared owner')
  expect(decisions.credits({ purpose: 'decision', backend: 'laya' } as PreparedModelCall)).toBe(3)
  expect(decisions.credits({ purpose: 'answer', backend: 'laya' } as PreparedModelCall)).toBe(5)
  expect(decisions.credits({ purpose: 'decision', backend: 'jev' } as PreparedModelCall)).toBeUndefined()
})

it('rejects unavailable choices and mismatched persisted coordinates without fallback', () => {
  const decisions = createJevDecisionPool(pool(), () => 0)
  expect(() => decisions.selection({ decisionBackend: 'laya' })).toThrow(CoreError)
  decisions.select(undefined)
  expect(() =>
    decisions.select({
      backend: 'jev',
      endpoint: 'https://other.example.invalid/v1/systemone',
      model: 'jev-latest',
    }),
  ).toThrow(CoreError)
  expect(() => decisions.select('jev' as never)).toThrow(CoreError)
})

it('publishes honest availability and resolves an unusable default once at boot', () => {
  const configured = pool({ defaultDecisionBackend: 'laya' })
  const decisions = createJevDecisionPool(configured, () => 0)
  expect(decisions.defaultBackend).toBe('jev')
  expect(decisionBackendStatus(configured)).toEqual([
    { backend: 'jev', label: 'Jev', available: true },
    {
      backend: 'laya',
      label: 'Laya',
      available: false,
      unavailableReason: '决策后端未配置或未启用。',
    },
  ])
  // The assembled primary is the boot fallback; only non-primary targets carry reasons.
  const unavailablePrimary = pool({
    decision: {
      backend: 'laya',
      endpoint: 'http://127.0.0.1:8791/v1/systemone',
      model: 'multilingual',
      transport: { invoke: async () => ({ output: { answers: {} } }) },
    },
    unavailableBackends: { jev: 'Jev 持久配置或凭据不可用。' },
  })
  expect(decisionBackendStatus(unavailablePrimary)).toEqual([
    {
      backend: 'jev',
      label: 'Jev',
      available: false,
      unavailableReason: 'Jev 持久配置或凭据不可用。',
    },
    { backend: 'laya', label: 'Laya', available: true },
  ])
})
