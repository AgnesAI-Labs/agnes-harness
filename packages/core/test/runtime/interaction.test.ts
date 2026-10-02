import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, computeApprovalIntentDigest } from '@agnes/protocol/runtime'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createInteractionAuthority,
  type InteractionEvidence,
  type InteractionStorage,
  type StoredInteractionResponse,
  type StoredInteractionWake,
} from '../../src/runtime/interaction/authority.js'

/** Copy-on-write store: a body that throws leaves the committed maps untouched. */
function memoryStorage(failPutResponse = false) {
  const records = new Map<string, Wire.InteractionRecord>()
  const responses = new Map<string, StoredInteractionResponse>()
  const wakes = new Map<string, StoredInteractionWake>()
  const storage: InteractionStorage = {
    async transaction(body) {
      const r = new Map(records)
      const s = new Map(responses)
      const w = new Map(wakes)
      const result = body({
        record: (id) => r.get(id),
        recordByIdempotencyKey: (key) => [...r.values()].find((x) => x.request.idempotencyKey === key),
        response: (id) => s.get(id),
        putRecord: (record) => void r.set(record.interactionId, record),
        putResponse: (response) => {
          if (failPutResponse) throw new Error('disk full')
          s.set(response.responseId, response)
        },
        wake: (key) => w.get(key),
        dueWakes: (at, limit) =>
          [...w.values()]
            .filter((x) => x.delivery === 'pending' && Date.parse(x.nextAttemptAt) <= Date.parse(at))
            .slice(0, limit),
        putWake: (wake) => void w.set(wake.wake.deliveryKey, wake),
      })
      records.clear()
      for (const [k, v] of r) records.set(k, v)
      responses.clear()
      for (const [k, v] of s) responses.set(k, v)
      wakes.clear()
      for (const [k, v] of w) wakes.set(k, v)
      return result
    },
  }
  return { storage, records, responses, wakes }
}

const inline = (typeId: string, value: Wire.JsonValue): Wire.DataRef => ({
  kind: 'inline',
  schema: { typeId, revision: 1, digest: 'a'.repeat(64) },
  value,
  digest: canonicalJsonDigest(value),
  bytes: new TextEncoder().encode(JSON.stringify(value)).length,
})

const human: InteractionEvidence = {
  kind: 'human',
  authenticationRef: inline('acme.identity/login@1', { session: 's1' }),
}
const owner = { runId: 'run-1', actionId: 'action-1' }

function approvalRequest(overrides: Record<string, unknown> = {}) {
  const base = {
    kind: 'approval',
    title: 'Delete build output',
    body: 'rm -rf dist',
    actionRef: 'action-7',
    inputDigest: 'b'.repeat(64),
    policyDecisionRef: 'policy-3',
    scope: { kind: 'workspace', installationId: 'i1', runtimeId: 'r1', workspaceId: 'w1' },
    allowedResponders: ['alice'],
    allowedGrantScopes: ['once', 'session'],
    expiresAt: '2026-10-08T00:00:00Z',
    idempotencyKey: 'ask-1',
    risk: 'destructive',
    intentDigest: '0'.repeat(64),
    ...overrides,
  }
  const digest = computeApprovalIntentDigest(base)
  if (!digest.ok) throw new Error('fixture is not an approval request')
  return { ...base, intentDigest: digest.value }
}

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
const answer = (value: Wire.JsonValue): Extract<Wire.DataRef, { kind: 'inline' }> => ({
  kind: 'inline',
  schema: answerSchema,
  value,
  digest: canonicalJsonDigest(value),
  bytes: new TextEncoder().encode(JSON.stringify(value)).length,
})

let now: string
let ids: number
let store: ReturnType<typeof memoryStorage>
let authority: ReturnType<typeof createInteractionAuthority>

beforeEach(() => {
  now = '2026-10-01T00:00:00Z'
  ids = 0
  store = memoryStorage()
  authority = createInteractionAuthority(store.storage, { now: () => now, newId: () => `ix-${++ids}` })
})

async function open(request: unknown) {
  const created = await authority.request({ request, owner })
  if (!created.ok) throw new Error(created.error.message)
  return created.value
}

const approve = (interactionId: string, extra: Record<string, unknown> = {}) => ({
  method: 'respondApproval' as const,
  actorRef: 'alice',
  evidence: human,
  request: {
    interactionId,
    responseId: 'resp-1',
    expectedVersion: 1,
    decision: 'approve',
    intentDigest: approvalRequest().intentDigest,
    ...extra,
  },
})

describe('interaction authority: questions open durably', () => {
  it('opens a pending version-1 record and reuses it for the same idempotency key', async () => {
    const first = await open(approvalRequest())
    expect(first).toMatchObject({ status: 'pending', version: 1, resolution: null, terminationReason: null })
    expect(await authority.request({ request: approvalRequest(), owner })).toEqual({ ok: true, value: first })
    now = '2026-10-09T00:00:00Z'
    expect(await authority.request({ request: approvalRequest(), owner })).toEqual({ ok: true, value: first })
    expect(store.records.size).toBe(1)
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
  ])('refuses %s', async (_name, request, detail) => {
    await open(approvalRequest())
    const refused = await authority.request({ request, owner })
    expect(refused.ok ? undefined : refused.error.detailCode).toBe(detail)
  })
})

describe('interaction authority: approval answers', () => {
  it('stores the platform answer, defaults the grant to once and wakes the waiter once', async () => {
    const { interactionId } = await open(approvalRequest())
    const accepted = await authority.respond(approve(interactionId))
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.value).toMatchObject({ status: 'accepted', version: 2, error: null })
    const record = (await authority.read(interactionId)) as { ok: true; value: Wire.InteractionRecord }
    expect(record.value.status).toBe('answered')
    expect(record.value.resolution?.answer).toMatchObject({
      kind: 'inline',
      schema: { typeId: 'agh.interaction/approval-answer@1' },
      value: { decision: 'approve', grantScope: 'once' },
    })
    expect([...store.wakes.values()]).toEqual([
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
        consecutiveFailures: 0,
        nextAttemptAt: now,
        lastError: null,
        ackRef: null,
      },
    ])

    expect(await authority.respond(approve(interactionId))).toEqual(accepted)
    expect(store.wakes.size).toBe(1)
    expect(await authority.responseStatus('resp-1')).toEqual(accepted)
  })

  it('records deny as an answered question', async () => {
    const { interactionId } = await open(approvalRequest())
    const denied = await authority.respond(approve(interactionId, { decision: 'deny' }))
    expect(denied.ok && denied.value.result).toMatchObject({
      status: 'answered',
      resolution: { answer: { value: { decision: 'deny' } } },
    })
  })

  it.each([
    ['a grant scope that was not offered', { grantScope: 'permanent' }, 'invalid_request'],
    ['deny with a grant scope', { decision: 'deny', grantScope: 'once' }, 'invalid_request'],
    ['another intent digest', { intentDigest: 'e'.repeat(64) }, 'invalid_request'],
    ['a stale version', { expectedVersion: 7 }, 'revision_conflict'],
  ])('refuses %s and leaves the question pending', async (_name, extra, detail) => {
    const { interactionId } = await open(approvalRequest())
    const refused = await authority.respond(approve(interactionId, extra))
    expect(refused.ok ? undefined : refused.error.detailCode).toBe(detail)
    expect(store.records.get(interactionId)?.status).toBe('pending')
    expect(store.wakes.size).toBe(0)
  })

  it('refuses an actor outside allowedResponders and an answer after expiry', async () => {
    const { interactionId } = await open(approvalRequest())
    const stranger = await authority.respond({ ...approve(interactionId), actorRef: 'mallory' })
    expect(stranger.ok ? undefined : stranger.error.detailCode).toBe('permission_denied')
    now = '2026-10-08T00:00:00Z'
    const late = await authority.respond(approve(interactionId))
    expect(late.ok ? undefined : late.error.detailCode).toBe('blocked')
    expect(store.records.get(interactionId)?.status).toBe('pending')
  })

  it('lets only one of two competing responses win', async () => {
    const { interactionId } = await open(approvalRequest())
    expect((await authority.respond(approve(interactionId))).ok).toBe(true)
    const second = await authority.respond(approve(interactionId, { responseId: 'resp-2' }))
    expect(second.ok ? undefined : second.error.detailCode).toBe('revision_conflict')
  })

  it('refuses a reused response id carrying a different answer', async () => {
    const { interactionId } = await open(approvalRequest())
    await authority.respond(approve(interactionId))
    const changed = await authority.respond(approve(interactionId, { grantScope: 'session' }))
    expect(changed.ok ? undefined : changed.error.detailCode).toBe('idempotency_conflict')
  })

  it('refuses a business schema sent through the generic response path', async () => {
    const { interactionId } = await open(approvalRequest())
    const custom = await authority.respond({
      method: 'acceptResponse',
      actorRef: 'alice',
      evidence: human,
      request: {
        interactionId,
        responseId: 'resp-9',
        expectedVersion: 1,
        answer: inline('acme.forms/approve@1', { decision: 'approve' }),
      },
    })
    expect(custom.ok ? undefined : custom.error.detailCode).toBe('invalid_request')
  })
})

describe('interaction authority: question answers', () => {
  const respond = (interactionId: string, value: Wire.JsonValue, ref: Wire.DataRef = answer(value)) =>
    authority.respond({
      method: 'acceptResponse',
      actorRef: 'alice',
      evidence: human,
      request: { interactionId, responseId: 'resp-q', expectedVersion: 1, answer: ref },
    })

  it('accepts a complete answer, including an explicit confirm=false', async () => {
    const { interactionId } = await open(question)
    const accepted = await respond(interactionId, {
      note: 'ok',
      channel: 'beta',
      targets: ['mac'],
      ok: false,
    })
    expect(accepted.ok && accepted.value.result?.status).toBe('answered')
  })

  it.each([
    ['an option label in place of its id', { note: 'ok', channel: 'Beta', ok: true }],
    ['a missing required field', { channel: 'beta', ok: true }],
    ['text over its limit', { note: 'x'.repeat(21), channel: 'beta', ok: true }],
    ['a line break in a single-line field', { note: 'a\nb', channel: 'beta', ok: true }],
    ['too many selections', { note: 'ok', channel: 'beta', targets: ['mac', 'win', 'linux'], ok: true }],
    ['a repeated selection', { note: 'ok', channel: 'beta', targets: ['mac', 'mac'], ok: true }],
    ['an unknown field', { note: 'ok', channel: 'beta', ok: true, extra: 1 }],
  ])('refuses %s', async (_name, value) => {
    const { interactionId } = await open(question)
    const refused = await respond(interactionId, value)
    expect(refused.ok ? undefined : refused.error.detailCode).toBe('invalid_request')
  })

  it('refuses another schema, tampered content and blob answers it cannot decode', async () => {
    const { interactionId } = await open(question)
    const value = { note: 'ok', channel: 'beta', ok: true }
    const otherSchema = await respond(interactionId, value, {
      ...answer(value),
      schema: { ...answerSchema, revision: 2 },
    })
    expect(otherSchema.ok ? undefined : otherSchema.error.detailCode).toBe('invalid_request')
    const tampered = await respond(interactionId, value, {
      ...answer(value),
      value: { note: 'no', channel: 'beta', ok: true },
    })
    expect(tampered.ok ? undefined : tampered.error.detailCode).toBe('invalid_request')
    const blob = await respond(interactionId, value, {
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
    expect(blob.ok ? undefined : blob.error.detailCode).toBe('unsupported')
  })
})

describe('interaction authority: expiry, cancellation and atomicity', () => {
  it('expires only when due, wakes once and treats a retry as the same change', async () => {
    const { interactionId } = await open(approvalRequest())
    const expire = { interactionId, expectedVersion: 1, reason: 'timed out' }
    const early = await authority.terminate('expire', expire)
    expect(early.ok ? undefined : early.error.detailCode).toBe('blocked')
    now = '2026-10-08T00:00:00Z'
    const expired = await authority.terminate('expire', expire)
    expect(expired.ok && expired.value).toMatchObject({
      status: 'expired',
      version: 2,
      terminationReason: 'timed out',
    })
    expect(await authority.terminate('expire', expire)).toEqual(expired)
    expect([...store.wakes.values()].map((w) => w.wake.status)).toEqual(['expired'])
  })

  it('cancels a pending question, refuses a late answer to it and does not cancel an answered one', async () => {
    const first = await open(approvalRequest())
    const cancelled = await authority.terminate('cancel', {
      interactionId: first.interactionId,
      expectedVersion: 1,
      reason: 'run aborted',
    })
    expect(cancelled.ok && cancelled.value.status).toBe('cancelled')
    // One client had not seen the cancel yet; the other had already read the cancelled version.
    for (const expectedVersion of [1, 2]) {
      const late = await authority.respond(
        approve(first.interactionId, { responseId: `late-${expectedVersion}`, expectedVersion }),
      )
      expect(late.ok ? undefined : late.error.detailCode).toBe('revision_conflict')
    }
    expect(store.records.get(first.interactionId)).toEqual(cancelled.ok && cancelled.value)
    expect(store.responses.size).toBe(0)
    expect(store.wakes.size).toBe(1)

    const second = await open(approvalRequest({ idempotencyKey: 'ask-2' }))
    await authority.respond(approve(second.interactionId))
    const late = await authority.terminate('cancel', {
      interactionId: second.interactionId,
      expectedVersion: 1,
      reason: 'too late',
    })
    expect(late.ok ? undefined : late.error.detailCode).toBe('revision_conflict')
  })

  it('reports an unknown response id as never accepted', async () => {
    expect(await authority.responseStatus('nobody')).toEqual({
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

  it('keeps the question pending when the answer commit fails part way', async () => {
    const failing = memoryStorage(true)
    const a = createInteractionAuthority(failing.storage, { now: () => now, newId: () => 'ix-1' })
    const created = await a.request({ request: approvalRequest(), owner })
    expect(created.ok).toBe(true)
    await expect(a.respond(approve('ix-1'))).rejects.toThrow('disk full')
    expect(failing.records.get('ix-1')?.status).toBe('pending')
    expect(failing.responses.size).toBe(0)
    expect(failing.wakes.size).toBe(0)
  })
})
