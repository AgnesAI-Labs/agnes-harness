import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createConformanceHarness, createRuntimeInboxFixture, SCENARIOS } from '@agnes/extension-api/testkit'
import type * as Wire from '@agnes/protocol/runtime'
import { RuntimeSchemaRefs } from '@agnes/protocol/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InteractionContractPort } from '../../../../packages/extension-api/testkit/runtime/contracts/interaction.js'
import { createReferenceRegistry } from '../index.js'
import {
  INTERACTION_PROVIDER,
  type InteractionStore,
  openInteractionStore,
  type WakeSink,
} from './interaction.js'
import {
  approvalRequest,
  approve,
  bindInteractionContract,
  code,
  deliverTo,
  human,
  inline,
  must,
  owner,
  waiter,
} from './interaction-contract.js'

const answerSchema = { typeId: 'acme.forms/answer@1', revision: 1, digest: 'c'.repeat(64) }
const question = {
  kind: 'question',
  title: 'Release',
  body: 'Pick a channel',
  answerSchema,
  fields: [
    { id: 'note', kind: 'text', label: 'Note', required: true, multiline: false, maxLength: 20 },
    {
      id: 'channel',
      kind: 'singleChoice',
      label: 'Channel',
      required: true,
      options: [
        { id: 'beta', label: 'Beta' },
        { id: 'stable', label: 'Stable' },
      ],
    },
    {
      id: 'targets',
      kind: 'multiChoice',
      label: 'Targets',
      required: false,
      options: [
        { id: 'mac', label: 'macOS' },
        { id: 'win', label: 'Windows' },
        { id: 'linux', label: 'Linux' },
      ],
      minItems: 1,
      maxItems: 2,
    },
    { id: 'ok', kind: 'confirm', label: 'Confirm', required: true, statement: 'Ship it' },
  ],
  allowedResponders: ['alice'],
  expiresAt: '2026-10-08T00:00:00Z',
  idempotencyKey: 'ask-q',
}

let directory: string
let path: string
let now: string
let ids: number
let store: InteractionStore
const clock = { now: () => now, newId: () => `ix-${++ids}` }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'reference-interaction-'))
  path = join(directory, 'interaction.sqlite')
  now = '2026-10-01T00:00:00Z'
  ids = 0
  store = openInteractionStore(path, { clock })
})

afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const open = (request: unknown) => must(store.request({ request, owner }))
const reopen = () => {
  store.close()
  store = openInteractionStore(path, { clock })
}

describe('reference interaction: questions open durably', () => {
  it('opens a pending version-1 record and reuses it for the same key, also after expiry', () => {
    const first = open(approvalRequest())
    expect(first).toMatchObject({ status: 'pending', version: 1, resolution: null, terminationReason: null })
    expect(store.request({ request: approvalRequest(), owner })).toEqual({ ok: true, value: first })
    now = '2026-10-09T00:00:00Z'
    reopen()
    expect(store.request({ request: approvalRequest(), owner })).toEqual({ ok: true, value: first })
    expect(ids).toBe(1)
  })

  it.each([
    ['a different question under the same key', approvalRequest({ title: 'Other' }), 'idempotency_conflict'],
    ['a forged intent digest', { ...approvalRequest(), intentDigest: 'd'.repeat(64) }, 'invalid_request'],
    [
      'repeated field ids',
      { ...question, fields: [question.fields[0], question.fields[0]] },
      'invalid_request',
    ],
    [
      'an expiry already passed',
      approvalRequest({ expiresAt: '2026-09-30T00:00:00Z', idempotencyKey: 'ask-late' }),
      'invalid_request',
    ],
  ])('refuses %s', (_name, request, detail) => {
    open(approvalRequest())
    expect(code(store.request({ request, owner }))).toBe(detail)
  })
})

describe('reference interaction: approval answers', () => {
  it('stores the platform answer, defaults the grant to once and queues one wake', () => {
    const { interactionId } = open(approvalRequest())
    const accepted = store.respond(approve(interactionId))
    expect(accepted).toMatchObject({ ok: true, value: { status: 'accepted', version: 2, error: null } })
    expect(must(store.read(interactionId))).toMatchObject({
      status: 'answered',
      resolution: {
        actorRef: 'alice',
        answer: {
          kind: 'inline',
          schema: { typeId: 'agh.interaction/approval-answer@1' },
          value: { decision: 'approve', grantScope: 'once' },
        },
      },
    })
    expect(store.wakes()).toEqual([
      {
        wake: {
          deliveryKey: `${interactionId}@2`,
          interactionId,
          owner,
          version: 2,
          status: 'answered',
          responseId: 'resp-1',
        },
        delivery: 'pending',
        failures: 0,
        dueAt: '2026-10-01T00:00:00.000Z',
        lastError: null,
        ackRef: null,
      },
    ])
    expect(store.respond(approve(interactionId))).toEqual(accepted)
    now = '2026-10-09T00:00:00Z'
    expect(store.respond(approve(interactionId))).toEqual(accepted)
    expect(store.wakes()).toHaveLength(1)
    expect(store.responseStatus('resp-1')).toEqual(accepted)
  })

  it('records deny as an answer and accepts the platform answer on the generic path', () => {
    const { interactionId } = open(approvalRequest())
    const denied = store.respond(approve(interactionId, { decision: 'deny' }))
    expect(denied.ok && denied.value.result).toMatchObject({
      status: 'answered',
      resolution: { answer: { value: { decision: 'deny' } } },
    })
    const other = open(approvalRequest({ idempotencyKey: 'ask-2' }))
    const value = { decision: 'approve', intentDigest: approvalRequest().intentDigest, grantScope: 'session' }
    const generic = store.respond({
      method: 'acceptResponse',
      actorRef: 'alice',
      evidence: human,
      request: {
        interactionId: other.interactionId,
        responseId: 'resp-2',
        expectedVersion: 1,
        answer: inline(RuntimeSchemaRefs.ApprovalAnswer, value),
      },
    })
    expect(generic.ok && generic.value.status).toBe('accepted')
  })

  it.each([
    ['a grant scope that was not offered', { grantScope: 'permanent' }, 'invalid_request'],
    ['deny with a grant scope', { decision: 'deny', grantScope: 'once' }, 'invalid_request'],
    ['another intent digest', { intentDigest: 'e'.repeat(64) }, 'invalid_request'],
    ['a stale version', { expectedVersion: 7 }, 'revision_conflict'],
    ['an unknown interaction', { interactionId: 'nobody' }, 'not_found'],
  ])('refuses %s and leaves the question pending', (_name, extra, detail) => {
    const { interactionId } = open(approvalRequest())
    expect(code(store.respond(approve(interactionId, extra)))).toBe(detail)
    expect(must(store.read(interactionId)).status).toBe('pending')
    expect(store.wakes()).toEqual([])
  })

  it('refuses an actor outside allowedResponders and an answer after expiry', () => {
    const { interactionId } = open(approvalRequest())
    expect(code(store.respond({ ...approve(interactionId), actorRef: 'mallory' }))).toBe('permission_denied')
    now = '2026-10-08T00:00:00Z'
    expect(code(store.respond(approve(interactionId)))).toBe('blocked')
    expect(must(store.read(interactionId)).status).toBe('pending')
  })

  it('lets only one of two competing responses win', () => {
    const { interactionId } = open(approvalRequest())
    expect(store.respond(approve(interactionId)).ok).toBe(true)
    expect(code(store.respond(approve(interactionId, { responseId: 'resp-2' })))).toBe('revision_conflict')
  })

  it.each([
    ['another answer', { grantScope: 'session' }, {}],
    ['another actor', {}, { actorRef: 'bob' }],
  ])('refuses a reused response id carrying %s', (_name, extra, override) => {
    const { interactionId } = open(approvalRequest({ allowedResponders: ['alice', 'bob'] }))
    const intentDigest = approvalRequest({ allowedResponders: ['alice', 'bob'] }).intentDigest
    expect(store.respond(approve(interactionId, { intentDigest })).ok).toBe(true)
    const reused = store.respond({ ...approve(interactionId, { intentDigest, ...extra }), ...override })
    expect(code(reused)).toBe('idempotency_conflict')
  })

  it('refuses a business schema sent through the generic response path', () => {
    const { interactionId } = open(approvalRequest())
    const custom = store.respond({
      method: 'acceptResponse',
      actorRef: 'alice',
      evidence: human,
      request: {
        interactionId,
        responseId: 'resp-9',
        expectedVersion: 1,
        answer: inline({ typeId: 'acme.forms/approve@1', revision: 1, digest: 'a'.repeat(64) }, { ok: 1 }),
      },
    })
    expect(code(custom)).toBe('invalid_request')
  })
})

describe('reference interaction: question answers', () => {
  const respond = (
    interactionId: string,
    value: Wire.JsonValue,
    ref: Wire.DataRef = inline(answerSchema, value),
  ) =>
    store.respond({
      method: 'acceptResponse',
      actorRef: 'alice',
      evidence: human,
      request: { interactionId, responseId: 'resp-q', expectedVersion: 1, answer: ref },
    })

  it('accepts a complete answer, including an explicit confirm=false', () => {
    const { interactionId } = open(question)
    const accepted = respond(interactionId, { note: 'ok', channel: 'beta', targets: ['mac'], ok: false })
    expect(accepted.ok && accepted.value.result?.status).toBe('answered')
  })

  it.each([
    ['an option label in place of its id', { note: 'ok', channel: 'Beta', ok: true }],
    ['a missing required field', { channel: 'beta', ok: true }],
    ['text over its limit', { note: 'x'.repeat(21), channel: 'beta', ok: true }],
    ['a line break in a single-line field', { note: 'a\nb', channel: 'beta', ok: true }],
    ['too many selections', { note: 'ok', channel: 'beta', targets: ['mac', 'win', 'linux'], ok: true }],
    ['a repeated selection', { note: 'ok', channel: 'beta', targets: ['mac', 'mac'], ok: true }],
    ['a confirm that is not a boolean', { note: 'ok', channel: 'beta', ok: 'yes' }],
    ['an unknown field', { note: 'ok', channel: 'beta', ok: true, extra: 1 }],
  ])('refuses %s', (_name, value) => {
    const { interactionId } = open(question)
    expect(code(respond(interactionId, value))).toBe('invalid_request')
  })

  it('refuses another schema, tampered content, an approval answer and blob answers it cannot decode', () => {
    const { interactionId } = open(question)
    const value = { note: 'ok', channel: 'beta', ok: true }
    const otherSchema = { ...inline(answerSchema, value), schema: { ...answerSchema, revision: 2 } }
    expect(code(respond(interactionId, value, otherSchema))).toBe('invalid_request')
    const tampered = { ...inline(answerSchema, value), value: { note: 'no', channel: 'beta', ok: true } }
    expect(code(respond(interactionId, value, tampered))).toBe('invalid_request')
    expect(code(store.respond(approve(interactionId)))).toBe('invalid_request')
    const blob = respond(interactionId, value, {
      kind: 'blob',
      schema: answerSchema,
      blob: {
        authorityId: 'blobs',
        blobId: 'b1',
        digest: 'f'.repeat(64),
        bytes: 10,
        mediaType: 'application/json',
        pinId: 'pin-1',
      },
    })
    expect(code(blob)).toBe('unsupported')
    expect(must(store.read(interactionId)).status).toBe('pending')
  })
})

describe('reference interaction: expiry, cancellation and atomicity', () => {
  it('expires only when due, wakes once and treats a retry as the same change', () => {
    const { interactionId } = open(approvalRequest())
    const expire = { interactionId, expectedVersion: 1, reason: 'timed out' }
    expect(code(store.expire(expire))).toBe('blocked')
    now = '2026-10-08T00:00:00Z'
    const expired = store.expire(expire)
    expect(expired.ok && expired.value).toMatchObject({
      status: 'expired',
      version: 2,
      terminationReason: 'timed out',
    })
    expect(store.expire(expire)).toEqual(expired)
    expect(code(store.expire({ ...expire, reason: 'other' }))).toBe('revision_conflict')
    expect(store.wakes().map((state) => state.wake.status)).toEqual(['expired'])
  })

  it('cancels a pending question but not an answered one', () => {
    const first = open(approvalRequest())
    const cancelled = store.cancel({
      interactionId: first.interactionId,
      expectedVersion: 1,
      reason: 'run aborted',
    })
    expect(cancelled.ok && cancelled.value.status).toBe('cancelled')
    const second = open(approvalRequest({ idempotencyKey: 'ask-2' }))
    expect(store.respond(approve(second.interactionId)).ok).toBe(true)
    const late = store.cancel({ interactionId: second.interactionId, expectedVersion: 1, reason: 'too late' })
    expect(code(late)).toBe('revision_conflict')
    expect(code(store.cancel({ interactionId: 'nobody', expectedVersion: 1, reason: 'x' }))).toBe('not_found')
  })

  it('reports an unknown response id as never accepted', () => {
    expect(store.responseStatus('nobody')).toEqual({
      ok: true,
      value: {
        responseId: 'nobody',
        status: 'not-accepted',
        interactionId: null,
        version: null,
        result: null,
        error: null,
      },
    })
  })

  it('keeps the question pending when the answer commit fails part way', () => {
    const { interactionId } = open(approvalRequest())
    const side = new DatabaseSync(path)
    side.exec(
      "CREATE TRIGGER refuse BEFORE INSERT ON accepted_answers BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    )
    side.close()
    expect(() => store.respond(approve(interactionId))).toThrow('disk full')
    expect(must(store.read(interactionId))).toMatchObject({ status: 'pending', version: 1 })
    expect(must(store.responseStatus('resp-1')).status).toBe('not-accepted')
    expect(store.wakes()).toEqual([])
  })
})

describe('reference interaction: one wake per terminal change', () => {
  const refused = (message: string) => ({
    ok: false as const,
    error: {
      code: 'retryable' as const,
      detailCode: 'backend_unavailable',
      message,
      retryAdvice: { kind: 'never' as const },
      diagnosticId: 'test-inbox',
    },
  })

  function answered() {
    const { interactionId } = open(approvalRequest())
    must(store.respond(approve(interactionId)))
    return `${interactionId}@2`
  }

  it('wakes the waiter once through the inbox fixture and marks the answer applied', async () => {
    const inbox = createRuntimeInboxFixture()
    const key = answered()
    const seen = waiter(inbox, key)
    expect(await store.flush(deliverTo(inbox))).toEqual({ acked: 1, retrying: 0, dead: 0 })
    expect(await store.flush(deliverTo(inbox))).toEqual({ acked: 0, retrying: 0, dead: 0 })
    expect(seen.woken).toBe(1)
    expect(store.wakes()[0]).toMatchObject({ delivery: 'acked', ackRef: inbox.notify(key).deliveryId })
    expect(must(store.responseStatus('resp-1')).status).toBe('applied')
  })

  it('redelivers after a restart without waking the waiter twice', async () => {
    const inbox = createRuntimeInboxFixture()
    const key = answered()
    const seen = waiter(inbox, key)
    // The first process delivered but stopped before recording the acknowledgement.
    inbox.notify(key)
    reopen()
    expect(must(store.responseStatus('resp-1')).status).toBe('accepted')
    expect(await store.flush(deliverTo(inbox))).toMatchObject({ acked: 1 })
    expect(seen.woken).toBe(1)
  })

  it('backs off between failures, caps the delay at a minute and parks the wake after 20 failures', async () => {
    const key = answered()
    const delays: number[] = []
    for (let attempt = 1; attempt <= 20; attempt++) {
      now = store.wakes()[0]?.dueAt ?? now
      expect(await store.flush(async () => refused('inbox refused'))).toEqual(
        attempt < 20 ? { acked: 0, retrying: 1, dead: 0 } : { acked: 0, retrying: 0, dead: 1 },
      )
      delays.push(Date.parse(store.wakes()[0]?.dueAt ?? now) - Date.parse(now))
    }
    expect(delays.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
    expect(store.wakes()[0]).toMatchObject({
      delivery: 'dead',
      failures: 20,
      lastError: { detailCode: 'backend_unavailable', message: 'inbox refused' },
    })
    now = '2026-10-09T00:00:00Z'
    expect(await store.flush(async () => refused('unused'))).toEqual({ acked: 0, retrying: 0, dead: 0 })

    expect(code(store.redrive('missing'))).toBe('not_found')
    const deliveries: string[] = []
    expect(store.redrive(key)).toMatchObject({ ok: true, value: { delivery: 'pending', failures: 0 } })
    const healthy: WakeSink = async (wake) => {
      deliveries.push(wake.deliveryKey)
      return { ok: true, value: { deliveryId: 'd-1' } }
    }
    expect(await store.flush(healthy)).toEqual({ acked: 1, retrying: 0, dead: 0 })
    expect(deliveries).toEqual([key])
    expect(code(store.redrive(key))).toBe('revision_conflict')
  })

  it('retries a thrown delivery once the delay has passed', async () => {
    answered()
    let fails = 1
    const flaky: WakeSink = async () => {
      if (fails-- > 0) throw new Error('inbox offline')
      return { ok: true, value: { deliveryId: 'd-1' } }
    }
    expect(await store.flush(flaky)).toEqual({ acked: 0, retrying: 1, dead: 0 })
    expect(store.wakes()[0]).toMatchObject({
      delivery: 'pending',
      failures: 1,
      dueAt: '2026-10-01T00:00:01.000Z',
      lastError: { detailCode: 'backend_unavailable', message: 'inbox offline' },
    })
    expect(await store.flush(flaky)).toEqual({ acked: 0, retrying: 0, dead: 0 })
    now = '2026-10-01T00:00:01Z'
    expect(await store.flush(flaky)).toEqual({ acked: 1, retrying: 0, dead: 0 })
  })

  it('delivers expiry wakes without touching any response', async () => {
    const { interactionId } = open(approvalRequest())
    now = '2026-10-08T00:00:00Z'
    must(store.expire({ interactionId, expectedVersion: 1, reason: 'timed out' }))
    const sent: Wire.Id[] = []
    const sink: WakeSink = async (wake) => {
      sent.push(`${wake.status}:${wake.responseId}`)
      return { ok: true, value: { deliveryId: 'd-1' } }
    }
    expect(await store.flush(sink)).toEqual({ acked: 1, retrying: 0, dead: 0 })
    expect(sent).toEqual(['expired:null'])
  })

  it('refuses every call once closed and leaves the database file', () => {
    store.close()
    expect(() => store.read('ix-1')).toThrow('interaction store is closed')
    expect(existsSync(path)).toBe(true)
  })
})

describe('reference interaction: conformance', () => {
  it('fills the interaction slot of the reference registry', () => {
    const slot = createReferenceRegistry([INTERACTION_PROVIDER]).find(
      (item) => item.contract === 'agh.interaction',
    )
    expect(slot?.provider).toEqual(INTERACTION_PROVIDER)
    expect(slot?.providerFile).toBe('examples/runtime-reference/src/providers/interaction.ts')
    expect(existsSync(new URL(`../../../../${slot?.providerFile}`, import.meta.url))).toBe(true)
  })

  async function runContract(change: (port: InteractionContractPort) => InteractionContractPort) {
    const harness = createConformanceHarness()
    const bound = bindInteractionContract(harness, 'reference-interaction-conformance', { change })
    try {
      return await harness.run({
        contracts: ['agh.interaction'],
        providers: [INTERACTION_PROVIDER.id],
        command: 'reference-interaction-conformance',
        clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
      })
    } finally {
      bound.close()
    }
  }

  it('passes select, normal, deny, cancel, recover and dispose', async () => {
    const report = await runContract((port) => port)
    expect(report.assertions.map((item) => [item.scenario, item.status])).toEqual(
      SCENARIOS.map((scenario) => [scenario, 'passed']),
    )
    expect(report.status).toBe('passed')
    expect(report.failures).toEqual([])
  })

  it('fails a scenario whose observations break the contract', async () => {
    const report = await runContract((port) => ({
      ...port,
      normal: async (context) => ({ ...(await port.normal(context)), woken: 2 }),
    }))
    expect(report.assertions.filter((item) => item.status === 'failed').map((item) => item.scenario)).toEqual(
      ['normal'],
    )
    expect(report.status).toBe('failed')
  })
})
