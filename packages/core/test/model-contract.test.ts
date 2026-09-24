import { expect, it } from 'vitest'
import { resolveModel } from '../src/step/inference.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

it('binds each selected model per derivation, independently of other slots and an earlier turn', async () => {
  const provider = fakeProvider([textTurn('first'), textTurn('second')], 'chosen')
  const { session } = await openSession({ provider })
  const targets: string[] = []
  session.d.contractForModel = (target) => {
    targets.push(target.model)
    return { contract_id: target.model === 'one' ? 'agnes-model-contract@0' : null, parser_version: 'chosen' }
  }
  session.preset = {
    ...session.preset,
    model: {
      ...session.preset.model,
      route: { primary: 'gw', fast: 'gw' },
      id: { primary: 'one', fast: 'two' },
    },
  }
  try {
    const fast = resolveModel(session, 'fast')
    expect(session.d.contractForModel(fast).contract_id).toBeNull()
    for (const chosen of ['one', 'two']) {
      // A controlled core input models the route update boundary; this is not a setModel API test.
      session.preset = {
        ...session.preset,
        model: { ...session.preset.model, id: { ...session.preset.model.id, primary: chosen } },
      }
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'hi' }] })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
    }
    expect(provider.requests.map((r) => [r.model, r.contractId])).toEqual([
      ['one', 'agnes-model-contract@0'],
      ['two', null],
    ])
    expect(targets).toEqual(['two', 'one', 'two'])
  } finally {
    await session.close()
  }
})
it('keeps the legacy fixed contract path when no model resolver is installed', async () => {
  const provider = fakeProvider([textTurn('ok')], 'legacy-parser')
  const { session } = await openSession({ provider })
  session.d.contract = { contract_id: 'legacy', parser_version: 'legacy-parser' }
  try {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'hi' }] })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(provider.requests[0]?.contractId).toBe('legacy')
  } finally {
    await session.close()
  }
})
