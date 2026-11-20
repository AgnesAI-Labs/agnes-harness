import { expect, it } from 'vitest'
import {
  applicationWorkText,
  type EventEnvelope,
  META_KEY,
  readSessionTitle,
  SESSION_TITLE_EVENT,
  validateEvent,
  validateMethod,
} from '../src/index.js'

it('separates bounded application work context while retaining ordinary JSON prompts', () => {
  const request = {
    applicationId: 'acme',
    packageId: 'acme/kit',
    actionId: 'review',
    object: { type: 'ncr', id: 'NCR-018' },
  }
  const suffix = JSON.stringify(request)
  expect(applicationWorkText(`调查当前对象\n\n${suffix}`)).toEqual({ text: '调查当前对象', request })
  expect(applicationWorkText(suffix)).toEqual({ text: '', request })
  for (const text of [
    '{"hello":"world"}',
    JSON.stringify({ ...request, extra: true }),
    JSON.stringify({ ...request, object: { ...request.object, extra: true } }),
    `问题\n\n{${' '.repeat(8192)}${suffix.slice(1)}`,
    '问题\n\n{invalid',
  ])
    expect(applicationWorkText(text)).toEqual({ text })
})

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
  expect(validateEvent({ ...event, type: 'x/host/other' })).toMatchObject({ ok: true })
  expect(readSessionTitle({ ...event, type: 'x/host/other' })).toBeUndefined()
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
