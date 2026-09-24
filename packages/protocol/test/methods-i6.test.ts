import { describe, expect, it } from 'vitest'
import { METHODS, type ValidationError, validateMethod } from '../src/index.js'

function errorsOf(r: ReturnType<typeof validateMethod>): ValidationError[] {
  if (r.ok) throw new Error('expected the payload to be rejected, but it validated')
  return r.errors
}

const actor = { id: 'u', org: 'local', role: 'member', deptPath: [], attrs: {} }
const channelCredential = {
  kind: 'channel',
  channel: 'dingtalk',
  accountId: 'account-1',
  userId: 'u',
  chatId: 'chat-1',
  chatType: 'group',
}
const jobSpec = {
  idempotencyKey: 'daily-report',
  sessionKey: 'agnes:local:default:cli:dm:main',
  payload: { prompt: 'prepare report' },
  schedule: { kind: 'once' },
}
const jobStatus = {
  jobId: 'job-1',
  status: 'waiting',
  attempts: 0,
  createdAt: '2026-09-11T00:00:00Z',
  updatedAt: '2026-09-11T00:00:00Z',
}

describe('I6 method contracts', () => {
  it('binds every I6 method as a c2s request', () => {
    for (const method of [
      '_agnes/v1/approval.decide',
      '_agnes/v1/participant.join',
      '_agnes/v1/participant.leave',
      '_agnes/v1/participant.list',
      '_agnes/v1/jobs.enqueue',
      '_agnes/v1/jobs.poll',
      '_agnes/v1/jobs.cancel',
      '_agnes/v1/artifact.job.status',
      '_agnes/v1/ext.ui.response',
      '_agnes/v1/directory.upsert',
    ] as const)
      expect(METHODS[method]).toMatchObject({ kind: 'request', direction: 'c2s' })
  })

  it('approval.decide uses a credential and rejects forged actor fields or verdicts', () => {
    expect(
      validateMethod('_agnes/v1/approval.decide', 'params', {
        ticket: 'ticket-1',
        verdict: 'allowed-once',
        approverCredential: channelCredential,
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/approval.decide', 'params', {
          ticket: 'ticket-1',
          verdict: 'allowed-once',
          approverCredential: { kind: 'local' },
          actor,
        }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_KEY', key: 'actor' }))
    expect(
      errorsOf(
        validateMethod('_agnes/v1/approval.decide', 'params', {
          ticket: 'ticket-1',
          verdict: 'cancelled',
          approverCredential: { kind: 'local' },
        }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'ENUM', key: 'verdict' }))
    expect(validateMethod('_agnes/v1/approval.decide', 'result', { seq: 1 }).ok).toBe(true)
  })

  it('participant join/leave share the credential contract and list returns participant records', () => {
    for (const method of ['_agnes/v1/participant.join', '_agnes/v1/participant.leave'] as const) {
      expect(validateMethod(method, 'params', { sessionId: 's', credential: channelCredential }).ok).toBe(
        true,
      )
      expect(errorsOf(validateMethod(method, 'params', { sessionId: 's' }))).toContainEqual(
        expect.objectContaining({ code: 'MISSING', key: 'credential' }),
      )
      expect(validateMethod(method, 'result', { seq: 2 }).ok).toBe(true)
    }
    expect(validateMethod('_agnes/v1/participant.list', 'params', { sessionId: 's' }).ok).toBe(true)
    expect(
      validateMethod('_agnes/v1/participant.list', 'result', {
        participants: [{ actor, joinedAt: '2026-09-11T00:00:00Z', surface: 'channel' }],
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(validateMethod('_agnes/v1/participant.list', 'result', { participants: [{ actor }] })),
    ).toContainEqual(expect.objectContaining({ path: '/participants/0', code: 'MISSING', key: 'joinedAt' }))
  })

  it('jobs methods reuse JobSpec and JobStatus and keep ids bounded', () => {
    expect(validateMethod('_agnes/v1/jobs.enqueue', 'params', jobSpec).ok).toBe(true)
    const { idempotencyKey: _idempotencyKey, ...jobWithoutId } = jobSpec
    expect(errorsOf(validateMethod('_agnes/v1/jobs.enqueue', 'params', jobWithoutId))).toContainEqual(
      expect.objectContaining({ code: 'MISSING', key: 'idempotencyKey' }),
    )
    expect(validateMethod('_agnes/v1/jobs.enqueue', 'result', { jobId: 'job-1' }).ok).toBe(true)

    expect(validateMethod('_agnes/v1/jobs.poll', 'params', { jobId: 'job-1' }).ok).toBe(true)
    expect(validateMethod('_agnes/v1/jobs.poll', 'result', jobStatus).ok).toBe(true)
    expect(
      errorsOf(validateMethod('_agnes/v1/jobs.poll', 'result', { ...jobStatus, status: 'unknown' })),
    ).toContainEqual(expect.objectContaining({ code: 'ENUM', key: 'status' }))

    expect(validateMethod('_agnes/v1/jobs.cancel', 'params', { jobId: 'job-1' }).ok).toBe(true)
    expect(errorsOf(validateMethod('_agnes/v1/jobs.cancel', 'params', {}))).toContainEqual(
      expect.objectContaining({ code: 'MISSING', key: 'jobId' }),
    )
    expect(validateMethod('_agnes/v1/jobs.cancel', 'result', {}).ok).toBe(true)
  })

  it('artifact.job.status returns the existing ArtifactJob register shape', () => {
    expect(validateMethod('_agnes/v1/artifact.job.status', 'params', { jobId: 'job-1' }).ok).toBe(true)
    expect(
      validateMethod('_agnes/v1/artifact.job.status', 'result', { jobId: 'job-1', status: 'running' }).ok,
    ).toBe(true)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/artifact.job.status', 'result', { jobId: 'job-1', status: 'waiting' }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'ENUM' }))
  })

  it('ext.ui.response closes actions and rejects extra identity fields', () => {
    expect(
      validateMethod('_agnes/v1/ext.ui.response', 'params', {
        sessionId: 's',
        requestSeq: 3,
        action: 'accept',
        data: { id: 'export' },
      }).ok,
    ).toBe(true)
    expect(
      errorsOf(
        validateMethod('_agnes/v1/ext.ui.response', 'params', {
          sessionId: 's',
          requestSeq: 3,
          action: 'ok',
        }),
      ),
    ).toContainEqual(expect.objectContaining({ code: 'ENUM', key: 'action' }))
    expect(validateMethod('_agnes/v1/ext.ui.response', 'result', { seq: 4 }).ok).toBe(true)
  })

  it('directory.upsert reuses DirectoryEntry and caps batch size', () => {
    const entry = { kind: 'user', id: 'u', name: 'Alice', syncedAt: '2026-09-11T00:00:00Z' }
    expect(validateMethod('_agnes/v1/directory.upsert', 'params', { entries: [entry] }).ok).toBe(true)
    expect(
      errorsOf(validateMethod('_agnes/v1/directory.upsert', 'params', { entries: [{ ...entry, actor }] })),
    ).toContainEqual(expect.objectContaining({ path: '/entries/0/actor', code: 'UNKNOWN_KEY', key: 'actor' }))
    expect(validateMethod('_agnes/v1/directory.upsert', 'result', { upserted: 1, deleted: 0 }).ok).toBe(true)
    expect(
      errorsOf(validateMethod('_agnes/v1/directory.upsert', 'params', { entries: Array(5001).fill(entry) })),
    ).toContainEqual(expect.objectContaining({ code: 'RANGE', key: 'entries' }))
  })
})
