import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ERROR_BODY_CHARS,
  errorBodyPreview,
  INFRA_STOP_AFTER,
  infraFromLedger,
  infraFromStatuses,
  isInfraStatus,
  redactSecrets,
} from './infra.js'

// The ledgers are rows of the first evaluation's runs that the provider ended with HTTP 402 (the account
// was out of quota): `xws-05` in its first session, `xws-03` in its second after a clean first one.
const real = (name: string): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real', name), 'utf8')
const rows = (name: string): Record<string, unknown>[] =>
  real(name)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)

/** The real 402 turn end with its error replaced, to show what else the rule takes and refuses. */
const endedWith = (error: object): Record<string, unknown>[] => {
  const end = rows('infra-402.xws-05.off-s1.jsonl').find((r) => r.type === 'turn/end') as {
    data: object
  } & Record<string, unknown>
  return [{ ...end, data: { ...end.data, error } }]
}

describe('infrastructure failures in a ledger', () => {
  it('reads a turn the provider ended with 402 as an infrastructure failure', () => {
    expect(infraFromLedger(rows('infra-402.xws-05.off-s1.jsonl'), 0)).toEqual({
      session: 0,
      reason: 'QUOTA (HTTP 402)',
      status: 402,
    })
    // The second session of a run whose first session was fine.
    expect(infraFromLedger(rows('infra-402.xws-03.off-s2.jsonl'), 1)).toMatchObject({
      session: 1,
      status: 402,
    })
  })

  it('does not call a turn that completed one', () => {
    expect(infraFromLedger(rows('turns-completed.cross-01.off-s1.jsonl'))).toBeUndefined()
  })

  it('looks at the last turn: an earlier failure the session recovered from is not one', () => {
    expect(
      infraFromLedger([
        ...rows('infra-402.xws-05.off-s1.jsonl'),
        ...rows('turns-completed.cross-01.off-s1.jsonl'),
      ]),
    ).toBeUndefined()
  })

  it('takes the provider codes and the infrastructure statuses, and nothing else', () => {
    expect(infraFromLedger(endedWith({ code: 'AUTH', message: 'status=401 x' }))).toMatchObject({
      status: 401,
    })
    expect(infraFromLedger(endedWith({ code: 'RATE_LIMIT', message: 'status=429' }))).toMatchObject({
      status: 429,
    })
    expect(infraFromLedger(endedWith({ code: 'TRANSPORT', message: 'status=503' }))).toMatchObject({
      status: 503,
    })
    expect(infraFromLedger(endedWith({ code: 'TRANSPORT', message: 'connection reset' }))).toMatchObject({
      reason: 'TRANSPORT',
    })
    // A bad request, a refused format, a timeout, an abort: the task's, not the provider's.
    expect(infraFromLedger(endedWith({ code: 'FORMAT', message: 'status=400 bad request' }))).toBeUndefined()
    expect(infraFromLedger(endedWith({ code: 'TIMEOUT', message: 'timeout' }))).toBeUndefined()
    expect(infraFromLedger(endedWith({ code: 'ABORTED', message: 'aborted' }))).toBeUndefined()
  })

  it('ignores turns of other lanes', () => {
    const [end] = endedWith({ code: 'QUOTA', message: 'status=402' })
    expect(infraFromLedger([{ ...end, lane: 'refinement' }])).toBeUndefined()
  })
})

describe('infrastructure statuses', () => {
  it('are credentials, quota, rate limit and server errors', () => {
    for (const s of [401, 402, 403, 429, 500, 502, 503, 504]) expect(isInfraStatus(s), String(s)).toBe(true)
    for (const s of [200, 400, 404, 409, 413, 422]) expect(isInfraStatus(s), String(s)).toBe(false)
  })
  it('decide a run when its last three answers are all of them', () => {
    expect(infraFromStatuses([200, 200, 402, 402, 402])).toEqual({
      session: 0,
      reason: 'HTTP 402',
      status: 402,
    })
    expect(infraFromStatuses([200, 402, 402])).toBeUndefined()
    expect(infraFromStatuses([402, 402, 200])).toBeUndefined()
    expect(infraFromStatuses([402, 402])).toBeUndefined()
  })
  it('stop a shard after a few runs in a row, not after one', () => {
    expect(INFRA_STOP_AFTER).toBe(3)
  })
})

describe('error bodies', () => {
  it('lose what looks like a credential', () => {
    // Built from pieces so that no credential-shaped literal sits in this file.
    const bearer = ['Bear', 'er abcDEF123456.token-value'].join('')
    const skKey = ['s', 'k-abcdef1234567890'].join('')
    const fieldKey = ['api', '_key'].join('')
    const text = JSON.stringify({
      error: {
        message: `Authentication failed for ${bearer} and key ${skKey}`,
        [fieldKey]: 'k-live-0011223344',
        authorization: 'Basic dXNlcjpwYXNz',
        detail: 'x'.repeat(40),
        request_id: '61b19929-7f3c-448a-8e5a-cf70b8a38343',
      },
    })
    const out = redactSecrets(text, ['dXNlcjpwYXNz'])
    for (const secret of ['abcDEF123456', 'sk-abcdef', 'k-live-0011223344', 'dXNlcjpwYXNz', 'x'.repeat(40)])
      expect(out, secret).not.toContain(secret)
    // What helps to read the failure stays.
    expect(out).toContain('Authentication failed')
    expect(out).toContain('61b19929-7f3c-448a-8e5a-cf70b8a38343')
  })

  it('are cut to a preview', () => {
    const body = JSON.stringify({ error: { message: `Insufficient Balance ${'word '.repeat(300)}` } })
    const preview = errorBodyPreview(body)
    expect(preview.length).toBeLessThanOrEqual(ERROR_BODY_CHARS + 3)
    expect(preview.startsWith('{"error":{"message":"Insufficient Balance')).toBe(true)
    expect(errorBodyPreview('{"a": 1}')).toBe('{"a": 1}')
  })
})
