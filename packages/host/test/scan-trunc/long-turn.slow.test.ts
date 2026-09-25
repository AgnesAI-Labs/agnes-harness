import { actor, fakeProvider, fakeSeams, textTurn, toolTurn } from '@agnes/core/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ledgerDir, longPreset, misplacedResults, openOn, readRegistry } from './fixture.js'

// One turn of 600 tool steps on SQLite, about fifteen thousand rows: every per-turn read below would
// have stopped at its first 500 matching rows before the paging fix.
const STEPS = 600

describe('a 600-step turn on SQLite', () => {
  const ledger = ledgerDir('scan-long-turn')
  const storage = ledger.open()
  const provider = fakeProvider([
    ...Array.from({ length: STEPS }, () => toolTurn('read', {})),
    textTurn('done'),
  ])
  const verified: Array<{ scope: string; input: Record<string, unknown> }> = []
  let session!: Awaited<ReturnType<typeof openOn>>['session']

  beforeAll(async () => {
    const seams = fakeSeams({
      verifier: {
        verify: async (scope, input) => {
          verified.push({ scope, input: input as Record<string, unknown> })
          return { verdict: 'pass', reasons: [] }
        },
      },
    })
    ;({ session } = await openOn(storage, {
      provider,
      registry: readRegistry(),
      preset: longPreset(),
      seams,
    }))
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(outcome.reason).toBe('completed')
  }, 180_000)
  afterAll(async () => {
    await storage.close()
    ledger.remove()
  })

  it('the last request pairs every tool_result with the tool_use on the message before it', () => {
    const last = provider.requests.at(-1)
    expect(provider.requests).toHaveLength(STEPS + 1)
    const results = (last?.messages ?? []).filter((m) => (m as { role: string }).role === 'tool_result')
    expect(results).toHaveLength(STEPS)
    expect(misplacedResults(last as never)).toEqual([])
  })

  it('the turn-scope verifier sees the final message and every message of the turn', () => {
    const turn = verified.filter((v) => v.scope === 'turn').at(-1)?.input
    expect(turn?.lastFinishReason).toBe('stop')
    expect((turn?.surfaceTailHashes as string[] | undefined)?.length).toBe(STEPS + 1)
  })

  it('exportRlaf covers the whole session', async () => {
    const dump = await session.exportRlaf()
    expect(dump.events.map((e) => e.seq)).toEqual(Array.from({ length: session.lastSeq }, (_, i) => i + 1))
  })
})
