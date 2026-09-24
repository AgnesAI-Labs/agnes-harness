import { expect, it } from 'vitest'
import {
  type EventEnvelope,
  META_KEY,
  readSessionTitle,
  SESSION_TITLE_EVENT,
  validateEvent,
  validateMethod,
} from '../src/index.js'

const event: EventEnvelope = {
  v: 1,
  seq: 1,
  ts: new Date().toISOString(),
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  actor: { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} },
  type: SESSION_TITLE_EVENT,
  origin: 'system',
  trust: 'trusted',
  ignorable: true,
  lane: 'main',
  data: {
    status: 'generated',
    title: '会话标题',
    prompt: '问题',
    turn: 1,
    startSeq: 3,
    route: 'gw',
    model: 'm1',
    budgetCap: null,
    treeBudgetCap: null,
  },
}
it('allows persisted title events through both envelope and live notification validation', () => {
  expect(validateEvent(event)).toMatchObject({ ok: true })
  expect(
    validateMethod('_agnes/v1/session.event', 'params', {
      sessionId: 'title-test',
      event,
      _meta: {
        [META_KEY]: {
          promptTurnId: '1',
          eventSequence: 1,
          generation: 1,
          lane: 'main',
          phase: 'event',
        },
      },
    }),
  ).toMatchObject({ ok: true })
  expect(validateEvent({ ...event, type: 'x/host/other' })).toMatchObject({ ok: false })
})

it('accepts only closed Host-owned title metadata', () => {
  expect(readSessionTitle(event)).toMatchObject({ status: 'generated' })
  for (const patch of [
    { origin: 'ext:host' },
    { trust: 'untrusted' },
    { ignorable: false },
    { lane: 'child' },
  ]) {
    expect(readSessionTitle({ ...event, ...patch } as EventEnvelope)).toBeUndefined()
  }
  expect(readSessionTitle({ ...event, data: { ...(event.data as object), extra: true } })).toBeUndefined()
  expect(readSessionTitle({ ...event, data: { ...(event.data as object), title: '' } })).toBeUndefined()
})
