import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWorkspaceDirectory } from '@agnes/host'
import type { BatchList, BatchStatus } from '@agnes/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BatchEngine } from '../src/batch/engine.js'
import { BatchRepo } from '../src/batch/repo.js'
import { createItemSessions } from '../src/batch/requests.js'
import { itemSessionKey } from '../src/batch/spec.js'
import { JobsRepo } from '../src/jobs/repo.js'
import { Scheduler } from '../src/jobs/scheduler.js'
import { JobsService } from '../src/jobs/service.js'
import { SessionWorkspaceIndex } from '../src/storage/lister.js'
import { SessionPrincipalOwnershipIndex } from '../src/storage/session-ownership.js'
import type { Tables } from '../src/storage/table.js'
import { WorkspaceBindingIndex, WorkspaceCatalog, WorkspaceIndex } from '../src/storage/workspaces.js'
import { batchClient, batchWorkspace, setControl, startBatchDaemon, traceOf } from './batch-daemon-harness.js'
import { sqliteTables } from './sqlite-tables.js'

const ENV = ['AGNES_BATCH_TRACE', 'AGNES_BATCH_CONTROL', 'AGNES_BATCH_NO_HOOK'] as const
let dir: string
let trace: string
let controlFile: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agnes-batch-e2e-'))
  trace = join(dir, 'trace.log')
  controlFile = join(dir, 'control.json')
  process.env.AGNES_BATCH_TRACE = trace
  process.env.AGNES_BATCH_CONTROL = controlFile
})
afterEach(() => {
  for (const key of ENV) delete process.env[key]
  rmSync(dir, { recursive: true, force: true })
})

const SCHEMA = {
  type: 'object',
  properties: { item: { type: 'integer' }, read: { type: 'boolean' } },
  required: ['item', 'read'],
}

/** What another process (or the daemon before it stopped) left in the daemon's tables. */
function tablesOf(tables: Pick<Tables, 'table'>) {
  const workspaces = new WorkspaceCatalog(
    new WorkspaceIndex(tables.table('workspace_registry')),
    new SessionWorkspaceIndex(tables.table('session_workspaces')),
    resolveWorkspaceDirectory,
    () => Date.now(),
    new WorkspaceBindingIndex(tables.table('workspace_bindings')),
  )
  const ownership = new SessionPrincipalOwnershipIndex(tables.table('session_principal_ownership'))
  const jobsRepo = new JobsRepo(tables.table('jobs'), () => Date.now())
  return {
    workspaces,
    ownership,
    batches: new BatchRepo(tables.table('batches'), () => Date.now()),
    jobs: new JobsService({ repo: jobsRepo, profileHash: '', clock: () => Date.now() }),
    job: (id: string) =>
      tables
        .table('jobs')
        .get<{ status: string; attempts: number; error: string | null }>(
          'SELECT status, attempts, error FROM jobs WHERE idempotency_key = ?',
          [id],
        ),
    items: createItemSessions({
      ownership,
      workspaces,
      registry: {
        get: () => undefined,
        open: async () => {
          throw new Error('not here')
        },
        close: async () => undefined,
      },
    }),
  }
}
const itemJob = (ordinal: number, path: string) => ({
  payload: {
    prompt: `Item ${ordinal}: "${path}" (text).\nStep 1: call the read tool with {"path":"${path}"}.\nStep 2: answer.`,
  },
  schedule: { kind: 'once' as const },
  maxAttempts: 1,
})

async function daemon(
  names: readonly string[],
  seed?: (root: string, tables: Pick<Tables, 'table'>) => Promise<void>,
) {
  const root = batchWorkspace(dir, names)
  const tables = sqliteTables(join(dir, 'daemon.sqlite'))
  await seed?.(root, tables)
  const supervisor = await startBatchDaemon({ dir: root, tables })
  const client = await batchClient(supervisor.socketPath)
  return {
    root,
    tables,
    supervisor,
    client,
    status: async (batchId: string) =>
      (await client.call('_agnes/v1/batch.status', { batchId })).result as BatchStatus,
    finished: async (batchId: string, timeout = 30_000) => {
      let last: BatchStatus | undefined
      await vi.waitFor(
        async () => {
          last = (await client.call('_agnes/v1/batch.status', { batchId })).result as BatchStatus
          expect(last.status).not.toBe('running')
          // The outcome is recorded first and the result files are written right after it.
          expect(last.summary).toBeDefined()
        },
        { timeout, interval: 100 },
      )
      return last as BatchStatus
    },
    async close() {
      client.close()
      await supervisor.close()
      await tables.close()
    },
  }
}

describe('batch processing through the real daemon', () => {
  it('runs a batch from the CLI socket in item sessions owned by the batch, bound to the workspace root', async () => {
    const d = await daemon(['a.txt', 'b.txt', 'c.txt'])
    try {
      const started = await d.client.call('_agnes/v1/batch.start', {
        cwd: d.root,
        spec: { dir: 'items', prompt: 'Look at {{name}}', schema: SCHEMA, concurrency: 2 },
      })
      expect(started.error).toBeUndefined()
      const { batchId } = started.result as BatchStatus
      const done = await d.finished(batchId)
      expect(done).toMatchObject({ status: 'completed', counts: { total: 3, done: 3 } })
      const rows = readFileSync(join(d.root, 'agh-batch', batchId, 'results.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { ordinal: number; output: unknown })
      expect(rows.map((row) => row.output)).toEqual([
        { item: 1, read: true },
        { item: 2, read: true },
        { item: 3, read: true },
      ])
      expect(done.summary).toContain('Done')
      const listed = (await d.client.call('_agnes/v1/batch.list', {})).result as BatchList
      expect(listed.items.map((item) => item.batchId)).toEqual([batchId])

      // Each item ran in its own session, owned by the batch and bound to the workspace root, which
      // is also where the model's relative read path was resolved (read: true above).
      const ownership = new SessionPrincipalOwnershipIndex(d.tables.table('session_principal_ownership'))
      const bindings = new WorkspaceBindingIndex(d.tables.table('workspace_bindings'))
      const items = [1, 2, 3].map((n) => itemSessionKey('local-dev', batchId, n))
      for (const key of items) {
        expect(ownership.resolve(key)).toEqual({ active: true, principalId: `batch:${batchId}` })
        expect(bindings.get(key)?.canonicalRoot).toBe(d.root)
      }
      expect(traceOf(trace).filter((line) => line.startsWith('start '))).toHaveLength(3)

      // No path lets the owner's own connection open, read, message or list an item session.
      const key = items[0] as string
      const denied = [
        ['session/load', { sessionId: key, cwd: d.root, mcpServers: [] }],
        ['session/prompt', { sessionId: key, prompt: [{ type: 'text', text: 'hi' }] }],
        ['_agnes/v1/session.attach', { sessionId: key }],
        [
          '_agnes/v1/session.followUp',
          { sessionId: key, content: [{ type: 'text', text: 'x' }], commandId: 'c1' },
        ],
        [
          '_agnes/v1/session.steer',
          { sessionId: key, content: [{ type: 'text', text: 'x' }], commandId: 'c2' },
        ],
        ['_agnes/v1/session.fork', { sessionId: key, at: 1 }],
        ['_agnes/v1/session.projectUI', { sessionId: key }],
        ['_agnes/v1/diagnostics.events', { sessionId: key, afterSeq: 0, limit: 10, maxBytes: 65536 }],
        [
          '_agnes/v1/jobs.enqueue',
          { idempotencyKey: 'steal', sessionKey: key, payload: { prompt: 'x' }, schedule: { kind: 'once' } },
        ],
        [
          '_agnes/v1/submit',
          {
            clientId: 'batch-e2e',
            commandId: 'c3',
            kind: 'followUp',
            payload: { sessionId: key, content: [{ type: 'text', text: 'x' }] },
          },
        ],
        // Jobs of an item session are the batch's: the owner cannot poll or cancel them directly.
        ['_agnes/v1/jobs.poll', { jobId: `batch:${batchId}:1:0` }],
        ['_agnes/v1/jobs.cancel', { jobId: `batch:${batchId}:1:0` }],
      ] as const
      for (const [method, params] of denied) {
        const answer = await d.client.call(method, params)
        expect(answer.error, method).toBeDefined()
        // CAPABILITY_DENIED, or SESSION_NOT_FOUND where a foreign job must not be told apart from a missing one.
        expect([-32006, -32003], method).toContain(answer.error?.code)
      }
      // The local owner may still set a display title on any session the daemon lists (as on main);
      // that touches neither the session nor its owner, and it stays out of the owner's list.
      expect(
        (await d.client.call('_agnes/v1/session.rename', { sessionId: key, title: 'mine' })).error,
      ).toBeUndefined()
      const sessions = (await d.client.call('_agnes/v1/session.list', {})).result as {
        items: Array<{ sessionId: string }>
      }
      expect(sessions.items.map((item) => item.sessionId).filter((id) => items.includes(id))).toEqual([])
      // workspace.list counts every session bound to the folder, item sessions included (accepted).
      const workspaces = (await d.client.call('_agnes/v1/workspace.list', {})).result as {
        items: Array<{ path: string; sessionCount: number }>
      }
      expect(workspaces.items.find((item) => item.path === d.root)?.sessionCount).toBe(3)
      expect(traceOf(trace).filter((line) => line.startsWith('user '))).toEqual([])

      // Refusals carry a reason the CLI shows.
      expect(
        await d.client.call('_agnes/v1/batch.start', { cwd: d.root, spec: { dir: 'missing', prompt: 'x' } }),
      ).toMatchObject({
        error: {
          code: -32011,
          data: { code: 'BATCH_SPEC_INVALID', reason: 'dir is not an existing folder' },
        },
      })
      expect(
        await d.client.call('_agnes/v1/batch.start', { cwd: d.root, spec: { dir: '../..', prompt: 'x' } }),
      ).toMatchObject({ error: { data: { code: 'BATCH_SPEC_INVALID' } } })
      expect(await d.client.call('_agnes/v1/batch.status', { batchId: 'bffffffffffff' })).toMatchObject({
        error: { code: -32011, data: { code: 'BATCH_NOT_FOUND' } },
      })
      // A folder that is not a registered workspace is not a batch root.
      expect(
        (
          await d.client.call('_agnes/v1/batch.start', {
            cwd: join(d.root, 'items'),
            spec: { dir: '.', prompt: 'x' },
          })
        ).error,
      ).toBeDefined()
    } finally {
      await d.close()
    }
  }, 60_000)

  it('starts and follows a batch from a session tool through the worker request frame', async () => {
    const d = await daemon(['a.txt', 'b.txt'])
    try {
      const created = await d.client.call('session/new', { cwd: d.root, mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      const ask = async (text: string) => {
        const answer = await d.client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
        expect(answer.error).toBeUndefined()
      }
      await ask(
        `batch batch_start ${JSON.stringify({ dir: 'items', prompt: 'Look at {{name}}', schema: SCHEMA })}`,
      )
      const listed = (await d.client.call('_agnes/v1/batch.list', {})).result as BatchList
      expect(listed.items).toHaveLength(1)
      const batchId = listed.items[0]?.batchId as string
      // Started by the session's owner, on behalf of the session the worker channel named.
      const row = d.tables
        .table('batches')
        .get<{ principal_id: string; origin: string; root: string }>(
          'SELECT principal_id, origin, root FROM batches WHERE id = ?',
          [batchId],
        )
      expect(row).toEqual({ principal_id: 'local', origin: sessionId, root: d.root })
      expect(JSON.stringify(d.client.seen)).toContain(`tool said: Batch ${batchId}: running`)
      await d.finished(batchId)
      await ask(`batch batch_status ${JSON.stringify({ batch_id: batchId })}`)
      expect(JSON.stringify(d.client.seen)).toContain(`tool said: Batch ${batchId}: completed`)
      // A refusal comes back to the model as the daemon's own sentence.
      await ask(`batch batch_status ${JSON.stringify({ batch_id: 'bffffffffffff' })}`)
      expect(JSON.stringify(d.client.seen)).toContain(
        'Batch request failed: No batch with this id belongs to you.',
      )
    } finally {
      await d.close()
    }
  }, 60_000)

  it('fails a batch whose item confinement is not live in the worker, and its items never run', async () => {
    process.env.AGNES_BATCH_NO_HOOK = '1'
    const d = await daemon(['a.txt', 'b.txt'])
    try {
      const started = await d.client.call('_agnes/v1/batch.start', {
        cwd: d.root,
        spec: { dir: 'items', prompt: 'Look at {{name}}' },
      })
      const { batchId } = started.result as BatchStatus
      const done = await d.finished(batchId)
      expect(done.status).toBe('failed')
      expect(done.reason).toMatch(/^confinement_unavailable/)
      expect(done.counts).toMatchObject({ total: 2, cancelled: 2, done: 0, running: 0 })
      // Nothing was prepared or queued for any item, and the model saw no item prompt.
      expect(
        d.tables.table('jobs').all("SELECT idempotency_key FROM jobs WHERE idempotency_key LIKE 'batch:%'"),
      ).toEqual([])
      const ownership = new SessionPrincipalOwnershipIndex(d.tables.table('session_principal_ownership'))
      expect(ownership.resolve(itemSessionKey('local-dev', batchId, 1))).toBeUndefined()
      expect(traceOf(trace).filter((line) => line.startsWith('start '))).toEqual([])

      // A job claimed between engine ticks is refused by the worker itself: an item session never
      // opens in a Host without the hook, whoever queued it.
      const t = tablesOf(d.tables)
      const key = itemSessionKey('local-dev', 'b0000000000aa', 9)
      await t.items.prepare({ sessionKey: key, principalId: 'batch:b0000000000aa', root: d.root })
      await t.jobs.enqueue(
        { idempotencyKey: 'stray-item-job', sessionKey: key, ...itemJob(9, 'items/a.txt') },
        {
          local: true,
        },
      )
      await vi.waitFor(() => expect(t.job('stray-item-job')?.status).toBe('failed'), {
        timeout: 30_000,
        interval: 100,
      })
      expect(traceOf(trace)).not.toContain('start 9')
      // An ordinary session in the same Host still runs.
      const created = await d.client.call('session/new', { cwd: d.root, mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      expect(
        (await d.client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] })).error,
      ).toBeUndefined()
    } finally {
      await d.close()
    }
  }, 60_000)

  it('cancelling a batch aborts its running turns, and the daemon serves the next batch', async () => {
    setControl(controlFile, { block: true })
    const d = await daemon(['a.txt', 'b.txt', 'c.txt'])
    try {
      const started = await d.client.call('_agnes/v1/batch.start', {
        cwd: d.root,
        spec: { dir: 'items', prompt: 'Look at {{name}}', concurrency: 2 },
      })
      const { batchId } = started.result as BatchStatus
      // Both admitted items read their file and are now mid-turn, waiting on the model.
      await vi.waitFor(
        () =>
          expect(
            traceOf(trace)
              .filter((line) => line.startsWith('block '))
              .sort(),
          ).toEqual(['block 1', 'block 2']),
        { timeout: 30_000, interval: 50 },
      )
      const cancelled = await d.client.call('_agnes/v1/batch.cancel', { batchId })
      expect(cancelled.result).toMatchObject({ status: 'cancelled', counts: { cancelled: 3 } })
      // The turns are aborted (not left to run until they time out), while their sessions close.
      await vi.waitFor(
        () =>
          expect(
            traceOf(trace)
              .filter((line) => line.startsWith('abort '))
              .sort(),
          ).toEqual(['abort 1', 'abort 2']),
        { timeout: 5_000, interval: 50 },
      )
      expect(traceOf(trace)).not.toContain('start 3')
      for (const n of [1, 2])
        expect(
          d.tables
            .table('jobs')
            .get<{ status: string }>('SELECT status FROM jobs WHERE idempotency_key = ?', [
              `batch:${batchId}:${n}:0`,
            ])?.status,
        ).toBe('cancelled')
      // Closing sessions whose aborted turns were still finishing left the worker serving.
      setControl(controlFile, { block: false })
      const next = await d.client.call('_agnes/v1/batch.start', {
        cwd: d.root,
        spec: { dir: 'items', prompt: 'Look at {{name}}', outDir: 'second' },
      })
      expect(await d.finished((next.result as BatchStatus).batchId)).toMatchObject({
        status: 'completed',
        counts: { done: 3 },
      })
    } finally {
      await d.close()
    }
  }, 60_000)

  it('cancelling a job aborts its running turn (the jobs service is wired to the scheduler)', async () => {
    const d = await daemon(['a.txt'])
    try {
      const created = await d.client.call('session/new', { cwd: d.root, mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      const enqueued = await d.client.call('_agnes/v1/jobs.enqueue', {
        idempotencyKey: 'held-job',
        sessionKey: sessionId,
        payload: { prompt: 'hold' },
        schedule: { kind: 'once' },
      })
      expect(enqueued.error).toBeUndefined()
      await vi.waitFor(() => expect(traceOf(trace)).toContain('hold'), { timeout: 30_000, interval: 50 })
      expect((await d.client.call('_agnes/v1/jobs.cancel', { jobId: 'held-job' })).error).toBeUndefined()
      // Nothing else closes this session: only the scheduler's abort can end the held turn.
      await vi.waitFor(() => expect(traceOf(trace)).toContain('abort user'), { timeout: 5_000, interval: 50 })
    } finally {
      await d.close()
    }
  }, 60_000)

  it('finishes what a stopped daemon left before the scheduler claims anything', async () => {
    // Batch A runs (one pending item), so the first engine tick asks the worker about the hook.
    // Batch B was cancelled by a daemon that stopped before its clean-up: its item is still marked
    // running, with its job waiting and due. That job must be cancelled, never claimed.
    const order: string[] = []
    const ready = BatchEngine.prototype.ready
    const readySpy = vi.spyOn(BatchEngine.prototype, 'ready').mockImplementation(async function (
      this: BatchEngine,
    ) {
      order.push('engine.ready')
      await ready.call(this)
      order.push('engine.ready done')
    })
    const start = Scheduler.prototype.start
    const startSpy = vi.spyOn(Scheduler.prototype, 'start').mockImplementation(function (this: Scheduler) {
      order.push('scheduler.start')
      start.call(this)
    })
    const B = 'b00000000000b'
    const keyB = itemSessionKey('local-dev', B, 1)
    try {
      const d = await daemon(['x.txt'], async (root, tables) => {
        const t = tablesOf(tables)
        await t.workspaces.add(root)
        const batch = (id: string) => ({
          id,
          principalId: 'local',
          root,
          spec: { dir: 'items', prompt: 'Look at {{name}}' },
          dirRel: 'items',
          outRel: `agh-batch/${id}`,
          concurrency: 1,
          itemTimeoutMs: 600_000,
          createdAt: Date.now(),
        })
        const items = [{ path: 'items/x.txt', kind: 'text' as const, bytes: 16 }]
        t.batches.create(batch('b00000000000a'), items)
        t.batches.create(batch(B), items)
        await t.items.prepare({ sessionKey: keyB, principalId: `batch:${B}`, root })
        t.batches.markRunning(B, 1, {
          jobId: `batch:${B}:1:0`,
          sessionKey: keyB,
          repairs: 0,
          startedAt: Date.now(),
        })
        await t.jobs.enqueue(
          { idempotencyKey: `batch:${B}:1:0`, sessionKey: keyB, ...itemJob(7, 'items/x.txt') },
          {
            local: true,
          },
        )
        t.batches.setStatus(B, 'cancelled', 'cancelled by request')
      })
      try {
        expect(order.slice(0, 3)).toEqual(['engine.ready', 'engine.ready done', 'scheduler.start'])
        const t = tablesOf(d.tables)
        expect(t.job(`batch:${B}:1:0`)).toMatchObject({ status: 'cancelled', attempts: 0 })
        expect(t.batches.counts(B)).toMatchObject({ running: 0, cancelled: 1 })
        expect(await d.finished('b00000000000a')).toMatchObject({ status: 'completed', counts: { done: 1 } })
        expect(traceOf(trace)).not.toContain('start 7')
      } finally {
        await d.close()
      }
    } finally {
      readySpy.mockRestore()
      startSpy.mockRestore()
    }
  }, 60_000)

  it('sends a nearly spent budget to the item turn as 0', async () => {
    const d = await daemon(['a.txt'])
    try {
      const started = await d.client.call('_agnes/v1/batch.start', {
        cwd: d.root,
        spec: { dir: 'items', prompt: 'Look at {{name}}', budgetCredits: 0.000001 },
      })
      const { batchId } = started.result as BatchStatus
      await d.finished(batchId)
      // What the turn then does is pinned in batch-turn-budget.test.ts: with a price it ends at once
      // (turn_budget); this test model is free, so the turn runs.
      expect(
        d.tables
          .table('jobs')
          .get<{ budget: number }>('SELECT budget FROM jobs WHERE idempotency_key = ?', [
            `batch:${batchId}:1:0`,
          ]),
      ).toEqual({ budget: 0 })
    } finally {
      await d.close()
    }
  }, 60_000)
})
