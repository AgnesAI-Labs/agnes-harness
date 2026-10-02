import type { Outcome } from '@agnes/extension-api/runtime'
import { afterEach, expect, it } from 'vitest'
import { createInteractionService, type InteractionOptions } from '../../src/runtime/providers/interaction.js'
import { createRuntimeStateStore, type RuntimeStateStore } from '../../src/runtime/providers/state.js'
import { interactionStateFixture } from '../runtime-state-interaction-read-fixture.js'

const stores: RuntimeStateStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

/** The Outcome State store over the fixture's database with its selected approval owner and reader. */
async function setup() {
  const f = await interactionStateFixture()
  const store = createRuntimeStateStore({
    file: f.file,
    authority: { authorityId: 'authority', tenantId: 'tenant', authorityEpoch: 1 },
    now: () => Date.parse('2026-04-01T00:00:00.000Z'),
    interactionRead: f.readOwner,
    approvalJoint: f.joint,
  })
  stores.push(store)
  const provider = (responder: InteractionOptions['responder']) =>
    createInteractionService({ store, responder })
  const service = provider((context) => (context === f.context ? f.capability : null))
  const prepare = (request = f.question, runId = 'run') =>
    service.prepareApproval({
      request,
      owner: { runId, actionId: f.actionId },
      preparation: f.prepare,
      context: f.context,
    })
  const answer = (interactionId: string, extra = {}) => ({
    interactionId,
    responseId: 'response',
    expectedVersion: 1,
    decision: 'approve',
    intentDigest: f.question.intentDigest,
    ...extra,
  })
  return { f, provider, service, prepare, answer }
}
function value<T>(result: Outcome<T>): T {
  if (!result.ok) throw Error(`unexpected refusal ${result.error.detailCode}`)
  return result.value
}

it('opens, lists, answers and replays an approval through the State entries', async () => {
  const { f, service, prepare, answer } = await setup()
  const record = value(await prepare())
  expect(record.status).toBe('pending')
  expect(await prepare()).toEqual({ ok: true, value: record })
  expect(await service.read(record.interactionId, f.context)).toEqual({ ok: true, value: record })
  expect(await service.pending({ scope: f.readScope }, f.context)).toMatchObject({
    ok: true,
    value: { items: [record], complete: true },
  })
  const answered = value(await service.respondApproval(answer(record.interactionId), f.context))
  expect(answered).toMatchObject({
    responseId: 'response',
    status: 'accepted',
    result: { status: 'answered' },
  })
  // The answer commit also writes the target inbox entry and its signal, so State reports it applied.
  expect(await service.responseStatus('response', f.context)).toEqual({
    ok: true,
    value: { ...answered, status: 'applied' },
  })
  expect(await service.respondApproval(answer(record.interactionId), f.context)).toEqual({
    ok: true,
    value: answered,
  })
  expect(await service.read(record.interactionId, f.context)).toEqual({ ok: true, value: answered.result })
  expect(await service.pending({ scope: f.readScope }, f.context)).toMatchObject({
    ok: true,
    value: { items: [] },
  })
})

it('refuses without writing for a missing capability, malformed input or an unsupported method', async () => {
  const { f, provider, service, prepare, answer } = await setup()
  const { interactionId } = value(await prepare())
  const request = answer(interactionId)
  const before = f.count()
  const cases: [string, () => Promise<Outcome<unknown>>, object][] = [
    [
      'no issued capability',
      () => provider(() => null).respondApproval(request, f.context),
      { code: 'denied', detailCode: 'permission_denied' },
    ],
    // The selected owner rejects a foreign capability with a plain error, which State reports as a fault.
    [
      'capability of another call',
      () => provider(() => Object.freeze({})).respondApproval(request, f.context),
      {},
    ],
    [
      'non-object response',
      () => service.respondApproval(null, f.context),
      { code: 'invalid_input', detailCode: 'invalid_request' },
    ],
    [
      'malformed response',
      () => service.respondApproval({ ...request, decision: 'maybe' }, f.context),
      { code: 'invalid_input', detailCode: 'invalid_request' },
    ],
    ...(['request', 'respond', 'acceptResponse', 'expire', 'cancel', 'formLink'] as const).map(
      (method): [string, () => Promise<Outcome<unknown>>, object] => [
        method,
        () => service[method](request, f.context),
        { code: 'incompatible', detailCode: 'unsupported', retryAdvice: { kind: 'never' } },
      ],
    ),
  ]
  for (const [label, call, error] of cases) {
    expect(await call(), label).toMatchObject({ ok: false, error })
    expect(f.count(), label).toEqual(before)
    expect(await service.responseStatus('response', f.context), label).toMatchObject({
      ok: true,
      value: { status: 'not-accepted' },
    })
    expect(await service.read(interactionId, f.context), label).toMatchObject({
      ok: true,
      value: { status: 'pending', version: 1 },
    })
  }
})

it('maps State-local input and denial refusals and passes registered details through', async () => {
  const { f, service, prepare, answer } = await setup()
  const { interactionId } = value(await prepare())
  const other = { ...f.context, bindingId: 'other-binding' }
  const denied = { code: 'denied', detailCode: 'permission_denied' }
  const cases: [string, () => Promise<Outcome<unknown>>, object][] = [
    [
      'absent interaction',
      () => service.respondApproval(answer('missing-interaction'), f.context),
      { code: 'invalid_input', detailCode: 'invalid_request', message: 'approval interaction is absent' },
    ],
    [
      'preparation of another run',
      () => prepare(f.question, 'other-run'),
      { code: 'invalid_input', detailCode: 'invalid_request' },
    ],
    [
      'question for another scope',
      () => prepare({ ...f.question, scope: { kind: 'installation', installationId: 'elsewhere' } }),
      denied,
    ],
    ['read by another binding', () => service.read(interactionId, other), denied],
    ['response status by another binding', () => service.responseStatus('response', other), denied],
    ['pending by another binding', () => service.pending({ scope: f.readScope }, other), denied],
    [
      'absent record',
      () => service.read('missing', f.context),
      { code: 'invalid_input', detailCode: 'not_found' },
    ],
    [
      'stale version',
      () => service.respondApproval(answer(interactionId, { expectedVersion: 2 }), f.context),
      { code: 'conflict', detailCode: 'revision_conflict', diagnosticId: 'interaction-authority' },
    ],
  ]
  for (const [label, call, error] of cases)
    expect(await call(), label).toMatchObject({
      ok: false,
      error: { retryAdvice: { kind: 'never' }, ...error },
    })
})
