import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EnumeratedItem } from '../src/batch/enumerate.js'
import {
  BatchRepo,
  type BatchRow,
  MAX_ERROR_CHARS,
  MAX_OUTPUT_BYTES,
  MAX_REASON_CHARS,
} from '../src/batch/repo.js'
import { sqliteTables } from './sqlite-tables.js'

const id = 'b0123456789ab'
const fresh = () => {
  let now = 1000
  const repo = new BatchRepo(sqliteTables().table('batches'), () => now)
  repo.create(
    {
      id,
      principalId: 'p',
      root: '/w',
      spec: { dir: 'images', prompt: 'x', budgetCredits: 5 },
      dirRel: 'images',
      outRel: `agh-batch/${id}`,
      concurrency: 2,
      itemTimeoutMs: 600_000,
      createdAt: 1000,
    },
    [
      { path: 'images/a.png', kind: 'image', bytes: 3 },
      { path: 'images/b.png', kind: 'image', bytes: 3 },
      { path: 'images/c.xlsx', kind: 'other', bytes: 3, skip: 'unsupported_type' },
      { path: 'images/d.txt', kind: 'text', bytes: 3 },
    ],
  )
  return { repo, tick: (ms: number) => (now += ms) }
}

describe('BatchRepo', () => {
  it('records a batch once with numbered items, skipped ones already settled', () => {
    const { repo } = fresh()
    expect(repo.create({ ...(repo.get(id) as BatchRow), createdAt: 1 }, [])).toBe(false)
    expect(repo.get(id)).toMatchObject({
      status: 'running',
      spent: 0,
      concurrency: 2,
      spec: { budgetCredits: 5 },
    })
    expect(repo.counts(id)).toEqual({
      pending: 3,
      running: 0,
      done: 0,
      invalid: 0,
      failed: 0,
      skipped: 1,
      cancelled: 0,
    })
    expect(repo.page(id, 0, 10).map((item) => [item.ordinal, item.status, item.error ?? null])).toEqual([
      [1, 'pending', null],
      [2, 'pending', null],
      [3, 'skipped', 'unsupported_type'],
      [4, 'pending', null],
    ])
  })

  it('moves items through running to a terminal state and keeps the spend total', () => {
    const { repo, tick } = fresh()
    const [first, second] = repo.nextPending(id, 2)
    expect([first?.ordinal, second?.ordinal]).toEqual([1, 2])
    repo.markRunning(id, 1, { jobId: 'j1', sessionKey: 's1', repairs: 0, startedAt: 5 })
    expect(repo.inflight(id)).toMatchObject([{ ordinal: 1, jobId: 'j1', sessionKey: 's1', startedAt: 5 }])
    tick(10)
    repo.settle(id, 1, { status: 'done', output: { count: 2 }, credits: 1.5 })
    repo.settle(id, 1, { status: 'failed', error: 'late', credits: 9 })
    repo.settle(id, 2, { status: 'failed', error: 'image_not_read', credits: 0.5 })
    repo.settle(id, 4, { status: 'invalid', error: 'image_not_read', credits: 0 })
    expect(repo.page(id, 0, 1)[0]).toMatchObject({ status: 'done', output: { count: 2 }, credits: 1.5 })
    expect(repo.get(id)?.spent).toBe(2)
    expect(repo.commonError(id)).toBe('image_not_read')
  })

  it('cancels what has not started and records the batch outcome', () => {
    const { repo } = fresh()
    repo.cancelPending(id, 'budget_exhausted')
    repo.setStatus(id, 'budget_exhausted', 'spent 5 of 5 credits')
    expect(repo.counts(id)).toMatchObject({ pending: 0, cancelled: 3 })
    expect(repo.get(id)).toMatchObject({ status: 'budget_exhausted', reason: 'spent 5 of 5 credits' })
    expect(repo.running()).toEqual([])
    expect(repo.listFor('p', 5).map((batch) => batch.id)).toEqual([id])
    expect(repo.listFor('someone else', 5)).toEqual([])
  })

  it('finds finished batches whose items were left pending or running', () => {
    const { repo } = fresh()
    expect(repo.unsettledFinished()).toEqual([])
    repo.markRunning(id, 1, { jobId: 'j1', sessionKey: 's1', repairs: 0, startedAt: 5 })
    expect(repo.unsettledFinished()).toEqual([])
    repo.setStatus(id, 'cancelled', 'cancelled by request')
    expect(repo.unsettledFinished().map((batch) => batch.id)).toEqual([id])
    repo.settle(id, 1, { status: 'cancelled', error: 'cancelled' })
    expect(repo.unsettledFinished().map((batch) => batch.id)).toEqual([id])
    repo.cancelPending(id, 'cancelled')
    expect(repo.unsettledFinished()).toEqual([])
  })
})

describe('BatchRepo state machine', () => {
  it('never revives a settled item, never lowers its repair count, never moves a skipped one', () => {
    const { repo } = fresh()
    expect(repo.markRunning(id, 1, { jobId: 'j1', sessionKey: 's1', repairs: 1, startedAt: 5 })).toBe(true)
    expect(repo.markRunning(id, 1, { jobId: 'j0', sessionKey: 's1', repairs: 0, startedAt: 6 })).toBe(false)
    expect(repo.page(id, 0, 1)[0]).toMatchObject({ jobId: 'j1', repairs: 1, startedAt: 5 })
    expect(repo.markRunning(id, 1, { jobId: 'j1', sessionKey: 's1', repairs: 1, startedAt: 5 })).toBe(true)
    expect(repo.settle(id, 1, { status: 'done', output: { ok: true }, credits: 1 })).toBe(true)
    expect(repo.markRunning(id, 1, { jobId: 'j2', sessionKey: 's1', repairs: 2, startedAt: 7 })).toBe(false)
    expect(repo.settle(id, 1, { status: 'cancelled' })).toBe(false)
    expect(repo.markRunning(id, 3, { jobId: 'j3', sessionKey: 's3', repairs: 0, startedAt: 7 })).toBe(false)
    expect(repo.settle(id, 3, { status: 'done', output: {}, credits: 4 })).toBe(false)
    expect(repo.page(id, 0, 3).map((item) => item.status)).toEqual(['done', 'pending', 'skipped'])
    expect(repo.get(id)?.spent).toBe(1)
    expect(repo.inflight(id)).toEqual([])
  })

  it('takes another job for a running item only with a higher repair count', () => {
    const { repo } = fresh()
    expect(repo.markRunning(id, 1, { jobId: 'j1', sessionKey: 's1', repairs: 0, startedAt: 5 })).toBe(true)
    expect(repo.markRunning(id, 1, { jobId: 'j-other', sessionKey: 's1', repairs: 0, startedAt: 6 })).toBe(
      false,
    )
    expect(repo.markRunning(id, 1, { jobId: 'j1', sessionKey: 's1', repairs: 0, startedAt: 5 })).toBe(true)
    expect(repo.markRunning(id, 1, { jobId: 'j1r', sessionKey: 's1', repairs: 1, startedAt: 7 })).toBe(true)
    expect(repo.markRunning(id, 1, { jobId: 'j1', sessionKey: 's1', repairs: 1, startedAt: 8 })).toBe(false)
    expect(repo.page(id, 0, 1)[0]).toMatchObject({ jobId: 'j1r', repairs: 1, startedAt: 7 })
  })

  it('tallies the items after a cursor by state without reading them', () => {
    const { repo } = fresh()
    repo.settle(id, 1, { status: 'done', output: {}, credits: 1 })
    repo.settle(id, 2, { status: 'failed', error: 'x', credits: 0.5 })
    repo.settle(id, 4, { status: 'done', output: {}, credits: 2 })
    const byState = (after: number) =>
      Object.fromEntries(repo.tally(id, after).map((row) => [row.status, [row.items, row.credits]]))
    expect(byState(0)).toEqual({ done: [2, 3], failed: [1, 0.5], skipped: [1, 0] })
    expect(byState(2)).toEqual({ done: [1, 2], skipped: [1, 0] })
    expect(byState(4)).toEqual({})
  })

  it('refuses a status outside the item states', () => {
    const { repo } = fresh()
    expect(() => repo.settle(id, 1, { status: 'skipped' as never })).toThrow(/item state/)
    expect(() => repo.settle(id, 1, { status: 'pending' as never })).toThrow(/item state/)
    expect(repo.page(id, 0, 1)[0]?.status).toBe('pending')
  })

  it('keeps the first batch outcome and refuses a status that is not a batch state', () => {
    const { repo } = fresh()
    expect(repo.setStatus(id, 'running', 'restarted')).toBe(false)
    expect(repo.get(id)?.reason).toBeUndefined()
    expect(repo.setStatus(id, 'cancelled', 'cancelled by request')).toBe(true)
    expect(repo.setStatus(id, 'completed')).toBe(false)
    expect(repo.setStatus(id, 'running')).toBe(false)
    expect(repo.get(id)).toMatchObject({ status: 'cancelled', reason: 'cancelled by request' })
    expect(() => repo.setStatus(id, 'paused' as never)).toThrow(/batch state/)
  })

  it('only counts items of its own batch', () => {
    const { repo } = fresh()
    const other = 'b0000000000ff'
    repo.create({ ...(repo.get(id) as BatchRow), id: other, createdAt: 2000 }, [
      { path: 'x.txt', kind: 'text', bytes: 1 },
    ])
    repo.settle(other, 1, { status: 'failed', error: 'other', credits: 7 })
    expect(repo.get(id)?.spent).toBe(0)
    expect(repo.counts(id).failed).toBe(0)
    expect(repo.commonError(id)).toBeUndefined()
    expect(repo.running().map((batch) => batch.id)).toEqual([id, other])
    expect(repo.listFor('p', 5).map((batch) => batch.id)).toEqual([other, id])
  })
})

describe('BatchRepo bounds', () => {
  it('stores an over-large or non-JSON answer as invalid instead of keeping it', () => {
    const { repo } = fresh()
    repo.settle(id, 1, { status: 'done', output: { text: 'x'.repeat(MAX_OUTPUT_BYTES) }, credits: 1 })
    repo.settle(id, 2, { status: 'done', output: { n: 1n } as unknown, credits: 1 })
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let i = 0; i < 40; i++) cursor = cursor.a = {} as Record<string, unknown>
    repo.settle(id, 4, { status: 'done', output: deep, credits: 1 })
    const items = repo.page(id, 0, 10)
    for (const ordinal of [1, 2, 4]) {
      const item = items.find((row) => row.ordinal === ordinal)
      expect(item).toMatchObject({ status: 'invalid', credits: 1 })
      expect(item?.output).toBeUndefined()
      expect(item?.error).toMatch(/^invalid_output: /)
    }
    expect(repo.get(id)?.spent).toBe(3)
  })

  it('keeps an answer just under the limit', () => {
    const { repo } = fresh()
    const text = 'x'.repeat(MAX_OUTPUT_BYTES - 20)
    repo.settle(id, 1, { status: 'done', output: { text }, credits: 0 })
    expect(repo.page(id, 0, 1)[0]).toMatchObject({ status: 'done', output: { text } })
  })

  it('clips errors and reasons and ignores credits that are not a finite positive number', () => {
    const { repo } = fresh()
    repo.settle(id, 1, {
      status: 'failed',
      error: `${'e'.repeat(MAX_ERROR_CHARS - 1)}😀tail`,
      credits: Number.NaN,
    })
    repo.settle(id, 2, { status: 'failed', error: 'x', credits: -4 })
    repo.settle(id, 4, { status: 'failed', error: 'x', credits: Number.POSITIVE_INFINITY })
    repo.cancelPending(id, 'r'.repeat(5000))
    repo.setStatus(id, 'failed', 'q'.repeat(5000))
    const error = repo.page(id, 0, 1)[0]?.error ?? ''
    expect(error.length).toBeLessThanOrEqual(MAX_ERROR_CHARS)
    // A clip never leaves half of a surrogate pair behind.
    expect(error).toBe('e'.repeat(MAX_ERROR_CHARS - 1))
    expect(repo.get(id)?.reason?.length).toBe(MAX_REASON_CHARS)
    expect(repo.get(id)?.spent).toBe(0)
    expect(repo.page(id, 0, 10).map((item) => item.credits)).toEqual([0, 0, 0, 0])
  })

  it('clamps page sizes and list limits', () => {
    const { repo } = fresh()
    expect(repo.page(id, 0, 0)).toHaveLength(1)
    expect(repo.page(id, 0, -5)).toHaveLength(1)
    expect(repo.page(id, 0, Number.NaN)).toHaveLength(1)
    expect(repo.nextPending(id, 1e9)).toHaveLength(3)
    expect(repo.listFor('p', 0)).toHaveLength(1)
  })
})

describe('BatchRepo storage', () => {
  it('stores hostile text as data, not SQL', () => {
    const { repo } = fresh()
    const nasty = "images/x'); DROP TABLE batch_items; --.png"
    const other = 'b00000000000a'
    repo.create({ ...(repo.get(id) as BatchRow), id: other, principalId: "p' OR '1'='1" }, [
      { path: nasty, kind: 'image', bytes: 1 },
    ])
    repo.settle(other, 1, { status: 'failed', error: "'; DELETE FROM batches; --", credits: 0 })
    expect(repo.page(other, 0, 1)[0]).toMatchObject({ path: nasty, error: "'; DELETE FROM batches; --" })
    expect(repo.listFor('p', 5).map((batch) => batch.id)).toEqual([id])
    expect(repo.counts(id).pending).toBe(3)
  })

  it('numbers a large batch in order and pages through it by cursor', () => {
    const tables = sqliteTables()
    const repo = new BatchRepo(tables.table('batches'), () => 0)
    const items: EnumeratedItem[] = Array.from({ length: 2345 }, (_, index) => ({
      path: `f/${String(index).padStart(5, '0')}.txt`,
      kind: 'text',
      bytes: index,
    }))
    repo.create(
      {
        id,
        principalId: 'p',
        root: '/w',
        spec: { dir: 'f', prompt: 'x' },
        dirRel: 'f',
        outRel: `agh-batch/${id}`,
        concurrency: 4,
        itemTimeoutMs: 600_000,
        createdAt: 0,
      },
      items,
    )
    const seen: number[] = []
    for (let after = 0; ; ) {
      const page = repo.page(id, after, 1000)
      if (page.length === 0) break
      for (const item of page) {
        expect(item.path).toBe(items[item.ordinal - 1]?.path)
        seen.push(item.ordinal)
      }
      after = page.at(-1)?.ordinal ?? after
    }
    expect(seen).toEqual(Array.from({ length: 2345 }, (_, index) => index + 1))
  })

  it('records a batch all or nothing', () => {
    const repo = new BatchRepo(sqliteTables().table('batches'), () => 0)
    const batch = {
      id,
      principalId: 'p',
      root: '/w',
      spec: { dir: 'f', prompt: 'x' },
      dirRel: 'f',
      outRel: `agh-batch/${id}`,
      concurrency: 4,
      itemTimeoutMs: 600_000,
      createdAt: 0,
    }
    const items = [
      ...Array.from({ length: 700 }, (_, index) => ({
        path: `f/${index}.txt`,
        kind: 'text' as const,
        bytes: 1,
      })),
      { path: null as unknown as string, kind: 'text' as const, bytes: 1 },
    ]
    expect(() => repo.create(batch, items)).toThrow()
    expect(repo.get(id)).toBeUndefined()
    expect(repo.page(id, 0, 10)).toEqual([])
    expect(repo.create(batch, items.slice(0, 2))).toBe(true)
    expect(repo.counts(id).pending).toBe(2)
  })

  it('keeps batches across a reopen of the same database file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-batch-repo-'))
    try {
      const file = join(dir, 'daemon.sqlite')
      const first = sqliteTables(file)
      const repo = new BatchRepo(first.table('batches'), () => 0)
      repo.create(
        {
          id,
          principalId: 'p',
          root: '/w',
          spec: { dir: 'f', prompt: 'x' },
          dirRel: 'f',
          outRel: `agh-batch/${id}`,
          concurrency: 4,
          itemTimeoutMs: 600_000,
          createdAt: 0,
        },
        [{ path: 'f/a.txt', kind: 'text', bytes: 1 }],
      )
      repo.settle(id, 1, { status: 'done', output: { text: 'ok' }, credits: 0.5 })
      await first.close()
      const second = sqliteTables(file)
      const reopened = new BatchRepo(second.table('batches'), () => 0)
      expect(reopened.get(id)).toMatchObject({ status: 'running', spent: 0.5 })
      expect(reopened.page(id, 0, 1)[0]).toMatchObject({ status: 'done', output: { text: 'ok' } })
      await second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
