import type { ModelRecord, Provider } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.js'
import type { SessionImpl } from '../src/step/session.js'
import { closeKernels, setupWith } from './helpers/child-traces.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'

afterEach(closeKernels)

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
// A decision record that is neither the decision slot name nor the preset's pinned decision
// route/model id. The only way `selectsDecisionModel` can refuse this selector is by finding it
// in the provider's catalogue with `kind: 'decision'` — deleting that catalogue scan must turn
// this case's assertion red, unlike the other three which are refused before ever reaching it.
const unpinnedDecision = {
  id: 'other-decision',
  name: 'other',
  api: 'typesafe-systemone',
  route: 'jev-alt',
  baseUrl: 'https://d.invalid',
  kind: 'decision',
  contextWindow: 64000,
  cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
}

async function parentWith(models: unknown[]): Promise<SessionImpl> {
  const provider = fakeProvider([textTurn('child done')]) as Provider
  Object.assign(provider, { models: () => models })
  const { parent } = await setupWith(provider, (options) => Kernel.create(options))
  parent.preset = {
    ...parent.preset,
    model: {
      ...parent.preset.model,
      route: { ...parent.preset.model.route, primary: 'gw', decision: 'jev' },
      id: { ...parent.preset.model.id, primary: 'm', decision: 'jev-1.13.0' },
    },
  }
  return parent
}
const spawn = (parent: SessionImpl, model: string) => {
  const create = parent.d.children.createWithKind
  if (!create) throw new Error('kernel child factory must expose createWithKind')
  return create.call(parent.d.children, 'spawn', { parent: parent.key, cwd: '/w', input: 'go', model })
}

describe('a child session cannot run on a decision model', () => {
  it.each([
    ['the decision slot name', 'decision', [chat('gw', 'm')]],
    ['the pinned decision model id', 'jev-1.13.0', [chat('gw', 'm')]],
    ['the pinned decision route/model', 'jev/jev-1.13.0', [chat('gw', 'm')]],
    ['a decision record a provider lists', 'other-decision', [chat('gw', 'm'), unpinnedDecision]],
  ])('refuses %s', async (_name, selector, models) => {
    const parent = await parentWith(models)
    await expect(spawn(parent, selector)).rejects.toMatchObject({
      code: 'E_MODEL_UNKNOWN',
      detail: { reason: 'slot-kind', model: selector },
    })
  })

  it('still resolves a chat slot', async () => {
    const parent = await parentWith([chat('gw', 'm')])
    await expect(spawn(parent, 'primary')).resolves.toBeDefined()
  })
})
