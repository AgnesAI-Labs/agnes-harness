import { expect, it } from 'vitest'
import { exportRlaf } from '../src/project/rlaf.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

it('exports real ledger rows and all signals within inclusive bounds without writing or redacting', async () => {
  const { session, storage } = await openSession({ provider: fakeProvider([textTurn('answer')]) })
  try {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'raw question' }] })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    await session.append([
      {
        type: 'feedback/rating',
        actor,
        origin: 'principal',
        trust: 'trusted',
        data: { targetSeq: session.lastSeq, rating: 'up' },
      },
      {
        type: 'feedback/implicit',
        actor,
        origin: 'principal',
        trust: 'trusted',
        data: { targetSeq: session.lastSeq, kind: 'reaction' },
      },
    ])
    const before = session.lastSeq
    const raw = await session.scan({ toSeq: before })
    const dump = await session.exportRlaf()
    expect(dump.formatVersion).toBe(1)
    expect(dump.events).toEqual(raw)
    expect(dump.headers).toEqual(raw.filter((event) => event.type === 'request/header'))
    expect(dump.headers).toHaveLength(1)
    expect(dump.signals.map((event) => event.type)).toEqual([
      'cost/ledger',
      'verifier/signal',
      'feedback/rating',
      'feedback/implicit',
    ])
    const fromSeq = dump.headers[0]?.seq
    if (fromSeq === undefined) throw new Error('missing header')
    const bounded = await session.exportRlaf({ fromSeq, toSeq: fromSeq })
    expect(bounded.events).toEqual(dump.headers)
    expect(bounded.signals).toEqual([])
    expect(session.lastSeq).toBe(before)
    await session.close()
    const reopened = await openSession({ provider: fakeProvider([]), storage })
    try {
      expect(await reopened.session.exportRlaf()).toEqual(dump)
    } finally {
      await reopened.session.close()
    }
    await expect(session.exportRlaf()).rejects.toMatchObject({ code: 'E_CLOSED' })
  } finally {
    await session.close()
  }
})

it('empty exports and invalid ranges have distinct outcomes', () => {
  expect(exportRlaf([])).toEqual({ formatVersion: 1, events: [], headers: [], signals: [] })
  for (const range of [{ fromSeq: -1 }, { toSeq: NaN }, { fromSeq: 5, toSeq: 4 }])
    expect(() => exportRlaf([], range)).toThrow('E_ENVELOPE')
})
