import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyModelFailure,
  fileRetryLedger,
  memoryRetryLedger,
  nextRetryDelay,
  RETRY_ATTEMPT_STALE_MS,
  retryAttemptFresh,
} from '../src/retry.js'

describe('classifyModelFailure', () => {
  it('classifies rate limit, timeout, overload, and 5xx as retryable, and auth text as permanent', () => {
    expect(classifyModelFailure('429 too many requests, retry-after: 2')).toEqual({
      class: 'rate_limit',
      retryable: true,
      retryAfterMs: 2000,
    })
    expect(classifyModelFailure('ETIMEDOUT waiting for the model')).toMatchObject({
      class: 'timeout',
      retryable: true,
    })
    expect(classifyModelFailure('the model is overloaded')).toMatchObject({
      class: 'overload',
      retryable: true,
    })
    expect(classifyModelFailure('503 Service Unavailable')).toMatchObject({
      class: 'server',
      retryable: true,
    })
    expect(classifyModelFailure('401 unauthorized')).toEqual({ class: 'permanent', retryable: false })
  })
})

describe('nextRetryDelay', () => {
  const random = () => 0.5

  it('starts at 500ms, doubles, and caps at 10s when jitter is zero', () => {
    expect(nextRetryDelay(1, { random })).toBe(500)
    expect(nextRetryDelay(2, { random })).toBe(1000)
    expect(nextRetryDelay(3, { random })).toBe(2000)
    expect(nextRetryDelay(8, { random })).toBe(10_000)
  })

  it('uses a provider retry-after when one is present', () => {
    expect(nextRetryDelay(1, { retryAfterMs: 2500, random })).toBe(2500)
  })
})

describe('retry attempt ledger', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('remembers a committed count until it is cleared', () => {
    let now = 1_000
    const ledger = memoryRetryLedger(() => now)
    expect(ledger.read('k')).toBeUndefined()
    ledger.commit('k', 2)
    now += RETRY_ATTEMPT_STALE_MS
    expect(ledger.read('k')).toEqual({ count: 2, updatedAt: 1_000 })
    ledger.clear('k')
    expect(ledger.read('k')).toBeUndefined()
  })

  it('writes the count before the caller would sleep', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-model-retry-'))
    dirs.push(dir)
    const ledger = fileRetryLedger(dir)
    ledger.commit('session\0route\0model', 3)
    expect(ledger.read('session\0route\0model')?.count).toBe(3)
    ledger.clear('session\0route\0model')
    expect(ledger.read('session\0route\0model')).toBeUndefined()
  })

  it('keeps a committed sleep fresh and stores the ledger under the injected root', () => {
    const root = mkdtempSync(join(tmpdir(), 'agh-home-'))
    dirs.push(root)
    const dir = join(root, 'model-retry')
    const ledger = fileRetryLedger(dir)
    ledger.commit('session\0route\0model', 2, 200_000)
    const record = ledger.read('session\0route\0model')
    expect(record).toMatchObject({ count: 2, resumeAt: 200_000 })
    expect(dir.startsWith(root)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(retryAttemptFresh({ count: 2, updatedAt: 0, resumeAt: 200_000 }, 150_000)).toBe(true)
    expect(retryAttemptFresh({ count: 2, updatedAt: 0 }, RETRY_ATTEMPT_STALE_MS)).toBe(false)
    expect(record && retryAttemptFresh(record, 200_000 + RETRY_ATTEMPT_STALE_MS - 1)).toBe(true)
  })
})
