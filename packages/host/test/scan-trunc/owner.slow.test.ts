import { actor, fakeProvider, textTurn, toolTurn } from '@agnes/core/testkit'
import { expect, it } from 'vitest'
import { ledgerDir, longPreset, misplacedResults, openOn, readRegistry } from './fixture.js'

// 600 text-only answers leave more than 500 assistant messages on the surface while there is only
// one tool call. A read that stopped at the first 500 messages hung that call on message 500.
it('a call after 600 text answers is attributed to the message that made it', async () => {
  const ledger = ledgerDir('scan-owner')
  const storage = ledger.open()
  try {
    const TEXT = 600
    const provider = fakeProvider([
      ...Array.from({ length: TEXT }, (_, i) => textTurn(`answer ${i}`)),
      toolTurn('read', {}),
      textTurn('done'),
    ])
    const { session } = await openOn(storage, { provider, registry: readRegistry(), preset: longPreset() })
    const signal = new AbortController().signal
    for (let i = 0; i <= TEXT; i++) {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: `q${i}` }], actor })
      expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    }
    const last = provider.requests.at(-1)
    expect(provider.requests).toHaveLength(TEXT + 2)
    const results = (last?.messages ?? []).filter((m) => (m as { role: string }).role === 'tool_result')
    expect(results).toHaveLength(1)
    expect(misplacedResults(last as never)).toEqual([])
  } finally {
    await storage.close()
    ledger.remove()
  }
}, 180_000)
