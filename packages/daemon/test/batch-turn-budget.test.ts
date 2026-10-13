import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import { createTestHost } from '@agnes/host/testkit'
import { describe, expect, it } from 'vitest'
import { say } from './host.js'

// A batch item job carries the batch's remaining budget as its turn budget, rounded to 4 decimals,
// so a nearly spent budget reaches the turn as 0. These pin what such a turn does in the item
// session's Host: nobody is attached, so the approval the budget asks for is unavailable.
describe('an item turn with a budget of 0', () => {
  async function turn(projectedCredits: number) {
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-batch-budget-'))
    const provider = new ScriptedProvider({ scripts: [say('answer')] })
    const { host } = await createTestHost({
      dataDir,
      provider,
      // As in a daemon worker with nobody attached to an item session.
      approval: async () => 'unavailable',
      seams: {
        ledger: { projected: async () => ({ credits: projectedCredits, creditSource: 'estimated' }) },
      },
    })
    try {
      const session = await host.createSession({ cwd: dataDir })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: 'Item 1' }],
        actor: session.d.actor,
        kind: 'prompt',
        budget: 0,
      })
      const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      return { reason: outcome.reason, requests: provider.calls.length }
    } finally {
      await host.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }

  it('ends before any model request when the next request has a price', async () => {
    // The engine's outcome check then settles the item failed with turn_budget.
    expect(await turn(0.5)).toEqual({ reason: 'budget', requests: 0 })
  })

  it('runs as usual when the model is free (nothing to spend)', async () => {
    expect(await turn(0)).toEqual({ reason: 'completed', requests: 1 })
  })
})
