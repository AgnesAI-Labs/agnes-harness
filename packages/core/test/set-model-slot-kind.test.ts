import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { openSession } from './helpers/open-session.js'

const chat = (route: string, id: string): ModelRecord => ({
  id,
  name: id,
  api: 'openai-completions',
  route,
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})
const decision = {
  id: 'jev-1.13.0',
  name: 'jev',
  api: 'typesafe-systemone',
  route: 'jev',
  baseUrl: 'https://d.invalid',
  kind: 'decision',
  contextWindow: 64000,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
}

async function open(models: unknown[]) {
  const provider = fakeProvider([textTurn('a')])
  Object.assign(provider, { models: () => models })
  const opened = await openSession({ provider })
  return opened
}

describe('setModel refuses a slot and model of different kinds', () => {
  it('a chat model on the decision slot', async () => {
    const { session, log } = await open([chat('gw', 'm')])
    await expect(session.setModel({ slot: 'decision', route: 'gw', model: 'm' })).rejects.toMatchObject({
      code: 'E_MODEL_UNKNOWN',
      detail: { reason: 'slot-kind', slot: 'decision' },
    })
    expect(session.preset.model.route.decision).toBeUndefined()
    expect(await log.scan({ type: 'x/core/model-switch', limit: 5 })).toHaveLength(0)
  })

  it('a decision record on a chat slot, even when a provider lists one', async () => {
    const { session } = await open([chat('gw', 'm'), decision])
    await expect(
      session.setModel({ slot: 'primary', route: 'jev', model: 'jev-1.13.0' }),
    ).rejects.toMatchObject({
      code: 'E_MODEL_UNKNOWN',
      detail: { reason: 'slot-kind' },
    })
  })

  it('the model the preset pins on the decision slot, on a chat slot', async () => {
    const { session } = await open([chat('gw', 'm')])
    session.preset = {
      ...session.preset,
      model: {
        ...session.preset.model,
        route: { ...session.preset.model.route, decision: 'jev' },
        id: { ...session.preset.model.id, decision: 'jev-1.13.0' },
      },
    }
    await expect(
      session.setModel({ slot: 'primary', route: 'jev', model: 'jev-1.13.0' }),
    ).rejects.toMatchObject({
      detail: { reason: 'slot-kind' },
    })
  })

  it('a model nobody lists is still a plain catalogue miss', async () => {
    const { session } = await open([chat('gw', 'm')])
    let thrown: unknown
    try {
      await session.setModel({ slot: 'primary', route: 'jev', model: 'jev-1.13.0' })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toMatchObject({ code: 'E_MODEL_UNKNOWN' })
    expect((thrown as { detail: Record<string, unknown> }).detail.reason).toBeUndefined()
  })

  it('a chat model on a chat slot still switches', async () => {
    const { session } = await open([chat('gw', 'm'), chat('alt', 'm2')])
    await session.setModel({ slot: 'primary', route: 'alt', model: 'm2' })
    expect(session.preset.model.id.primary).toBe('m2')
  })
})
