import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rpcError } from '@agnes/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchAccessError, batchJobsPort } from '../src/batch/engine.js'
import { BatchSpecError, itemSessionKey } from '../src/batch/spec.js'
import { batchHarness, type FakeModel } from './batch-fakes.js'
import { sqliteTables } from './sqlite-tables.js'

const id = 'b0123456789ab'
const schema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }
const posix = process.platform !== 'win32'
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agh-engine-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const files = (names: string[], folder = 'items') => {
  mkdirSync(join(root, folder), { recursive: true })
  for (const name of names) writeFileSync(join(root, folder, name), 'x')
}
const begin = (h: ReturnType<typeof batchHarness>, spec: Record<string, unknown>, batchId = id) =>
  h.engine.begin({
    batchId,
    principalId: 'p',
    root,
    cwd: root,
    spec: { dir: 'items', prompt: 'Count {{name}}', ...spec },
  })
const lines = (name: string, batchId = id): unknown[] =>
  readFileSync(join(root, 'agh-batch', batchId, name), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const key = (ordinal: number, batchId = id) => itemSessionKey('default', batchId, ordinal)
const unfinishedJobs = (h: ReturnType<typeof batchHarness>, batchId = id): number =>
  h.tables
    .table('jobs')
    .get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key LIKE ? AND status IN ('waiting', 'delayed', 'active')",
      [`batch:${batchId}:%`],
    )?.n ?? 0

describe('BatchEngine', () => {
  it('processes images and text with a schema and writes the result files', async () => {
    files(['a.png', 'b.jpg', 'c.txt', 'd.xlsx'])
    const h = batchHarness({
      root,
      model: (_prompt, _key, _turn) => ({ reply: '{"count":2}', credits: 0.5 }),
    })
    const started = await begin(h, { schema })
    expect(started).toMatchObject({
      batchId: id,
      status: 'running',
      counts: { total: 4, pending: 3, skipped: 1 },
    })
    const status = await h.run(id)
    expect(status).toMatchObject({ status: 'completed', counts: { done: 3, skipped: 1 }, spentCredits: 1.5 })
    expect(status.summary).toContain('| count | n=3, min 2, mean 2, max 2 |')
    expect(lines('results.jsonl')).toEqual(
      [1, 2, 3].map((ordinal) => expect.objectContaining({ ordinal, output: { count: 2 } })),
    )
    expect(lines('errors.jsonl')).toEqual([
      expect.objectContaining({ ordinal: 4, status: 'skipped', error: 'unsupported_type' }),
    ])
    expect(h.sessions.prepared).toEqual([1, 2, 3].map((n) => itemSessionKey('default', id, n)))
  })

  it('closes an item session once the item is settled, not while it waits for its repair', async () => {
    files(['a.png'])
    const h = batchHarness({
      root,
      model: (_prompt, _key, turn) => ({ reply: turn === 1 ? '{"count":"many"}' : '{"count":3}' }),
    })
    await begin(h, { schema })
    await h.engine.tick()
    await h.scheduler.tick()
    await h.engine.tick()
    expect(h.repo.page(id, 0, 1)[0]).toMatchObject({ status: 'running', repairs: 1 })
    expect(h.sessions.released).toEqual([])
    await h.run(id)
    expect(h.sessions.released).toEqual([itemSessionKey('default', id, 1)])
  })

  it('repairs an answer that breaks the schema once, in the same item session', async () => {
    files(['a.png'])
    const h = batchHarness({
      root,
      model: (_prompt, _key, turn) => ({ reply: turn === 1 ? '{"count":"many"}' : '{"count":3}' }),
    })
    await begin(h, { schema })
    expect((await h.run(id)).counts).toMatchObject({ done: 1 })
    expect(lines('results.jsonl')).toEqual([expect.objectContaining({ output: { count: 3 } })])
    expect([h.jobsRepo.get(`batch:${id}:1:0`)?.status, h.jobsRepo.get(`batch:${id}:1:1`)?.status]).toEqual([
      'completed',
      'completed',
    ])
  })

  it('marks an answer invalid when the repair also breaks the schema', async () => {
    files(['a.png'])
    const h = batchHarness({ root, model: () => ({ reply: '{"count":"many"}' }) })
    await begin(h, { schema })
    expect((await h.run(id)).counts).toMatchObject({ invalid: 1 })
    expect(lines('errors.jsonl')).toEqual([
      expect.objectContaining({ status: 'invalid', error: expect.stringContaining('/count') }),
    ])
  })

  it('stores plain text when there is no schema', async () => {
    files(['notes.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'Two weevils.' }) })
    await begin(h, {})
    await h.run(id)
    expect(lines('results.jsonl')).toEqual([expect.objectContaining({ output: { text: 'Two weevils.' } })])
  })

  it('stops after five failures with no success when the model never sees the images', async () => {
    files(Array.from({ length: 12 }, (_, i) => `${String(i).padStart(2, '0')}.png`))
    const h = batchHarness({ root, model: () => ({ image: false, reply: '{"count":0}' }) })
    await begin(h, { schema })
    const status = await h.run(id)
    expect(status).toMatchObject({ status: 'failed', counts: { done: 0, failed: 8, cancelled: 4 } })
    expect(status.reason).toContain('image_not_read')
  })

  it('never has more unfinished jobs than the batch concurrency', async () => {
    files(Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, '0')}.txt`))
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, { concurrency: 3 })
    let most = 0
    await h.run(id, { onRound: () => (most = Math.max(most, unfinishedJobs(h))) })
    expect(most).toBe(3)
    expect(h.sessions.counters.maxRunning).toBeLessThanOrEqual(3)
  })

  it('stops starting items once the budget is spent and passes the remainder to each job', async () => {
    files(Array.from({ length: 6 }, (_, i) => `${i}.txt`))
    const h = batchHarness({ root, model: () => ({ reply: 'ok', credits: 1 }) })
    await begin(h, { concurrency: 1, budgetCredits: 2.5 })
    const status = await h.run(id)
    expect(status).toMatchObject({
      status: 'budget_exhausted',
      counts: { done: 3, cancelled: 3 },
      spentCredits: 3,
    })
    expect([h.jobsRepo.get(`batch:${id}:1:0`)?.budget, h.jobsRepo.get(`batch:${id}:3:0`)?.budget]).toEqual([
      2.5, 0.5,
    ])
  })

  it('treats a remaining budget that a job would carry as 0 as spent', async () => {
    files(['a.txt', 'b.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok', credits: 0.99996 }) })
    // Nothing starts under a budget below the job budget's precision.
    await begin(h, { concurrency: 1, budgetCredits: 0.00004 })
    expect(await h.run(id)).toMatchObject({ status: 'budget_exhausted', counts: { cancelled: 2 } })
    expect(h.jobsRepo.get(`batch:${id}:1:0`)).toBeUndefined()
    // After one item, 0.00004 is left: rounded to 0, so the second item does not start.
    const next = 'b0000000000b2'
    await begin(h, { concurrency: 1, budgetCredits: 1 }, next)
    expect(await h.run(next)).toMatchObject({ status: 'budget_exhausted', counts: { done: 1, cancelled: 1 } })
    expect(h.jobsRepo.get(`batch:${next}:2:0`)).toBeUndefined()
  })

  it('completes a batch whose last items carry the spend past the budget', async () => {
    files(['a.txt', 'b.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok', credits: 1 }) })
    await begin(h, { concurrency: 2, budgetCredits: 1.5 })
    expect(await h.run(id)).toMatchObject({ status: 'completed', counts: { done: 2 }, spentCredits: 2 })
  })

  it('cancels an item that runs past its time limit', async () => {
    files(['a.txt'])
    let now = 1_000_000
    const h = batchHarness({ root, clock: () => now, model: () => ({ hang: true }) })
    await begin(h, { itemTimeoutSec: 60 })
    await h.engine.tick()
    const wave = h.scheduler.tick()
    await vi.waitFor(() => expect(h.sessions.counters.running).toBe(1))
    now += 61_000
    await h.engine.tick()
    await wave
    expect(h.repo.page(id, 0, 1)[0]).toMatchObject({ status: 'failed', error: 'timeout' })
    expect(h.jobsRepo.get(`batch:${id}:1:0`)?.status).toBe('cancelled')
    expect(h.sessions.released).toEqual([key(1)])
  })

  it('cancels on request and still writes the files', async () => {
    files(['a.txt', 'b.txt', 'c.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, { concurrency: 1 })
    await h.engine.tick()
    const status = await h.engine.cancel('p', id)
    expect(status).toMatchObject({ status: 'cancelled', counts: { cancelled: 3 } })
    expect(status.files).toContain(`agh-batch/${id}/summary.md`)
    expect(h.jobsRepo.get(`batch:${id}:1:0`)?.status).toBe('cancelled')
  })

  it('carries on with a new engine on the same tables, each item settled once', async () => {
    files(Array.from({ length: 6 }, (_, i) => `${i}.txt`))
    const tables = sqliteTables()
    const dir = join(root, '.transcripts')
    const model: FakeModel = (prompt) => ({ reply: /Item (\d+)/u.exec(prompt)?.[1] ?? '?' })
    const first = batchHarness({ root, tables, dir, model })
    await begin(first, { concurrency: 2 })
    await first.engine.tick()
    await first.scheduler.tick()
    const second = batchHarness({ root, tables, dir, model })
    expect((await second.run(id)).counts).toMatchObject({ done: 6 })
    expect(lines('results.jsonl').map((row) => (row as { ordinal: number }).ordinal)).toEqual([
      1, 2, 3, 4, 5, 6,
    ])
    expect(
      tables
        .table('jobs')
        .all('SELECT idempotency_key FROM jobs WHERE idempotency_key LIKE ?', [`batch:${id}:%`]),
    ).toHaveLength(6)
  })

  it('enqueues again when an item was recorded as running but its job was never written', async () => {
    files(['a.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, {})
    h.repo.markRunning(id, 1, {
      jobId: `batch:${id}:1:0`,
      sessionKey: itemSessionKey('default', id, 1),
      repairs: 0,
      startedAt: Date.now(),
    })
    expect(h.jobsRepo.get(`batch:${id}:1:0`)).toBeUndefined()
    expect((await h.run(id)).counts).toMatchObject({ done: 1 })
  })

  it('returns the same batch for a repeated start and hides it from other principals', async () => {
    files(['a.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, {})
    expect((await begin(h, {})).batchId).toBe(id)
    await expect(
      h.engine.begin({
        batchId: id,
        principalId: 'other',
        root,
        cwd: root,
        spec: { dir: 'items', prompt: 'x' },
      }),
    ).rejects.toBeInstanceOf(BatchAccessError)
    await expect(h.engine.status('other', id)).rejects.toBeInstanceOf(BatchAccessError)
    expect(h.engine.list('other')).toEqual([])
  })

  it('refuses a folder with no supported files', async () => {
    files(['a.xlsx'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await expect(begin(h, {})).rejects.toBeInstanceOf(BatchSpecError)
  })
})

describe('BatchEngine: provider errors and invalid output', () => {
  it('retries a turn that ended in a provider error and settles the item once', async () => {
    files(['a.txt'])
    let now = 1_000_000
    const h = batchHarness({
      root,
      clock: () => now,
      model: (_prompt, _key, turn) =>
        turn === 1 ? { fail: '429 Too Many Requests', credits: 0.05 } : { reply: 'ok', credits: 0.5 },
    })
    await begin(h, {})
    const status = await h.run(id, { onRound: () => (now += 5_000) })
    expect(status).toMatchObject({ status: 'completed', counts: { done: 1 }, spentCredits: 0.55 })
    expect(h.jobsRepo.get(`batch:${id}:1:0`)).toMatchObject({ status: 'completed', attempts: 1 })
    expect(h.sessions.counters.turns).toBe(2)
  })

  it('fails an item whose turns keep failing after the job retries and goes on with the rest', async () => {
    files(['a.txt', 'b.txt'])
    let now = 1_000_000
    const h = batchHarness({
      root,
      clock: () => now,
      model: (prompt) => (/Item 1:/u.test(prompt) ? { fail: '529 Overloaded' } : { reply: 'ok' }),
    })
    await begin(h, {})
    const status = await h.run(id, { onRound: () => (now += 5_000) })
    expect(status).toMatchObject({ status: 'completed', counts: { done: 1, failed: 1 } })
    expect(lines('errors.jsonl')).toEqual([
      expect.objectContaining({ ordinal: 1, status: 'failed', error: 'job_failed: 529 Overloaded' }),
    ])
    expect(h.jobsRepo.get(`batch:${id}:1:0`)).toMatchObject({ status: 'failed', attempts: 3 })
  })

  it('asks for a repair of a reply that is not JSON, naming the problem, then gives up', async () => {
    files(['a.png'])
    const h = batchHarness({ root, model: () => ({ reply: 'I count two weevils.' }) })
    await begin(h, { schema })
    expect((await h.run(id)).counts).toMatchObject({ invalid: 1 })
    expect(h.jobsRepo.get(`batch:${id}:1:1`)?.payload).toEqual({
      prompt: expect.stringContaining('not a single JSON object'),
    })
    expect(lines('errors.jsonl')).toEqual([
      expect.objectContaining({ status: 'invalid', error: expect.stringContaining('I count two weevils.') }),
    ])
    expect(h.sessions.counters.turns).toBe(2)
  })

  it('does not repair an item whose file was never read', async () => {
    files(['a.png'])
    const h = batchHarness({ root, model: () => ({ read: false, reply: '{"count":1}' }) })
    await begin(h, { schema })
    expect((await h.run(id)).counts).toMatchObject({ failed: 1 })
    expect(h.jobsRepo.get(`batch:${id}:1:1`)).toBeUndefined()
    expect(lines('errors.jsonl')).toEqual([expect.objectContaining({ error: 'image_not_read' })])
  })

  it('re-sends a lost repair job with the problem read back from the ledger', async () => {
    files(['a.png'])
    const h = batchHarness({
      root,
      model: (_prompt, _key, turn) => ({ reply: turn === 1 ? '{"count":"many"}' : '{"count":3}' }),
    })
    await begin(h, { schema })
    await h.engine.tick()
    await h.scheduler.tick()
    // Stopped after recording the repair run but before writing its job.
    h.repo.markRunning(id, 1, {
      jobId: `batch:${id}:1:1`,
      sessionKey: key(1),
      repairs: 1,
      startedAt: Date.now(),
    })
    await h.engine.tick()
    expect(h.jobsRepo.get(`batch:${id}:1:1`)?.payload).toEqual({ prompt: expect.stringContaining('/count') })
    expect((await h.run(id)).counts).toMatchObject({ done: 1 })
  })
})

describe('BatchEngine: confinement and item sessions', () => {
  it('fails the batch without running an item when item sessions are not confined to reading', async () => {
    files(['a.txt', 'b.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    h.confinement.ready = false
    await begin(h, {})
    const status = await h.run(id)
    expect(status).toMatchObject({ status: 'failed', counts: { cancelled: 2 } })
    expect(status.reason).toContain('confinement_unavailable')
    expect(h.sessions.prepared).toEqual([])
    expect(h.tables.table('jobs').all('SELECT idempotency_key FROM jobs')).toEqual([])
  })

  it('stops a running batch, cancelling its jobs, when the confinement goes away', async () => {
    files(['a.txt', 'b.txt', 'c.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, { concurrency: 1 })
    await h.engine.tick()
    expect(h.jobsRepo.get(`batch:${id}:1:0`)?.status).toBe('waiting')
    h.confinement.ready = false
    await h.engine.tick()
    const status = await h.engine.status('p', id)
    expect(status).toMatchObject({ status: 'failed', counts: { cancelled: 3 } })
    expect(status.reason).toContain('confinement_unavailable')
    expect(h.jobsRepo.get(`batch:${id}:1:0`)?.status).toBe('cancelled')
    expect(h.sessions.released).toEqual([key(1)])
  })

  it('runs item sessions in the workspace root even when the batch starts from a subfolder', async () => {
    files(['a.txt'], 'lab/items')
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await h.engine.begin({
      batchId: id,
      principalId: 'p',
      root,
      cwd: join(root, 'lab'),
      spec: { dir: 'items', prompt: 'x' },
    })
    expect((await h.run(id)).counts).toMatchObject({ done: 1 })
    // The session is bound to `root` here; that the real binding opens it there is the daemon wiring's to test.
    expect(h.sessions.preparedFor).toEqual([{ principalId: `batch:${id}`, root }])
    expect(lines('results.jsonl')).toEqual([expect.objectContaining({ path: 'lab/items/a.txt' })])
  })

  it('leaves no item session open once the batch is over, closing each one once', async () => {
    files(Array.from({ length: 10 }, (_, i) => `${i}.txt`))
    const h = batchHarness({
      root,
      model: (prompt) => (/Item 3:/u.test(prompt) ? { read: false, reply: 'guess' } : { reply: 'ok' }),
    })
    await begin(h, { concurrency: 4 })
    expect((await h.run(id)).counts).toMatchObject({ done: 9, failed: 1 })
    await vi.waitFor(() => expect(h.sessions.registry.keys()).toEqual([]))
    expect([...h.sessions.released].sort()).toEqual(Array.from({ length: 10 }, (_, i) => key(i + 1)).sort())
  })

  it('cancels the jobs of items in flight, closes their sessions and starts nothing afterwards', async () => {
    files(['a.txt', 'b.txt', 'c.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, { concurrency: 2 })
    await h.engine.tick()
    expect(await h.engine.cancel('p', id)).toMatchObject({ status: 'cancelled', counts: { cancelled: 3 } })
    expect([h.jobsRepo.get(`batch:${id}:1:0`)?.status, h.jobsRepo.get(`batch:${id}:2:0`)?.status]).toEqual([
      'cancelled',
      'cancelled',
    ])
    expect(h.sessions.released).toEqual([key(1), key(2)])
    expect((await h.engine.cancel('p', id)).status).toBe('cancelled')
    await h.engine.tick()
    await h.scheduler.tick()
    expect(h.sessions.counters.turns).toBe(0)
    expect(h.sessions.released).toEqual([key(1), key(2)])
  })

  it('starts nothing for a batch cancelled while a tick is preparing an item', async () => {
    files(['a.txt', 'b.txt'])
    let open!: () => void
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    let held = 0
    const h = batchHarness({
      root,
      model: () => ({ reply: 'ok' }),
      prepare: async () => {
        held++
        await gate
      },
    })
    await begin(h, { concurrency: 1 })
    const tick = h.engine.tick()
    await vi.waitFor(() => expect(held).toBe(1))
    const cancelled = h.engine.cancel('p', id)
    open()
    await Promise.all([tick, cancelled])
    expect((await h.engine.status('p', id)).counts).toMatchObject({ cancelled: 2 })
    expect(unfinishedJobs(h)).toBe(0)
  })
})

describe('BatchEngine: failures that must not stall a batch', () => {
  it('fails an item whose prompt would be too long for a job and goes on', async () => {
    const long = 'x'.repeat(200)
    files(['a.txt'], `items/${long}`)
    files(['b.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await h.engine.begin({
      batchId: id,
      principalId: 'p',
      root,
      cwd: root,
      spec: { dir: 'items', prompt: '{{path}}'.repeat(2000) },
    })
    expect((await h.run(id)).counts).toMatchObject({ done: 1, failed: 1 })
    expect(lines('errors.jsonl')).toEqual([
      expect.objectContaining({
        path: `items/${long}/a.txt`,
        error: expect.stringContaining('prompt_too_long'),
      }),
    ])
    expect(h.sessions.prepared).toEqual([key(1)])
  })

  it('fails an item whose job the queue refuses and goes on with the next', async () => {
    files(['a.txt', 'b.txt'])
    const h = batchHarness({
      root,
      model: () => ({ reply: 'ok' }),
      jobs: (port) => ({
        ...port,
        enqueue: async (spec) => {
          if (spec.idempotencyKey.endsWith(':1:0')) throw new Error('queue full')
          return port.enqueue(spec)
        },
      }),
    })
    await begin(h, {})
    expect((await h.run(id)).counts).toMatchObject({ done: 1, failed: 1 })
    expect(lines('errors.jsonl')).toEqual([expect.objectContaining({ error: 'enqueue_failed: queue full' })])
    expect(h.sessions.released).toContain(key(1))
  })

  it('fails an item whose session cannot be prepared without enqueueing its job', async () => {
    files(['a.txt', 'b.txt'])
    const h = batchHarness({
      root,
      model: () => ({ reply: 'ok' }),
      prepare: async (sessionKey) => {
        if (sessionKey === key(1)) throw new Error('owner refused')
      },
    })
    await begin(h, {})
    expect((await h.run(id)).counts).toMatchObject({ done: 1, failed: 1 })
    expect(lines('errors.jsonl')).toEqual([
      expect.objectContaining({ error: 'session_unavailable: owner refused' }),
    ])
    expect(h.jobsRepo.get(`batch:${id}:1:0`)).toBeUndefined()
  })

  it('fails an item whose ledger cannot be read within its time limit instead of retrying forever', async () => {
    files(['a.txt'])
    let now = 1_000_000
    const h = batchHarness({
      root,
      clock: () => now,
      model: () => ({ reply: 'ok' }),
      transcriptFails: () => true,
    })
    await begin(h, { itemTimeoutSec: 60 })
    await h.engine.tick()
    await h.scheduler.tick()
    await h.engine.tick()
    await h.engine.tick()
    expect(h.repo.page(id, 0, 1)[0]?.status).toBe('running')
    expect(h.logs.filter((line) => line.includes('ledger unavailable'))).toHaveLength(1)
    now += 61_000
    const status = await h.run(id)
    expect(status).toMatchObject({ status: 'completed', counts: { failed: 1 } })
    expect(lines('errors.jsonl')).toEqual([
      expect.objectContaining({ error: 'outcome_unavailable: ledger unavailable' }),
    ])
  })

  it('gives items in flight a fresh time limit after a restart instead of timing them out', async () => {
    files(['a.txt'])
    let now = 1_000_000
    const tables = sqliteTables()
    const first = batchHarness({ root, tables, clock: () => now, model: () => ({ reply: 'ok' }) })
    await begin(first, { itemTimeoutSec: 60 })
    await first.engine.tick()
    now += 3_600_000
    const second = batchHarness({ root, tables, clock: () => now, model: () => ({ reply: 'ok' }) })
    expect((await second.run(id)).counts).toMatchObject({ done: 1 })
  })

  it('runs a job again when the process that held it stopped mid-turn, and settles the item once', async () => {
    files(['a.txt', 'b.txt'])
    let now = 1_000_000
    const tables = sqliteTables()
    const first = batchHarness({ root, tables, clock: () => now, model: () => ({ reply: 'ok' }) })
    await begin(first, { concurrency: 2 })
    await first.engine.tick()
    // Another process claimed both jobs and died before finishing them.
    expect(first.jobsRepo.claimDue(now, 'gone', 60_000, 16)).toHaveLength(2)
    now += 120_000
    const second = batchHarness({
      root,
      tables,
      clock: () => now,
      model: () => ({ reply: 'ok', credits: 0.25 }),
    })
    const status = await second.run(id)
    expect(status).toMatchObject({ counts: { done: 2 }, spentCredits: 0.5 })
    expect(second.jobsRepo.get(`batch:${id}:1:0`)).toMatchObject({ status: 'completed', stalledCounter: 1 })
    expect(lines('results.jsonl')).toHaveLength(2)
  })

  it('finishes the clean-up of a batch whose outcome was recorded just before the process stopped', async () => {
    files(['a.txt', 'b.txt', 'c.txt'])
    const tables = sqliteTables()
    const first = batchHarness({ root, tables, model: () => ({ reply: 'ok' }) })
    await begin(first, { concurrency: 2 })
    await first.engine.tick()
    first.repo.setStatus(id, 'cancelled', 'cancelled by request')
    const h = batchHarness({ root, tables, model: () => ({ reply: 'ok' }) })
    await h.engine.tick()
    const status = await h.engine.status('p', id)
    expect(status).toMatchObject({ status: 'cancelled', counts: { cancelled: 3, running: 0, pending: 0 } })
    expect(unfinishedJobs(h)).toBe(0)
    expect(h.sessions.released).toEqual([key(1), key(2)])
    expect(status.summary).toContain('Cancelled 3')
    expect(first.sessions.released).toEqual([])
  })
})

describe('BatchEngine: status, list and the timer', () => {
  it('lists the batches of a principal', async () => {
    files(['a.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, {})
    expect(h.engine.list('p')).toEqual([expect.objectContaining({ batchId: id, status: 'running' })])
  })

  it('exports partial results of a running batch on request', async () => {
    files(['a.txt', 'b.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, { concurrency: 1 })
    await h.engine.tick()
    await h.scheduler.tick()
    await h.engine.tick()
    expect((await h.engine.status('p', id)).files).toBeUndefined()
    const status = await h.engine.status('p', id, true)
    expect(status).toMatchObject({ status: 'running', counts: { done: 1, running: 1 } })
    expect(status.files).toContain(`agh-batch/${id}/results.jsonl`)
    expect(lines('results.jsonl')).toHaveLength(1)
  })

  it.skipIf(!posix)(
    'reports a finished batch summary without following a link planted in its place',
    async () => {
      files(['a.txt'])
      const outside = mkdtempSync(join(tmpdir(), 'agh-engine-outside-'))
      try {
        const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
        await begin(h, {})
        expect((await h.run(id)).summary).toContain(`# Batch ${id}`)
        const summary = join(root, 'agh-batch', id, 'summary.md')
        writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET')
        rmSync(summary)
        symlinkSync(join(outside, 'secret.txt'), summary)
        const status = await h.engine.status('p', id)
        expect(status.summary).toBeUndefined()
        expect(status.files).toBeUndefined()
        expect(JSON.stringify(status)).not.toContain('TOP SECRET')
        const exported = await h.engine.status('p', id, true)
        expect(exported.summary).toContain(`# Batch ${id}`)
        expect(lstatSync(summary).isSymbolicLink()).toBe(false)
        expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET')
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!posix)('does not read a summary through a results folder that now leads outside', async () => {
    files(['a.txt'])
    const outside = mkdtempSync(join(tmpdir(), 'agh-engine-outside-'))
    try {
      const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
      await begin(h, {})
      await h.run(id)
      writeFileSync(join(outside, 'summary.md'), 'TOP SECRET')
      rmSync(join(root, 'agh-batch', id), { recursive: true })
      symlinkSync(outside, join(root, 'agh-batch', id))
      const status = await h.engine.status('p', id)
      expect(JSON.stringify(status)).not.toContain('TOP SECRET')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(!posix)('neither hangs on a pipe named summary.md nor returns an unbounded summary', async () => {
    files(['a.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, {})
    await h.run(id)
    const summary = join(root, 'agh-batch', id, 'summary.md')
    rmSync(summary)
    execFileSync('mkfifo', [summary])
    expect((await h.engine.status('p', id)).summary).toBeUndefined()
    rmSync(summary)
    writeFileSync(summary, 'y'.repeat(10 * 1024 * 1024))
    const status = await h.engine.status('p', id)
    expect(status.summary?.length).toBeLessThanOrEqual(4096)
    expect(status.summary?.startsWith('yyy')).toBe(true)
  })

  it('writes the result files again on request when a finished batch has none', async () => {
    files(['a.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, {})
    await h.run(id)
    rmSync(join(root, 'agh-batch'), { recursive: true })
    expect((await h.engine.status('p', id)).files).toBeUndefined()
    expect(existsSync(join(root, 'agh-batch'))).toBe(false)
    expect((await h.engine.status('p', id, true)).files).toContain(`agh-batch/${id}/summary.md`)
    expect(lines('results.jsonl')).toHaveLength(1)
  })

  it('starts one batch for two simultaneous starts with the same id', async () => {
    files(['a.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    const [a, b] = await Promise.all([begin(h, {}), begin(h, {})])
    expect([a.batchId, b.batchId]).toEqual([id, id])
    expect(h.engine.list('p')).toHaveLength(1)
    expect(h.audits).toEqual([
      {
        kind: 'batch.started',
        detail: expect.objectContaining({
          batchId: id,
          principal: 'p',
          items: 1,
          concurrency: 4,
          approval: 'none',
        }),
      },
    ])
  })

  it('ticks on its own timer once started and does nothing once stopped', async () => {
    files(['a.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }), tickMs: 5 })
    await begin(h, {})
    h.engine.start()
    await vi.waitFor(() => expect(h.sessions.prepared).toHaveLength(1))
    await h.engine.stop()
    await h.scheduler.tick()
    await h.engine.tick()
    expect((await h.engine.status('p', id)).status).toBe('running')
  })
})

describe('BatchEngine: review fixes', () => {
  it('bills an item cancelled in flight what its ledger shows', async () => {
    files(['a.png'])
    const h = batchHarness({ root, model: () => ({ reply: '{"count":"many"}', credits: 0.5 }) })
    await begin(h, { schema })
    await h.engine.tick()
    await h.scheduler.tick()
    await h.engine.tick()
    expect(h.repo.page(id, 0, 1)[0]).toMatchObject({ status: 'running', repairs: 1 })
    const status = await h.engine.cancel('p', id)
    expect(status).toMatchObject({ status: 'cancelled', spentCredits: 0.5 })
    expect(h.repo.page(id, 0, 1)[0]).toMatchObject({ status: 'cancelled', credits: 0.5 })
    expect(lines('errors.jsonl')).toEqual([expect.objectContaining({ status: 'cancelled', credits: 0.5 })])
  })

  it('counts only running time toward the item limit, not time waiting in the queue', async () => {
    files(['a.txt'])
    let now = 1_000_000
    const h = batchHarness({ root, clock: () => now, model: () => ({ reply: 'ok' }) })
    await begin(h, { itemTimeoutSec: 60 })
    await h.engine.tick()
    for (let wait = 0; wait < 5; wait++) {
      now += 61_000
      await h.engine.tick()
    }
    expect(h.repo.page(id, 0, 1)[0]?.status).toBe('running')
    expect(h.jobsRepo.get(`batch:${id}:1:0`)?.status).toBe('waiting')
    expect((await h.run(id)).counts).toMatchObject({ done: 1 })
  })

  it('starts the item time limit when its job starts running, however long it waited', async () => {
    files(['a.txt'])
    let now = 1_000_000
    const h = batchHarness({ root, clock: () => now, model: () => ({ hang: true }) })
    await begin(h, { itemTimeoutSec: 60 })
    await h.engine.tick()
    for (let wait = 0; wait < 5; wait++) {
      now += 61_000
      await h.engine.tick()
    }
    const wave = h.scheduler.tick()
    await vi.waitFor(() => expect(h.sessions.counters.running).toBe(1))
    now += 30_000
    await h.engine.tick()
    expect(h.repo.page(id, 0, 1)[0]?.status).toBe('running')
    now += 31_000
    await h.engine.tick()
    await wave
    expect(h.repo.page(id, 0, 1)[0]).toMatchObject({ status: 'failed', error: 'timeout' })
  })

  it('fails an item whose job waited in the queue past the queue limit', async () => {
    files(['a.txt', 'b.txt'])
    let now = 1_000_000
    const h = batchHarness({ root, clock: () => now, model: () => ({ reply: 'ok' }) })
    await begin(h, { itemTimeoutSec: 60, concurrency: 1 })
    await h.engine.tick()
    now += 29 * 60_000
    await h.engine.tick()
    expect(h.repo.page(id, 0, 1)[0]?.status).toBe('running')
    now += 2 * 60_000
    await h.engine.tick()
    expect(h.repo.page(id, 0, 1)[0]).toMatchObject({ status: 'failed', error: 'queue_timeout' })
    expect(h.jobsRepo.get(`batch:${id}:1:0`)?.status).toBe('cancelled')
    expect(h.sessions.released).toEqual([key(1)])
  })

  it('does not time out a job held by a stopped process until it is reclaimed, then runs it', async () => {
    files(['a.txt'])
    let now = 1_000_000
    const tables = sqliteTables()
    const first = batchHarness({ root, tables, clock: () => now, model: () => ({ reply: 'ok' }) })
    await begin(first, { itemTimeoutSec: 60 })
    await first.engine.tick()
    expect(first.jobsRepo.claimDue(now, 'gone', 10 * 60_000, 16)).toHaveLength(1)
    now += 60_000
    const second = batchHarness({ root, tables, clock: () => now, model: () => ({ reply: 'ok' }) })
    await second.engine.ready()
    for (let wait = 0; wait < 8; wait++) {
      now += 61_000
      await second.engine.tick()
      await second.scheduler.tick()
    }
    expect(second.repo.page(id, 0, 1)[0]?.status).toBe('running')
    const status = await second.run(id, { onRound: () => (now += 61_000) })
    expect(status.counts).toMatchObject({ done: 1 })
    expect(second.jobsRepo.get(`batch:${id}:1:0`)).toMatchObject({ status: 'completed', stalledCounter: 1 })
  })

  it('pauses starting items while the confinement check fails, and carries on once it answers', async () => {
    files(['a.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, {})
    h.confinement.ready = new Error('the worker did not answer')
    await h.engine.tick()
    await h.engine.tick()
    expect(h.sessions.prepared).toEqual([])
    expect((await h.engine.status('p', id)).status).toBe('running')
    h.confinement.ready = true
    expect((await h.run(id)).counts).toMatchObject({ done: 1 })
  })

  it('fails the batch, cancelling its jobs, after three confinement checks in a row fail', async () => {
    files(['a.txt', 'b.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, { concurrency: 1 })
    await h.engine.tick()
    h.confinement.ready = new Error('the worker did not answer')
    await h.engine.tick()
    await h.engine.tick()
    expect((await h.engine.status('p', id)).status).toBe('running')
    expect(h.jobsRepo.get(`batch:${id}:1:0`)?.status).toBe('waiting')
    await h.engine.tick()
    const status = await h.engine.status('p', id)
    expect(status).toMatchObject({ status: 'failed', counts: { cancelled: 2 } })
    expect(status.reason).toContain('confinement_unavailable: the worker did not answer')
    expect(h.jobsRepo.get(`batch:${id}:1:0`)?.status).toBe('cancelled')
  })

  it('sends no repair job while the confinement check fails', async () => {
    files(['a.png'])
    const h = batchHarness({
      root,
      model: (_prompt, _key, turn) => ({ reply: turn === 1 ? '{"count":"many"}' : '{"count":3}' }),
    })
    await begin(h, { schema })
    await h.engine.tick()
    await h.scheduler.tick()
    h.confinement.ready = new Error('the worker did not answer')
    await h.engine.tick()
    expect(h.jobsRepo.get(`batch:${id}:1:1`)).toBeUndefined()
    h.confinement.ready = true
    expect((await h.run(id)).counts).toMatchObject({ done: 1 })
  })

  it('runs the start-up tick on request before the scheduler starts', async () => {
    files(['a.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    await begin(h, {})
    await h.engine.ready()
    expect(h.confinement.asked).toBe(1)
    expect(h.sessions.prepared).toEqual([key(1)])
  })

  it('releases a session whose preparation answered only after the engine gave up on it', async () => {
    files(['a.txt', 'b.txt'])
    const h = batchHarness({
      root,
      model: () => ({ reply: 'ok' }),
      portTimeoutMs: 20,
      prepare: async (sessionKey) => {
        if (sessionKey === key(1)) await new Promise((resolve) => setTimeout(resolve, 80))
      },
    })
    await begin(h, {})
    expect((await h.run(id)).counts).toMatchObject({ done: 1, failed: 1 })
    expect(lines('errors.jsonl')).toEqual([
      expect.objectContaining({ error: expect.stringContaining('session_unavailable') }),
    ])
    await vi.waitFor(() => expect(h.sessions.released).toContain(key(1)))
  })

  it('fails an item whose job status cannot be read once its time limit passes, without re-sending it', async () => {
    files(['a.txt'])
    let now = 1_000_000
    let sent = 0
    const h = batchHarness({
      root,
      clock: () => now,
      model: () => ({ reply: 'ok' }),
      jobs: (port) => ({
        ...port,
        enqueue: async (spec) => {
          sent++
          return port.enqueue(spec)
        },
        status: async () => {
          throw new Error('jobs table unavailable')
        },
      }),
    })
    await begin(h, { itemTimeoutSec: 60 })
    await h.engine.tick()
    await h.engine.tick()
    expect(h.repo.page(id, 0, 1)[0]?.status).toBe('running')
    now += 61_000
    await h.engine.tick()
    expect(h.repo.page(id, 0, 1)[0]).toMatchObject({
      status: 'failed',
      error: 'outcome_unavailable: jobs table unavailable',
    })
    expect(sent).toBe(1)
  })

  it('marks an answer invalid instead of sending a repair once the budget is spent', async () => {
    files(['a.png', 'b.png'])
    const h = batchHarness({
      root,
      model: (prompt) => ({
        reply: /Item 1:/u.test(prompt) ? '{"count":1}' : '{"count":"many"}',
        credits: 1,
      }),
    })
    await begin(h, { schema, concurrency: 2, budgetCredits: 1 })
    const status = await h.run(id)
    expect(status).toMatchObject({ status: 'completed', counts: { done: 1, invalid: 1 }, spentCredits: 2 })
    expect(h.jobsRepo.get(`batch:${id}:2:1`)).toBeUndefined()
    expect(lines('errors.jsonl')).toEqual([
      expect.objectContaining({
        ordinal: 2,
        error: expect.stringContaining('budget_exhausted_before_repair'),
      }),
    ])
  })

  it('looks for unfinished clean-ups once at start and after a batch ends, not on every tick', async () => {
    files(['a.txt'])
    const h = batchHarness({ root, model: () => ({ reply: 'ok' }) })
    const sweep = vi.spyOn(h.repo, 'unsettledFinished')
    await begin(h, { concurrency: 1 })
    // The item's job waits in the queue: five ticks with nothing to finish.
    for (let tick = 0; tick < 5; tick++) await h.engine.tick()
    expect(sweep).toHaveBeenCalledTimes(1)
    await h.engine.cancel('p', id)
    await h.engine.tick()
    await h.engine.tick()
    expect(sweep).toHaveBeenCalledTimes(2)
  })
})

describe('batchJobsPort', () => {
  const service = (poll: () => Promise<never>) => ({
    enqueue: async () => ({ jobId: 'j' }),
    poll,
    cancel: async () => undefined,
  })

  it('reports a job the queue does not know as missing and rethrows any other failure', async () => {
    await expect(
      batchJobsPort(service(() => Promise.reject(rpcError('SESSION_NOT_FOUND', { jobId: 'j' })))).status('j'),
    ).resolves.toBeUndefined()
    await expect(
      batchJobsPort(service(() => Promise.reject(new Error('disk I/O error')))).status('j'),
    ).rejects.toThrow('disk I/O error')
  })
})
