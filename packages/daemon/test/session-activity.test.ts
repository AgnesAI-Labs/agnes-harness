import type { EventEnvelope } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createSessionActivity } from '../src/supervisor/session-activity.js'

const event = (type: string, data: unknown = {}) => ({ type, data }) as unknown as EventEnvelope
const decision = (id: string, sessionId: string, category?: 'permission', result: unknown = null) =>
  event('decision/state', {
    handle: { id, sessionId },
    request: { ...(category ? { category } : {}) },
    result,
    invalidation: null,
    consumption: null,
  })

function setup(owners: Record<string, string> = { a: 'me', b: 'me', c: 'someone' }) {
  const notices: Array<{ sessionId?: string; detail: Record<string, unknown> }> = []
  const activity = createSessionActivity({
    ownership: {
      resolve: (key) => (owners[key] ? { active: true, principalId: owners[key] } : undefined),
    },
    notices: {
      emit: ((_kind: string, o: { sessionId?: string; detail: Record<string, unknown> }) =>
        notices.push(o)) as never,
    },
    profile: 'local-dev',
  })
  return { activity, notices }
}

it('announces a turn running and how it ended to the session owner', () => {
  const { activity, notices } = setup()
  activity.observe('a', event('turn/start'))
  activity.observe('a', event('turn/end', { reason: 'completed' }))
  expect(notices).toEqual([
    { sessionId: 'a', detail: { profile: 'local-dev', owner: 'me', sessionId: 'a', state: 'running' } },
    {
      sessionId: 'a',
      detail: { profile: 'local-dev', owner: 'me', sessionId: 'a', state: 'idle', reason: 'completed' },
    },
  ])
})

it('waits on an open approval or question until it is answered', () => {
  const { activity, notices } = setup()
  activity.observe('a', event('turn/start'))
  activity.observe('a', decision('d1', 'a', 'permission'))
  activity.observe('a', event('turn/end', { reason: 'parked' }))
  expect(notices.at(-1)?.detail).toMatchObject({ state: 'waiting', waiting: 'approval', reason: 'parked' })
  activity.observe('a', decision('d1', 'a', 'permission', { answer: 'allow' }))
  expect(notices.at(-1)?.detail).toMatchObject({ state: 'idle', reason: 'parked' })
  activity.observe('b', decision('q1', 'b'))
  expect(notices.at(-1)).toMatchObject({ sessionId: 'b', detail: { state: 'waiting', waiting: 'question' } })
  // A decision row naming another session is not this session's to wait on.
  activity.observe('a', decision('x', 'b'))
  expect(notices.at(-1)?.sessionId).toBe('b')
})

it('says nothing when the state is unchanged, ignores other rows and skips sessions without an owner', () => {
  const { activity, notices } = setup()
  activity.observe('a', event('turn/start'))
  activity.observe('a', event('turn/start'))
  activity.observe('a', event('assistant/message'))
  activity.observe('z', event('turn/start'))
  expect(notices).toHaveLength(1)
})

it('rebuilds replayed history silently and lists only the running and waiting sessions of the caller', () => {
  const { activity, notices } = setup()
  activity.observe('a', event('turn/start'), false)
  activity.observe('b', decision('q1', 'b'), false)
  activity.observe('c', event('turn/start'), false)
  activity.observe('a', event('turn/start'))
  expect(notices).toEqual([])
  expect(activity.list('me').items).toEqual([
    { sessionId: 'a', state: 'running' },
    { sessionId: 'b', state: 'waiting', waiting: 'question' },
  ])
  activity.observe('a', event('turn/end', { reason: 'error' }))
  expect(activity.list('me').items).toEqual([{ sessionId: 'b', state: 'waiting', waiting: 'question' }])
})
