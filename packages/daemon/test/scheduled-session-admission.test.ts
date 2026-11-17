import { expect, it, vi } from 'vitest'
import { createScheduledSessionAdmission } from '../src/supervisor/scheduled-session-admission.js'

it('requires the leased persistent mark, freezes current revision, and rejects copied or reused admission', async () => {
  const reserve = vi.fn()
  const commit = vi.fn()
  const authority = {
    scheduleEligible: () => true,
    reserveScheduledBinding: reserve,
    commitScheduledBinding: commit,
    interruptScheduledBinding: vi.fn(),
  }
  const job = {
    idempotencyKey: 'schedule:task:2',
    status: 'active',
    leaseOwner: 'owner',
    leaseUntil: 200,
    result: { dispatched: { at: 100, sessionKey: 'fresh', runId: 'run_real' } },
  }
  const admission = createScheduledSessionAdmission({
    repo: { get: () => job } as never,
    authority,
    clock: () => 100,
    targetOf: () => ({
      id: 'task',
      revision: 2,
      jobKey: job.idempotencyKey,
      title: 'Task',
      target: { kind: 'new-session', cwd: '/legacy' },
    }),
  })
  await expect(
    admission.admitLegacyRun(
      { jobKey: job.idempotencyKey, runId: 'forged', sessionKey: 'fresh' },
      new AbortController().signal,
    ),
  ).rejects.toThrow()
  const token = await admission.admitLegacyRun(
    { jobKey: job.idempotencyKey, runId: 'run_real', sessionKey: 'fresh' },
    new AbortController().signal,
  )
  expect(reserve).toHaveBeenCalledWith({
    runId: 'run_real',
    jobKey: job.idempotencyKey,
    taskId: 'task',
    revision: 2,
    sessionKey: 'fresh',
    root: '/legacy',
  })
  expect(() => admission.consume({ ...token }, '/legacy', 'fresh')).toThrow()
  admission.consume(token, '/legacy', 'fresh')
  expect(() => admission.consume(token, '/legacy', 'fresh')).toThrow()
  admission.commit(token, 'fresh')
  expect(commit).toHaveBeenCalledWith('fresh')
  job.leaseUntil = 99
  await expect(
    admission.admitLegacyRun(
      { jobKey: job.idempotencyKey, runId: 'run_real', sessionKey: 'fresh' },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/lease/)
})

it.each(['mark', 'pending', 'bound', 'committed', 'receipt'] as const)(
  'recovers a crash after %s once without creating or running another session',
  async (phase) => {
    const { openDaemonScheduleDb, openScheduleCatalog } = await import('@agnes/base/schedule')
    const { JobsRepo } = await import('@agnes/daemon-foundation/jobs/repo')
    const { Scheduler } = await import('@agnes/daemon-foundation/jobs/scheduler')
    const { ManagedChatAuthority } = await import('@agnes/daemon-foundation/storage/managed-chat-authority')
    const { MemoryWorkspaceBindings } = await import('@agnes/daemon-foundation/storage/workspaces')
    const { createExtensionActivationBarrier } = await import(
      '../../host-extensions/src/ext-host/activation-barrier.js'
    )
    const { sqliteTables } = await import('../../daemon-foundation/test/sqlite-tables.js')
    const tables = sqliteTables()
    let now = 100
    const repo = new JobsRepo(tables.table('jobs'), () => now)
    const catalog = openScheduleCatalog(
      openDaemonScheduleDb(tables.table('schedules')),
      repo.scheduleJobs(),
      () => now,
    )
    const task = catalog.create({
      title: 'Legacy',
      prompt: 'go',
      selector: { after_seconds: 1 },
      target: { kind: 'new-session', cwd: '/legacy' },
    })
    const key = repo.claimDue(1100, 'first', 100, 1)[0]!.idempotencyKey
    const identity = { jobKey: key, runId: 'run_0123456789abcdef0123456789abcdef', sessionKey: 'reserved' }
    repo.markDispatched(key, 'first', { at: 1100, runId: identity.runId, sessionKey: identity.sessionKey })
    const bindings = new MemoryWorkspaceBindings()
    const makeAuthority = () =>
      new ManagedChatAuthority(tables.table('managed_chat_authority'), bindings, '/legacy')
    let authority = makeAuthority()
    await authority.initialize({ bindings: [], schedules: [{ scheduleId: task.id, targetRoot: '/legacy' }] })
    if (phase !== 'mark') {
      const admissions = createScheduledSessionAdmission({
        repo,
        authority,
        clock: () => 1100,
        targetOf: catalog.targetOf,
      })
      const token = await admissions.admitLegacyRun(identity, new AbortController().signal)
      if (phase !== 'pending') {
        admissions.consume(token, '/legacy', 'reserved')
        bindings.putIfAbsent({
          sessionKey: 'reserved',
          workspaceId: 'w',
          revision: 1,
          canonicalRoot: '/legacy',
        })
        if (phase === 'committed' || phase === 'receipt') admissions.commit(token, 'reserved')
      }
    }
    if (phase === 'receipt')
      catalog.recordFailure(key, {
        at: 1100,
        reason: 'interrupted',
        runId: identity.runId,
        sessionKey: 'reserved',
      })
    now = 1201
    authority = makeAuthority()
    await authority.initialize({ bindings: [], schedules: [] })
    const opened = vi.fn()
    const prepare = vi.fn()
    const scheduler = new Scheduler({
      repo,
      clock: () => now,
      owner: 'recovered',
      limits: { tickMs: 100, lockMs: 100, maxStalled: 0 },
      registry: { open: opened, get: () => undefined, keys: () => [] },
      notices: { emit: () => undefined } as never,
      workspaces: {
        restoreBinding: async () => {
          throw new Error('must not open')
        },
      },
      ownership: { resolve: () => undefined },
      activationBarrier: createExtensionActivationBarrier(),
      prepare,
      retryable: () => true,
      onFailed: (_job, info) => {
        authority.interruptScheduledBinding(info.runId!)
        catalog.recordFailure(key, { ...info, reason: 'interrupted' })
      },
    })
    await scheduler.tick()
    await scheduler.tick()
    expect(prepare).not.toHaveBeenCalled()
    expect(opened).not.toHaveBeenCalled()
    expect(catalog.history({ id: task.id }).runs).toHaveLength(1)
    expect(catalog.history({ id: task.id }).runs[0]).toMatchObject({
      id: identity.runId,
      sessionKey: 'reserved',
      reason: 'interrupted',
    })
    const grant = await authority.authorizeExisting('reserved')
    expect(!!grant).toBe(phase === 'committed' || phase === 'receipt')
    await tables.close()
  },
)

it('revokes a legacy task through the production storage adapter when archiving', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createSqliteStorage } = await import('@agnes/host')
  const { adaptHostTables } = await import('../src/supervisor/storage-adapters.js')
  const { openDaemonScheduleDb, openScheduleCatalog } = await import('@agnes/base/schedule')
  const { JobsRepo } = await import('@agnes/daemon-foundation/jobs/repo')
  const { ManagedChatAuthority } = await import('@agnes/daemon-foundation/storage/managed-chat-authority')
  const { MemoryWorkspaceBindings } = await import('@agnes/daemon-foundation/storage/workspaces')
  const dir = mkdtempSync(join(tmpdir(), 'agnes-schedule-transaction-'))
  const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir: join(dir, 'tables') })
  try {
    const tables = adaptHostTables(storage.tables('@agnes/daemon'))
    const repo = new JobsRepo(tables.table('jobs'), () => 100)
    const authority = new ManagedChatAuthority(
      tables.table('managed_chat_authority'),
      new MemoryWorkspaceBindings(),
      '/legacy',
    )
    await authority.initialize({ bindings: [], schedules: [] })
    const catalog = openScheduleCatalog(
      openDaemonScheduleDb(tables.table('schedules')),
      repo.scheduleJobs(),
      () => 100,
      { allow: () => true, revoke: (id) => authority.revokeSchedule(id, true) },
    )
    const task = catalog.create({
      title: 'Task',
      prompt: 'go',
      selector: { every_seconds: 3600 },
      target: { kind: 'new-session', cwd: '/legacy' },
    })
    expect(catalog.archive(task.id)).toEqual({ deleted: true })
  } finally {
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
