import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { foldEvents } from '../src/reduce/reducer.js'
import { newOpState } from '../src/step/op-state.js'
import type { SessionImpl } from '../src/step/session.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { openSession } from './helpers/open-session.js'

const clock = () => 1_757_203_200_000
async function ready(via: 'callback' | 'timeout' | 'sync' = 'callback', lane = 'main') {
  const storage = new MemoryStorage({ clock })
  const h = await openSession({ storage, clock, provider: fakeProvider([textTurn('unused')]) })
  await h.log.append([
    h.session.ev(
      'approval/asked',
      { requestId: 'r1', kind: 'budget', risk: 'budget', summary: 'quote', bindingHash: '' },
      { lane },
    ),
    h.session.ev('approval/decided', { requestId: 'r1', verdict: 'allowed-once', via }, { lane }),
  ])
  return { ...h, storage }
}
function start(s: SessionImpl, requestId: string | undefined = 'r1', trigger = 'approval-resume') {
  const turn = s.lastTurnNumber() + 1,
    seq = s.lastSeq + 1
  const meta = {
    turn,
    lane: s.lane,
    acceptedAt: new Date(clock()).toISOString(),
    triggerSeq: seq,
    presetName: s.preset.name,
    profileHash: null,
    depthLimit: s.preset.depthLimit,
  }
  return s.transition(
    [
      s.ev('turn/start', {
        turn,
        trigger,
        continues: {
          turn: 1,
          step: 0,
          toolUseId: '',
          ...(requestId === undefined ? {} : { requestId }),
        },
      }),
    ],
    newOpState(meta, seq),
  )
}

describe('approval decision consumption state', () => {
  it.each(['callback', 'timeout'] as const)(
    'consumes %s once, preserves prior state, and rebuilds the marker',
    async (via) => {
      const h = await ready(via)
      const previous = h.session.state
      await start(h.session)
      expect(previous.resumedRequests.size).toBe(0)
      await h.session.endTurn('completed')
      const before = h.log.lastSeq
      await expect(start(h.session)).rejects.toThrow('approval decision already consumed')
      expect(h.log.lastSeq).toBe(before)
      expect(h.session.op()).toBeNull()
      const rebuilt = foldEvents(await h.log.scan({ fromSeq: 1, toSeq: h.log.lastSeq }))
      expect([...rebuilt.resumedRequests]).toEqual(['r1'])
      await h.session.close()
      const reopened = await openSession({
        storage: h.storage,
        clock,
        provider: fakeProvider([textTurn('unused')]),
      })
      try {
        expect([...reopened.session.state.resumedRequests]).toEqual(['r1'])
        await expect(start(reopened.session)).rejects.toThrow('already consumed')
      } finally {
        await reopened.session.close()
      }
    },
  )
  it.each(['missing', 'sync', 'other-lane', 'wrong-trigger'])(
    'refuses %s without committing or consuming',
    async (mode) => {
      const h = await ready(mode === 'sync' ? 'sync' : 'callback', mode === 'other-lane' ? 'other' : 'main')
      const before = h.log.lastSeq
      await expect(
        start(
          h.session,
          mode === 'missing' ? 'unknown' : 'r1',
          mode === 'wrong-trigger' ? 'prompt' : 'approval-resume',
        ),
      ).rejects.toThrow('continuation requires a decision')
      expect(h.log.lastSeq).toBe(before)
      expect(h.session.state.resumedRequests.size).toBe(0)
      expect(h.session.op()).toBeNull()
    },
  )
  it('keeps historical continuations without a requestId readable without inventing a consumed decision', async () => {
    const h = await ready()
    const turn = 1,
      seq = h.log.lastSeq + 1
    await h.session.transition(
      [
        h.session.ev('turn/start', {
          turn,
          trigger: 'approval-resume',
          continues: { turn: 1, step: 0, toolUseId: '' },
        }),
      ],
      newOpState(
        {
          turn,
          lane: 'main',
          acceptedAt: new Date(clock()).toISOString(),
          triggerSeq: seq,
          presetName: 'standard',
          profileHash: null,
          depthLimit: 1,
        },
        seq,
      ),
    )
    expect(h.session.state.resumedRequests.size).toBe(0)
    await h.session.endTurn('completed')
  })
})
