import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Finer than the wire error code. Overload stays TRANSPORT on the wire. */
export type ModelFailureClass = 'rate_limit' | 'server' | 'timeout' | 'overload' | 'permanent'

export type ClassifiedModelFailure = {
  class: ModelFailureClass
  retryable: boolean
  retryAfterMs?: number
}

const CLASSES: Array<[RegExp, ModelFailureClass]> = [
  [/\b429\b|rate limit/i, 'rate_limit'],
  [/timed? ?out|ETIMEDOUT|deadline/i, 'timeout'],
  [/overloaded|at capacity/i, 'overload'],
  [/\b5\d{2}\b|ECONN|EAI_AGAIN|socket hang up/i, 'server'],
]

function retryAfterMs(text: string): number | undefined {
  const match = /retry[- ]after:?\s*(\d+)/i.exec(text)
  return match ? Number(match[1]) * 1000 : undefined
}

/** Classify raw provider text. Redacted messages drop the words this looks for. */
export function classifyModelFailure(text: string): ClassifiedModelFailure {
  for (const [pattern, failureClass] of CLASSES) {
    if (!pattern.test(text)) continue
    const retryAfter = failureClass === 'rate_limit' ? retryAfterMs(text) : undefined
    return {
      class: failureClass,
      retryable: true,
      ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
    }
  }
  return { class: 'permanent', retryable: false }
}

export type RetryDelayOptions = {
  initialDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
  retryAfterMs?: number
  random?: () => number
}

/** First retry (retryNumber 1) is 500ms before jitter, then doubles until 10s. */
export function nextRetryDelay(retryNumber: number, options: RetryDelayOptions = {}): number {
  if (options.retryAfterMs !== undefined) return options.retryAfterMs
  const initial = options.initialDelayMs ?? 500
  const max = options.maxDelayMs ?? 10_000
  const jitterRatio = options.jitterRatio ?? 0.1
  const exponent = Math.max(0, retryNumber - 1)
  const base = Math.min(initial * 2 ** exponent, max)
  const random = options.random ?? Math.random
  const delta = base * jitterRatio * (random() * 2 - 1)
  return Math.max(0, Math.round(base + delta))
}

export type RetryAttemptRecord = { count: number; updatedAt: number; resumeAt?: number }

export interface RetryAttemptLedger {
  read(key: string): RetryAttemptRecord | undefined
  /** `resumeAt` is when a committed sleep ends. The count stays fresh through that wait. */
  commit(key: string, count: number, resumeAt?: number): void
  clear(key: string): void
}

/** A count is fresh until its planned resume, then for the usual stale window. */
export function retryAttemptFresh(record: RetryAttemptRecord, now: number): boolean {
  const until =
    record.resumeAt !== undefined
      ? record.resumeAt + RETRY_ATTEMPT_STALE_MS
      : record.updatedAt + RETRY_ATTEMPT_STALE_MS
  return now < until
}

export function memoryRetryLedger(now: () => number = Date.now): RetryAttemptLedger {
  const records = new Map<string, RetryAttemptRecord>()
  return {
    read: (key) => records.get(key),
    commit(key, count, resumeAt) {
      records.set(key, {
        count,
        updatedAt: now(),
        ...(resumeAt !== undefined ? { resumeAt } : {}),
      })
    },
    clear(key) {
      records.delete(key)
    },
  }
}

/** Writes the next count before the caller sleeps. A crash during that sleep keeps the count. */
export function fileRetryLedger(dir: string): RetryAttemptLedger {
  const pathFor = (key: string) => join(dir, `${createHash('sha256').update(key).digest('hex')}.json`)
  const ensure = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  return {
    read(key) {
      try {
        const parsed = JSON.parse(readFileSync(pathFor(key), 'utf8')) as Partial<RetryAttemptRecord>
        if (typeof parsed.count === 'number' && typeof parsed.updatedAt === 'number')
          return {
            count: parsed.count,
            updatedAt: parsed.updatedAt,
            ...(typeof parsed.resumeAt === 'number' ? { resumeAt: parsed.resumeAt } : {}),
          }
      } catch {
        return undefined
      }
      return undefined
    },
    commit(key, count, resumeAt) {
      ensure()
      const path = pathFor(key)
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(
        temporary,
        JSON.stringify({
          count,
          updatedAt: Date.now(),
          ...(resumeAt !== undefined ? { resumeAt } : {}),
        }),
      )
      renameSync(temporary, path)
    },
    clear(key) {
      rmSync(pathFor(key), { force: true })
    },
  }
}

/** Drop a count that has sat unused longer than this. The adapter applies it on read. */
export const RETRY_ATTEMPT_STALE_MS = 120_000
