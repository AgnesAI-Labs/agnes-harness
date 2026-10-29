import { newOpState } from '@agnes/core-common/step/op-state'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { foldEvents } from '@agnes/core-ledger/reduce/reducer'
import { describe, expect, it } from 'vitest'
import { answeredDecision, pendingDecision } from '../../core-ledger/testkit/decision.js'
import type { SessionImpl } from '../src/step/session.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { openSession } from './helpers/open-session.js'

const clock = () => 1_757_203_200_000
async function ready(via: 'callback' | 'timeout' = 'callback', lane = 'main') {
  const storage = new MemoryStorage({ clock })
  const h = await openSession({ storage, clock, provider: fakeProvider([textTurn('unused')]) })
  const asked = pendingDecision('r1', { owner: 'core/gate', lane })
  const decided =
    via === 'callback'
      ? answeredDecision(asked, h.log.lastSeq + 2)
      : {
          ...asked,
          revision: 2,
          result: { reason: 'expired' as const, at: asked.request.expiresAt!, code: 'deadline' },
        }
  await h.log.append([
    h.session.ev('decision/state', asked, { lane, register: 'decision/state' }),
    h.session.ev('decision/state', decided, { lane, register: 'decision/state' }),
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
    'consumes %s once, rebuilds the marker, and refuses retired verifier history on reload',
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
      await expect(
        openSession({
          storage: h.storage,
          clock,
          provider: fakeProvider([textTurn('unused')]),
        }),
      ).rejects.toMatchObject({ code: 'E_RELATION', detail: { reason: 'clean-home-required' } })
    },
  )
  it.each(['missing', 'other-lane', 'wrong-trigger'])(
    'refuses %s without committing or consuming',
    async (mode) => {
      const h = await ready('callback', mode === 'other-lane' ? 'other' : 'main')
      const before = h.log.lastSeq
      await expect(
        start(
          h.session,
          mode === 'missing' ? 'unknown' : 'r1',
          mode === 'wrong-trigger' ? 'prompt' : 'approval-resume',
        ),
      ).rejects.toThrow('E_RELATION')
      expect(h.log.lastSeq).toBe(before)
      expect(h.session.state.resumedRequests.size).toBe(0)
      expect(h.session.op()).toBeNull()
    },
  )
})
