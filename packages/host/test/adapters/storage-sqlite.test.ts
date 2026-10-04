import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canonicalJson, defaultIds, openTracked, prepareIntegrity, SessionLogImpl } from '@agnes/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteStorage, DDL, ownerFile, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'
import { createComparisonStore } from '../../src/runtime/comparison-store.js'
import { ev } from './events.js'

describe('storage-sqlite', () => {
  // `now` is reset per test on purpose: as a module-scope `let` mutated by the lease test it made
  // every test after it run at t=3000, so the suite passed or failed depending on its order.
  let dir: string
  let s: SqliteStorage
  let now: number
  beforeEach(() => {
    now = 1_000
    dir = mkdtempSync(join(tmpdir(), 'agnes-sqlite-'))
    s = createSqliteStorage({
      file: join(dir, 'sessions.db'),
      clock: () => now,
      tablesDir: join(dir, 'tables'),
    })
  })
  afterEach(async () => {
    await s.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the core tables and WAL', () => {
    expect(s.coreTableNames()).toEqual([
      'budget_reservations',
      'budget_scopes',
      'child_control_meta',
      'child_ordinals',
      'child_tasks',
      'child_workspaces',
      'child_writer_gens',
      'cost_origins',
      'events',
      'registers',
      'session_budget_origins',
      'session_comparison_roots',
      'session_owner_evidence',
      'session_retirement_idle',
      'session_retirement_members',
      'session_retirements',
      'session_tree_purges',
      'session_tree_retained_budgets',
      'sessions',
      'writer_claims',
    ])
    expect(s.journalMode()).toBe('wal')
    expect(DDL.length).toBeGreaterThanOrEqual(4)
  })
  it('persists exact acquisition and close evidence without inferring closure from released leases', async () => {
    expect(s.readSessionOwnerEvidence('never-opened')).toBeUndefined()
    const first = await s.open('owner-proof', { writerRunId: 'same-id', ttlMs: 1000 })
    if (first.ownerEpoch === undefined) throw new Error('Missing acquisition epoch')
    const owner = { sessionKey: 'owner-proof', writerRunId: 'same-id', ownerEpoch: first.ownerEpoch }
    await expect(s.recordSessionOwnerClosed(owner, 0)).rejects.toMatchObject({ code: 'E_RELATION' })
    await s.release('owner-proof', 'same-id')
    expect(s.readSessionOwnerEvidence('owner-proof')).toEqual({ owner })
    await expect(s.recordSessionOwnerClosed(owner, 1)).rejects.toMatchObject({ code: 'E_RELATION' })
    await s.recordSessionOwnerClosed(owner, 0)
    await expect(
      s.renew('owner-proof', 'same-id', { ttlMs: 1000, expectedLastSeq: 0 }),
    ).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    await s.recordSessionOwnerClosed(owner, 0)
    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), clock: () => now })
    expect(s.readSessionOwnerEvidence('owner-proof')).toEqual({ owner, closed: { finalSeq: 0 } })
    const next = await s.open('owner-proof', { writerRunId: 'same-id', ttlMs: 1000 })
    expect(next.ownerEpoch).toBe(first.ownerEpoch + 1)
    expect(s.readSessionOwnerEvidence('owner-proof')?.closed).toBeUndefined()
    await s.release('owner-proof', 'same-id')
    await expect(s.recordSessionOwnerClosed(owner, 0)).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    const sealed = await s.sealSessionTree({
      rootSessionKey: 'owner-proof',
      retirementId: 'retire',
      epoch: 1,
    })
    expect(sealed.ownerEvidence).toEqual([
      {
        sessionKey: 'owner-proof',
        evidence: {
          owner: { ...owner, ownerEpoch: next.ownerEpoch },
        },
      },
    ])
  })

  it('acquires evidence atomically and binds close heads to inherited ledger boundaries', async () => {
    const db = new DatabaseSync(join(dir, 'sessions.db'))
    try {
      db.exec(`CREATE TRIGGER fail_owner_acquire BEFORE INSERT ON session_owner_evidence
        WHEN NEW.session_key='failed-open' BEGIN SELECT RAISE(ABORT,'owner unavailable'); END`)
      await expect(s.open('failed-open', { writerRunId: 'w', ttlMs: 1000 })).rejects.toThrow(
        'owner unavailable',
      )
      expect(db.prepare('SELECT 1 FROM writer_claims WHERE session_key=?').get('failed-open')).toBeUndefined()
      expect(db.prepare('SELECT 1 FROM sessions WHERE session_key=?').get('failed-open')).toBeUndefined()
      expect(s.readSessionOwnerEvidence('failed-open')).toBeUndefined()
      db.exec('DROP TRIGGER fail_owner_acquire')
      await s.open('history-parent', { writerRunId: 'p', ttlMs: 1000 })
      await s.commit('history-parent', { expectedWriterRunId: 'p', events: [ev('session/start', {})] })
      await s.createChild('history-parent', 1, 'history-child')
      expect(s.readSessionOwnerEvidence('history-child')).toBeUndefined()
      const opened = await s.open('history-child', { writerRunId: 'c', ttlMs: 1000 })
      if (opened.ownerEpoch === undefined) throw new Error('Missing owner epoch')
      const owner = { sessionKey: 'history-child', writerRunId: 'c', ownerEpoch: opened.ownerEpoch }
      await s.release('history-child', 'c')
      await expect(s.recordSessionOwnerClosed(owner, 0)).rejects.toMatchObject({ code: 'E_RELATION' })
      db.exec(`CREATE TRIGGER fail_owner_close BEFORE UPDATE ON session_owner_evidence
        BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END`)
      await expect(s.recordSessionOwnerClosed(owner, 1)).rejects.toThrow('receipt unavailable')
      expect(s.readSessionOwnerEvidence('history-child')).toEqual({ owner })
      db.exec('DROP TRIGGER fail_owner_close')
      await s.recordSessionOwnerClosed(owner, 1)
      expect(s.readSessionOwnerEvidence('history-child')?.closed).toEqual({ finalSeq: 1 })
    } finally {
      db.close()
    }
  })

  it.each(['default', 'custom'] as const)(
    'blocks delegated admission after comparison CAS and remembers %s authority across reopen',
    async (location) => {
      const indexFile =
        location === 'default' ? join(dir, 'comparisons', 'index.sqlite') : join(dir, 'private-index.sqlite')
      if (location === 'custom') {
        await s.close()
        s = createSqliteStorage({
          file: join(dir, 'sessions.db'),
          clock: () => now,
          comparisonAdmissionFile: indexFile,
        })
      }
      const index = createComparisonStore(indexFile, {
        sessionKeys: () => ({ left: 'root', right: 'other' }),
      })
      const record = {
        id: 'pair',
        revision: 0,
        createPayload: 'fixture',
        creation: 'preparing' as const,
        lanes: {},
        rounds: [],
        cancellation: {},
        cleanup: { exited: [], released: false },
      }
      await index.scoped('owner').compareAndSwap('pair', null, record)
      await s.open('root', { writerRunId: 'r', ttlMs: 1000 })
      await s.ensureRootScope('opaque', null)
      const create = {
        childKey: 'child',
        parentKey: 'root',
        boundarySeq: 0,
        creationId: 'create',
        attemptId: 'a',
        kind: 'spawn' as const,
        seedMode: 'fresh' as const,
        rootTaskId: 'opaque',
        runtimeOwnerSessionKey: 'root',
        generationDepth: 1,
        generationLimit: 3,
        maxFanOut: 3,
        inputHash: 'hash',
        inputText: 'input',
        cwd: '/fixture',
        actorId: 'owner',
        isolation: 'shared' as const,
        workspaceId: 'workspace',
        treeCapMicro: null,
        childCapMicro: null,
        writerRunId: 'c',
      }
      await s.createDelegatedChild(create)
      await s.open('child', { writerRunId: 'c', ttlMs: 1000 })
      await s.createChild('root', 0, 'independent-history')
      await index
        .scoped('owner')
        .compareAndSwap('pair', 0, { ...record, revision: 1, retirement: { state: 'releasing', epoch: 1 } })
      // Core tree seal has deliberately NOT happened: this is the cross-store publication gap.
      expect((await s.inspectSessionTree('root')).sealed).toBeUndefined()
      expect(() => s.assertSessionAdmittedTree('child')).toThrow()
      await expect(
        s.commit('child', { expectedWriterRunId: 'c', events: [ev('turn/start', {})] }),
      ).rejects.toMatchObject({ code: 'E_CLOSED' })
      await expect(
        s.createDelegatedChild({ ...create, childKey: 'late', creationId: 'late', workspaceId: 'late' }),
      ).rejects.toMatchObject({ code: 'E_CLOSED' })
      await s.release('child', 'c')
      await expect(s.open('child', { writerRunId: 'raw-reopen', ttlMs: 1000 })).rejects.toMatchObject({
        code: 'E_CLOSED',
      })
      const independent = await s.open('independent-history', { writerRunId: 'outside', ttlMs: 1000 })
      expect(independent.lastSeq).toBe(0)
      await s.release('independent-history', 'outside')
      index.close()
      await s.close()
      rmSync(indexFile)
      s = createSqliteStorage({
        file: join(dir, 'sessions.db'),
        clock: () => now,
        comparisonAdmissionFile: indexFile,
      })
      await expect(s.open('child', { writerRunId: 'after-loss', ttlMs: 1000 })).rejects.toMatchObject({
        code: 'E_CLOSED',
      })
      await expect(
        s.open('unrelated-after-authority-loss', { writerRunId: 'new', ttlMs: 1000 }),
      ).rejects.toMatchObject({ code: 'E_CLOSED' })
    },
  )

  it('persists a retirement barrier without cancelling owners or suppressing their closing records', async () => {
    await s.open('root', { writerRunId: 'owner', ttlMs: 1000 })
    await s.commit('root', { expectedWriterRunId: 'owner', events: [ev('turn/start', {})] })
    await s.ensureRootScope('opaque-task', null)
    const request = {
      rootTaskId: 'opaque-task',
      scopeIds: ['root:opaque-task'],
      qMicro: null,
      effectId: 'first',
      requestHash: 'first',
      writerGeneration: 1,
    }
    expect((await s.reserve({ ...request, originSessionKey: 'root' })).ok).toBe(true)
    await s.createChild('root', 1, 'independent-history')
    const receipt = await s.sealSessionTree({
      rootSessionKey: 'root',
      retirementId: 'comparison:retire',
      epoch: 7,
    })
    expect(receipt.members).toEqual([{ sessionKey: 'root', parentKey: null, kind: 'root' }])
    expect(receipt.writerClaims).toMatchObject([{ sessionKey: 'root', writerRunId: 'owner' }])
    expect(receipt.openTurns).toEqual([{ sessionKey: 'root', lane: 'main', startSeq: 1 }])
    expect(receipt.externalHistoryDependents).toEqual([
      { sessionKey: 'independent-history', parentKey: 'root', boundarySeq: 1 },
    ])
    await expect(s.open('root', { writerRunId: 'owner', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_CLOSED',
    })
    await expect(s.createChild('root', 1, 'late-history')).rejects.toMatchObject({ code: 'E_CLOSED' })
    await expect(
      s.open('independent-history', { writerRunId: 'external', ttlMs: 1000 }),
    ).resolves.toMatchObject({ parent: { key: 'root', boundarySeq: 1 } })
    await expect(
      s.commit('root', { expectedWriterRunId: 'owner', events: [ev('turn/start', {})] }),
    ).rejects.toMatchObject({ code: 'E_CLOSED' })
    await s.renew('root', 'owner')
    await s.commit('root', {
      expectedWriterRunId: 'owner',
      events: [ev('turn/end', { reason: 'completed' })],
    })
    expect((await s.inspectSessionTree('root')).openTurns).toEqual([])
    await expect(s.reserve({ ...request, effectId: 'later', requestHash: 'later' })).rejects.toMatchObject({
      code: 'E_CLOSED',
    })
    await s.release('root', 'owner')
    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), clock: () => now })
    expect(
      (await s.sealSessionTree({ rootSessionKey: 'root', retirementId: 'comparison:retire', epoch: 7 }))
        .sealed,
    ).toEqual({ retirementId: 'comparison:retire', epoch: 7 })
    await expect(
      s.sealSessionTree({ rootSessionKey: 'root', retirementId: 'different', epoch: 7 }),
    ).rejects.toMatchObject({ code: 'E_RELATION' })
    await expect(s.open('root', { writerRunId: 'new', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_CLOSED',
    })
  })

  it.each([
    'active turn',
    'external fork',
    'pending input',
    'reopened owner',
    'closed owner reopened',
    'omitted member',
  ])('atomically refuses both fences when the second tree has %s', async (hazard) => {
    for (const key of ['left', 'right']) await s.open(key, { writerRunId: key, ttlMs: 1000 })
    const expected = await Promise.all(
      ['left', 'right'].map(async (key) =>
        (await s.inspectSessionTree(key)).ownerEvidence.map((row) => {
          if (!row.evidence) throw new Error('Missing owner evidence')
          return row.evidence
        }),
      ),
    )
    if (hazard === 'reopened owner' || hazard === 'closed owner reopened') {
      await s.release('right', 'right')
      if (hazard === 'closed owner reopened') {
        const prior = expected[1]?.[0]
        if (!prior) throw new Error('Missing owner')
        await s.recordSessionOwnerClosed(prior.owner, 0)
        const closed = s.readSessionOwnerEvidence('right')
        if (!closed?.closed) throw new Error('Missing close evidence')
        expected[1] = [closed]
      }
      await s.open('right', { writerRunId: 'successor', ttlMs: 1000 })
    }
    if (hazard === 'active turn')
      await s.commit('right', { expectedWriterRunId: 'right', events: [ev('turn/start', {})] })
    if (hazard === 'external fork') await s.createChild('right', 0, 'external')
    const raw = new DatabaseSync(join(dir, 'sessions.db'))
    try {
      if (hazard === 'pending input')
        raw
          .prepare('INSERT INTO registers(session_key,register,key,seq,data) VALUES(?,?,?,?,?)')
          .run('right', 'inbox', Buffer.from('main'), 0, JSON.stringify({ items: [{}] }))
      await expect(
        s.sealIdleSessionTrees(
          ['left', 'right'].map((rootSessionKey, index) => ({
            rootSessionKey,
            retirementId: 'pair',
            epoch: 1,
            expectedOwners: hazard === 'omitted member' && index === 1 ? [] : (expected[index] ?? []),
          })),
        ),
      ).rejects.toThrow()
      expect(raw.prepare('SELECT COUNT(*) AS n FROM session_retirements').get()?.n).toBe(0)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM session_retirement_members').get()?.n).toBe(0)
      expect(() => s.assertSessionAdmittedTree('left')).not.toThrow()
    } finally {
      raw.close()
    }
  })

  it('does not publish a sealed close proof when pending state arrived after the idle seal', async () => {
    const opened = await s.open('sealed-owner', { writerRunId: 'w', ttlMs: 1000 })
    if (opened.ownerEpoch === undefined) throw new Error('Missing owner')
    await s.sealIdleSessionTrees([{ rootSessionKey: 'sealed-owner', retirementId: 'retire', epoch: 1 }])
    await expect(
      s.commit('sealed-owner', {
        expectedWriterRunId: 'w',
        events: [ev('inbox', { items: [{}] }, { register: 'inbox' })],
      }),
    ).rejects.toMatchObject({ code: 'E_CLOSED' })
    await expect(
      s.commit('sealed-owner', {
        expectedWriterRunId: 'w',
        events: [ev('x/test/work', {}, { ignorable: true })],
        opState: { lane: 'main', data: {} as never },
      }),
    ).rejects.toMatchObject({ code: 'E_CLOSED' })
    expect(await s.scan('sealed-owner', { limit: 10 })).toEqual([])
    const raw = new DatabaseSync(join(dir, 'sessions.db'))
    try {
      // Corrupt/older writers cannot turn the producer check into a false proof either.
      raw
        .prepare('INSERT INTO registers(session_key,register,key,seq,data) VALUES(?,?,?,?,?)')
        .run('sealed-owner', 'inbox', Buffer.from('main'), 0, JSON.stringify({ items: [{}] }))
      await s.release('sealed-owner', 'w')
      await expect(
        s.recordSessionOwnerClosed(
          { sessionKey: 'sealed-owner', writerRunId: 'w', ownerEpoch: opened.ownerEpoch },
          0,
        ),
      ).rejects.toThrow(/pending input/)
      expect(s.readSessionOwnerEvidence('sealed-owner')?.closed).toBeUndefined()
    } finally {
      raw.close()
    }
  })

  it('purges only a sealed drained tree and keeps exact retry and admission evidence after reopen', async () => {
    const acquisition = await s.open('root', { writerRunId: 'owner', ttlMs: 1000 })
    if (acquisition.ownerEpoch === undefined) throw new Error('Missing owner epoch')
    const owner = { sessionKey: 'root', writerRunId: 'owner', ownerEpoch: acquisition.ownerEpoch }
    await s.commit('root', {
      expectedWriterRunId: 'owner',
      events: [ev('turn/start', {}), ev('turn/end', {})],
    })
    await s.ensureRootScope('budget', null)
    const child = await s.createDelegatedChild({
      childKey: 'fresh',
      parentKey: 'root',
      boundarySeq: 0,
      creationId: 'create',
      attemptId: 'attempt',
      kind: 'spawn',
      seedMode: 'fresh',
      rootTaskId: 'budget',
      runtimeOwnerSessionKey: 'root',
      generationDepth: 1,
      generationLimit: 3,
      maxFanOut: 3,
      inputHash: 'input',
      inputText: 'input',
      cwd: '/fixture',
      actorId: 'test',
      isolation: 'shared',
      workspaceId: 'workspace',
      treeCapMicro: null,
      childCapMicro: null,
      writerRunId: 'child-owner',
    })
    expect(child.status).toBe('created')
    await expect(
      s.sealIdleSessionTrees([{ rootSessionKey: 'root', retirementId: 'idle', epoch: 1 }]),
    ).rejects.toThrow()
    expect((await s.inspectSessionTree('root')).sealed).toBeUndefined()
    await s.cancelCreatingChild({
      childKey: 'fresh',
      creationId: 'create',
      attemptId: 'attempt',
      expectedRevision: 1,
      reason: 'open_failed',
      cancelledAt: 1,
    })
    // Cancelled before acquisition remains unknown, never a fabricated owner epoch.
    await expect(
      s.sealIdleSessionTrees([{ rootSessionKey: 'root', retirementId: 'idle', epoch: 1 }]),
    ).rejects.toThrow()
    expect((await s.inspectSessionTree('root')).sealed).toBeUndefined()
    const permit = await s.reserve({
      rootTaskId: 'budget',
      originSessionKey: 'root',
      scopeIds: ['root:budget'],
      qMicro: null,
      effectId: 'model',
      requestHash: 'hash',
      writerGeneration: 1,
    })
    if (!permit.ok) throw new Error('fixture admission failed')
    await s.settleOrigin({
      permitId: permit.permitId,
      originSessionKey: 'root',
      originCostSeq: 2,
      actualMicro: 5n,
      complete: true,
      creditSource: 'gateway',
      writerGeneration: 1,
    })
    await s.release('root', 'owner')
    await s.recordSessionOwnerClosed(owner, 2)
    const input = {
      rootSessionKey: 'root',
      retirementId: 'comparison',
      epoch: 1,
      members: [
        { sessionKey: 'root', finalSeq: 2 },
        { sessionKey: 'fresh', finalSeq: 0 },
      ],
    }
    await s.sealSessionTree(input)
    await expect(
      s.purgeSealedSessionTree({ ...input, members: [{ sessionKey: 'root', finalSeq: 2 }] }),
    ).rejects.toThrow(/membership/)
    const failure = new DatabaseSync(join(dir, 'sessions.db'))
    try {
      failure.exec(
        "CREATE TRIGGER reject_purge BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'fixture purge failure'); END",
      )
      await expect(s.purgeSealedSessionTree(input)).rejects.toThrow(/fixture purge failure/)
      expect(failure.prepare('SELECT COUNT(*) AS n FROM cost_origins').get()?.n).toBe(1)
      expect(failure.prepare('SELECT COUNT(*) AS n FROM child_tasks').get()?.n).toBe(1)
      expect(failure.prepare('SELECT COUNT(*) AS n FROM session_tree_purges').get()?.n).toBe(0)
      failure.exec('DROP TRIGGER reject_purge')
    } finally {
      failure.close()
    }
    await s.purgeSealedSessionTree(input)
    expect(await s.scan('root', { limit: 10 })).toEqual([])
    const raw = new DatabaseSync(join(dir, 'sessions.db'))
    try {
      for (const table of [
        'sessions',
        'events',
        'registers',
        'child_tasks',
        'child_workspaces',
        'budget_scopes',
        'budget_reservations',
        'cost_origins',
        'child_writer_gens',
      ])
        expect(raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n).toBe(0)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM session_retirement_members').get()?.n).toBe(2)
      expect(
        Number(raw.prepare('SELECT COUNT(*) AS n FROM session_budget_origins').get()?.n),
      ).toBeGreaterThan(0)
    } finally {
      raw.close()
    }
    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db') })
    expect((await s.inspectSessionTree('root')).ownerEvidence).toEqual([
      { sessionKey: 'fresh' },
      { sessionKey: 'root', evidence: { owner, closed: { finalSeq: 2 } } },
    ])
    await s.recordSessionOwnerClosed(owner, 2)
    await s.purgeSealedSessionTree(input)
    await expect(
      s.purgeSealedSessionTree({ ...input, members: input.members.map((row) => ({ ...row, finalSeq: 0 })) }),
    ).rejects.toThrow(/receipt/)
    await expect(s.open('fresh', { writerRunId: 'new', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_CLOSED',
    })
    await expect(
      s.reserve({
        rootTaskId: 'budget',
        scopeIds: ['root:budget'],
        qMicro: null,
        effectId: 'new',
        requestHash: 'new',
        writerGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: 'E_CLOSED' })
  })

  it.each([
    'writer',
    'turn',
    'op',
    'head',
    'external fork',
    'foreign origin',
    'held',
    'unknown reservation',
    'unknown cost',
    'scope dependency',
    'unknown session',
  ] as const)('refuses purge atomically when %s evidence is unsafe', async (hazard) => {
    await s.open('root', { writerRunId: 'owner', ttlMs: 1000 })
    const events =
      hazard === 'turn'
        ? [ev('turn/start', {})]
        : hazard === 'op'
          ? [ev('op.state', { phase: { kind: 'tools' } }, { register: 'op.state' })]
          : [ev('user/message', { content: [] })]
    await s.commit('root', { expectedWriterRunId: 'owner', events })
    await s.ensureRootScope('budget', null)
    const permit = await s.reserve({
      rootTaskId: 'budget',
      originSessionKey: 'root',
      scopeIds: ['root:budget'],
      qMicro: null,
      effectId: 'model',
      requestHash: 'hash',
      writerGeneration: 1,
    })
    if (!permit.ok) throw new Error('fixture admission failed')
    if (hazard === 'unknown reservation')
      await s.settleOrigin({
        permitId: permit.permitId,
        originSessionKey: 'root',
        originCostSeq: 1,
        actualMicro: null,
        complete: false,
        creditSource: 'unknown',
      })
    else if (hazard !== 'held') await s.releaseReservation(permit.permitId)
    if (hazard === 'external fork') await s.createChild('root', 1, 'independent')
    if (hazard !== 'writer') await s.release('root', 'owner')
    const raw = new DatabaseSync(join(dir, 'sessions.db'))
    try {
      if (hazard === 'foreign origin')
        raw.exec("INSERT INTO session_budget_origins VALUES('budget','foreign')")
      if (hazard === 'unknown cost') raw.exec("INSERT INTO cost_origins VALUES('root:1','0','[]')")
      if (hazard === 'scope dependency')
        raw.exec(
          "INSERT INTO budget_scopes VALUES('foreign','another',NULL,'root:budget',NULL,'0','0'); INSERT INTO session_budget_origins VALUES('another','foreign')",
        )
      if (hazard === 'unknown session')
        raw.exec("UPDATE sessions SET format_version=999 WHERE session_key='root'")
      const input = {
        rootSessionKey: 'root',
        retirementId: 'comparison',
        epoch: 1,
        members: [{ sessionKey: 'root', finalSeq: hazard === 'head' ? 0 : 1 }],
      }
      await s.sealSessionTree(input)
      await expect(s.purgeSealedSessionTree(input)).rejects.toMatchObject({ code: 'E_RELATION' })
      expect(raw.prepare("SELECT COUNT(*) AS n FROM events WHERE session_key='root'").get()?.n).toBe(1)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM budget_reservations').get()?.n).toBe(1)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM session_tree_purges').get()?.n).toBe(0)
    } finally {
      raw.close()
    }
  })

  it('requires terminal child/workspace evidence and the inherited final head before purging a fork', async () => {
    await s.open('root', { writerRunId: 'owner', ttlMs: 1000 })
    await s.commit('root', { expectedWriterRunId: 'owner', events: [ev('user/message', { content: [] })] })
    await s.ensureRootScope('budget', null)
    const result = await s.createDelegatedChild({
      childKey: 'fork',
      parentKey: 'root',
      boundarySeq: 1,
      creationId: 'create',
      attemptId: 'attempt',
      kind: 'fork',
      seedMode: 'history',
      rootTaskId: 'budget',
      runtimeOwnerSessionKey: 'root',
      generationDepth: 1,
      generationLimit: 3,
      maxFanOut: 3,
      inputHash: 'input',
      inputText: 'input',
      cwd: '/fixture',
      actorId: 'test',
      isolation: 'worktree',
      workspaceId: 'workspace',
      treeCapMicro: null,
      childCapMicro: null,
      writerRunId: 'child-owner',
    })
    expect(result.status).toBe('created')
    await s.cancelCreatingChild({
      childKey: 'fork',
      creationId: 'create',
      attemptId: 'attempt',
      expectedRevision: 1,
      reason: 'open_failed',
      cancelledAt: 1,
    })
    await s.release('root', 'owner')
    const input = {
      rootSessionKey: 'root',
      retirementId: 'comparison',
      epoch: 1,
      members: [
        { sessionKey: 'root', finalSeq: 1 },
        { sessionKey: 'fork', finalSeq: 1 },
      ],
    }
    await s.sealSessionTree(input)
    const raw = new DatabaseSync(join(dir, 'sessions.db'))
    try {
      for (const phase of ['planned', 'attached', 'kept_dirty', 'cleanup_failed']) {
        raw.prepare('UPDATE child_workspaces SET phase=?').run(phase)
        await expect(s.purgeSealedSessionTree(input)).rejects.toThrow(/workspace cleanup/)
      }
      raw.exec("UPDATE child_workspaces SET phase='branch_removed'")
      for (const [state, phase] of [
        ['creating', 'creating'],
        ['failed', 'deferred'],
        ['running', 'committed'],
        ['alien', 'committed'],
      ] as const) {
        raw.prepare('UPDATE child_tasks SET state=?,creation_phase=?').run(state, phase)
        await expect(s.purgeSealedSessionTree(input)).rejects.toThrow(/child is active/)
      }
      raw.exec("UPDATE child_tasks SET state='failed',creation_phase='cancelled'")
      await expect(
        s.purgeSealedSessionTree({
          ...input,
          members: [
            { sessionKey: 'root', finalSeq: 1 },
            { sessionKey: 'fork', finalSeq: 0 },
          ],
        }),
      ).rejects.toThrow(/final head/)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(2)
      await s.purgeSealedSessionTree(input)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(0)
    } finally {
      raw.close()
    }
  })

  async function legacyJev(key: string, root: string, variant = 'valid') {
    // Structural shape taken from protected records in the closed comparison copy; all payloads,
    // IDs and model names here are synthetic. These are actual admission/dispatch/settlement edges.
    await s.ensureRootScope(root, null)
    const requestedId = `request:${key}`
    const effectId = createHash('sha256')
      .update(canonicalJson(['jev-tree-model', key, 'main', requestedId]))
      .digest('hex')
    const requestHash = 'a'.repeat(64)
    const scopeIds = [`root:${root}`]
    const permit = await s.reserve({
      rootTaskId: root,
      scopeIds,
      qMicro: null,
      effectId,
      requestHash,
      writerGeneration: 1,
    })
    if (!permit.ok) throw new Error('fixture admission failed')
    await s.open(key, { writerRunId: key, ttlMs: 1000 })
    const metadata = { version: 1, turn: 'turn', step: 'step', attempt: 'attempt' }
    const runtime = { id: 'jevloop', version: '1' }
    const requested = {
      ...metadata,
      id: requestedId,
      kind: 'model.requested',
      call: {
        purpose: 'decision',
        backend: 'fixture',
        endpoint: 'fixture',
        requestedModel: 'fixture',
        codec: 'json',
        input: {},
        inputCursor: '1',
      },
    }
    const settled = {
      ...metadata,
      id: `settled:${key}`,
      kind: 'model.settled',
      requested: requestedId,
      settlement: {
        output: {},
        snapshot: variant.includes('decision')
          ? { codec: 'systemone-json-v1', response: {} }
          : variant.includes('language')
            ? {
                codec: 'agnes-inference-v1',
                response: {
                  events: variant.includes('incomplete') ? [] : [{ type: 'done', reason: 'stop' }],
                },
              }
            : { codec: 'fixture', response: {} },
        ...(variant.includes('aborted') ? { error: { code: 'ABORTED', message: 'cancelled' } } : {}),
        observedModel: 'fixture',
        usage: {},
        latencyMs: 1,
      },
    }
    const admission = {
      requestedId,
      requestedSeq: 1,
      rootTaskId: root,
      scopeIds,
      effectId,
      requestHash,
      qMicro: null,
      writerGeneration: 1,
    }
    const dispatch = { admissionSeq: 2, permitId: variant === 'wrong dispatch' ? 'wrong' : permit.permitId }
    if (variant === 'wrong admission') admission.effectId = 'other'
    const events = [
      ev('runtime/record', { runtime, record: requested }, { origin: 'system' }),
      ev('x/agnes/jev-tree-admission', admission, { origin: 'system', ignorable: true }),
      ev('x/agnes/jev-tree-dispatch', dispatch, { origin: 'system', ignorable: true }),
      variant === 'native source'
        ? ev(
            'verifier/signal',
            { scope: 'step', tier: 1, verdict: 'accept', reasons: [], toolUseId: 'fixture' },
            { origin: 'system' },
          )
        : ev(
            'runtime/record',
            { runtime, record: settled },
            {
              origin: variant === 'untrusted' ? 'principal' : 'system',
              trust: variant === 'untrusted trust' ? 'untrusted' : 'trusted',
            },
          ),
    ]
    const integrity = prepareIntegrity(
      key,
      events.map((event, i) => ({ ...event, seq: i + 1 })),
      { lastSeq: 0, legacyThroughSeq: 0, headDigest: null },
    )
    await s.commit(key, {
      expectedWriterRunId: key,
      events,
      ...(variant === 'legacy' ? {} : { integrity: integrity.entries }),
    })
    await s.release(key, key)
    await s.settleOrigin({
      permitId: permit.permitId,
      originSessionKey: key,
      originCostSeq: 4,
      actualMicro: variant === 'unknown cost' || variant.includes('response') ? null : 5n,
      complete: variant !== 'unknown cost' && !variant.includes('response'),
      creditSource: variant === 'unknown cost' || variant.includes('response') ? 'unknown' : 'gateway',
    })
    return { permitId: permit.permitId, effectId, requestHash }
  }

  it.each([
    'valid',
    'legacy',
    'tampered',
    'untrusted',
    'untrusted trust',
    'borrowed source',
    'unknown cost',
    'effect',
    'hash',
    'generation',
    'scopes',
    'v1',
    'missing source',
    'unsettled permit',
    'native source',
    'wrong dispatch',
    'wrong admission',
    'rewritten metadata',
  ] as const)('backfills only independently protected legacy Jev budget bindings (%s)', async (variant) => {
    await legacyJev('source:session', 'opaque-with-no-session-encoding', variant)
    if (variant === 'unsettled permit') {
      const extra = await s.reserve({
        rootTaskId: 'opaque-with-no-session-encoding',
        scopeIds: ['root:opaque-with-no-session-encoding'],
        qMicro: null,
        effectId: 'extra',
        requestHash: 'extra',
        writerGeneration: 1,
      })
      if (!extra.ok) throw new Error('fixture admission failed')
      await s.releaseReservation(extra.permitId)
    }
    const raw = new DatabaseSync(join(dir, 'sessions.db'))
    try {
      const row = raw.prepare('SELECT scope_ids FROM cost_origins').get()
      const envelope = JSON.parse(String(row?.scope_ids))
      if (variant === 'effect') envelope.effectId = 'other'
      if (variant === 'rewritten metadata') {
        envelope.effectId = 'other'
        raw.exec("UPDATE budget_reservations SET effect_id='other'")
      }
      if (variant === 'hash') envelope.requestHash = 'other'
      if (variant === 'generation') envelope.writerGeneration = 2
      if (variant === 'scopes') envelope.scopeIds = ['foreign']
      if (variant === 'v1') envelope.v = 1
      raw.prepare('UPDATE cost_origins SET scope_ids=?').run(JSON.stringify(envelope))
      if (variant === 'tampered') raw.exec("UPDATE events SET data='{}'")
      if (variant === 'missing source') raw.exec("UPDATE cost_origins SET origin_key='source:session:5'")
      if (variant === 'borrowed source') {
        await s.createChild('source:session', 4, 'borrower')
        raw.exec("UPDATE cost_origins SET origin_key='borrower:4'")
      }
      const target = variant === 'borrowed source' ? 'borrower' : 'source:session'
      const input = {
        rootSessionKey: target,
        retirementId: 'comparison',
        epoch: 1,
        members: [{ sessionKey: target, finalSeq: 4 }],
      }
      await s.sealSessionTree(input)
      if (variant === 'valid') {
        await s.purgeSealedSessionTree(input)
        expect(raw.prepare('SELECT root_task_id,session_key FROM session_budget_origins').all()).toEqual([
          { root_task_id: 'opaque-with-no-session-encoding', session_key: 'source:session' },
        ])
        expect(raw.prepare('SELECT COUNT(*) AS n FROM cost_origins').get()?.n).toBe(0)
      } else {
        await expect(s.purgeSealedSessionTree(input)).rejects.toThrow()
        expect(raw.prepare('SELECT COUNT(*) AS n FROM session_budget_origins').get()?.n).toBe(0)
        expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(4)
      }
    } finally {
      raw.close()
    }
  })

  it.each([
    'decision response',
    'language response',
    'incomplete language response',
    'aborted language response',
  ])('retains unknown accounting only for independently proven ended calls (%s)', async (variant) => {
    await legacyJev('ended-session', 'opaque-ended', variant)
    const owner = s.readSessionOwnerEvidence('ended-session')?.owner
    if (!owner) throw new Error('Missing acquisition')
    await s.recordSessionOwnerClosed(owner, 4)
    const input = {
      rootSessionKey: 'ended-session',
      retirementId: 'ended',
      epoch: 1,
      members: [{ sessionKey: 'ended-session', finalSeq: 4 }],
    }
    await s.sealSessionTree(input)
    const raw = new DatabaseSync(join(dir, 'sessions.db'))
    const accounting = () =>
      ['budget_scopes', 'budget_reservations', 'cost_origins', 'child_writer_gens'].map((table) =>
        raw.prepare(`SELECT * FROM ${table}`).all(),
      )
    try {
      const before = accounting()
      await expect(s.purgeSealedSessionTree(input)).rejects.toThrow()
      const retained = { ...input, accounting: 'retain-verified-ended' as const }
      if (variant.includes('incomplete') || variant.includes('aborted')) {
        await expect(s.purgeSealedSessionTree(retained)).rejects.toThrow()
        expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(4)
        expect(raw.prepare('SELECT COUNT(*) AS n FROM session_budget_origins').get()?.n).toBe(0)
        expect(raw.prepare('SELECT COUNT(*) AS n FROM session_tree_retained_budgets').get()?.n).toBe(0)
      } else {
        raw.exec(
          "CREATE TRIGGER fail_retention BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'retention failure'); END",
        )
        await expect(s.purgeSealedSessionTree(retained)).rejects.toThrow('retention failure')
        expect(raw.prepare('SELECT COUNT(*) AS n FROM session_tree_retained_budgets').get()?.n).toBe(0)
        expect(raw.prepare('SELECT COUNT(*) AS n FROM session_budget_origins').get()?.n).toBe(0)
        raw.exec('DROP TRIGGER fail_retention')
        await s.purgeSealedSessionTree(retained)
        expect(raw.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(0)
        expect(raw.prepare('SELECT COUNT(*) AS n FROM session_tree_retained_budgets').get()?.n).toBe(1)
        await s.close()
        s = createSqliteStorage({ file: join(dir, 'sessions.db'), clock: () => now })
        await s.purgeSealedSessionTree(retained)
        await expect(s.purgeSealedSessionTree(input)).rejects.toThrow(/explicit purge mode/)
      }
      expect(accounting()).toEqual(before)
    } finally {
      raw.close()
    }
  })

  it('recovers every protected legacy owner, preserves unknown fees, and rolls back backfill with purge failure', async () => {
    await legacyJev('legacy-a', 'shared-opaque')
    await legacyJev('legacy-b', 'shared-opaque', 'unknown cost')
    await s.open('new-comparison', { writerRunId: 'new', ttlMs: 1000 })
    await s.commit('new-comparison', { expectedWriterRunId: 'new', events: [ev('user/message', {})] })
    await s.release('new-comparison', 'new')
    const input = {
      rootSessionKey: 'new-comparison',
      retirementId: 'comparison',
      epoch: 1,
      members: [{ sessionKey: 'new-comparison', finalSeq: 1 }],
    }
    await s.sealSessionTree(input)
    const raw = new DatabaseSync(join(dir, 'sessions.db'))
    try {
      raw.exec(
        "CREATE TRIGGER reject_backfilled_purge BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
      )
      await expect(s.purgeSealedSessionTree(input)).rejects.toThrow(/fixture failure/)
      expect(raw.prepare('SELECT COUNT(*) AS n FROM session_budget_origins').get()?.n).toBe(0)
      raw.exec('DROP TRIGGER reject_backfilled_purge')
      await s.purgeSealedSessionTree(input)
      expect(
        raw.prepare('SELECT session_key FROM session_budget_origins ORDER BY session_key').all(),
      ).toEqual([{ session_key: 'legacy-a' }, { session_key: 'legacy-b' }])
      expect(raw.prepare('SELECT COUNT(*) AS n FROM budget_reservations').get()?.n).toBe(2)
      expect(
        raw.prepare("SELECT COUNT(*) AS n FROM budget_reservations WHERE status='unknown'").get()?.n,
      ).toBe(1)
      expect(raw.prepare("SELECT micro FROM cost_origins WHERE origin_key='legacy-b:4'").get()?.micro).toBe(
        'unknown',
      )
      const shared = {
        rootSessionKey: 'legacy-a',
        retirementId: 'other',
        epoch: 2,
        members: [{ sessionKey: 'legacy-a', finalSeq: 4 }],
      }
      await s.sealSessionTree(shared)
      await expect(s.purgeSealedSessionTree(shared)).rejects.toThrow(/shared or unknown/)
    } finally {
      raw.close()
    }
  })

  it('open takes a lease, commit assigns seq and materializes registers', async () => {
    const o = await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    expect(o).toMatchObject({ lastSeq: 0, formatVersion: 1, created: true, ownerEpoch: 1 })
    const r = await s.commit('k', {
      events: [ev('user/message', { content: [] }), ev('op.state', { step: 1 }, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    expect(r).toEqual({ firstSeq: 1, seqs: [1, 2] })
    expect(await s.registers('k')).toEqual([{ register: 'op.state', key: 'main', seq: 2, data: { step: 1 } }])
  })
  it('drops the retired UI projection cache table when a database is opened', async () => {
    const legacy = mkdtempSync(join(tmpdir(), 'agnes-sqlite-ui-cache-'))
    try {
      const file = join(legacy, 'sessions.db')
      const raw = new DatabaseSync(file)
      raw.exec(
        'CREATE TABLE ui_projection_cache (session_key TEXT NOT NULL, lane BLOB NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_key, lane))',
      )
      raw.exec("INSERT INTO ui_projection_cache VALUES ('k', x'6d61696e', '{}')")
      raw.close()
      const storage = createSqliteStorage({ file, tablesDir: join(legacy, 'tables') })
      expect(storage.coreTableNames()).not.toContain('ui_projection_cache')
      await storage.close()
    } finally {
      rmSync(legacy, { recursive: true, force: true })
    }
  })
  it('drops the retired fold cache table when a database is opened', async () => {
    const legacy = mkdtempSync(join(tmpdir(), 'agnes-sqlite-fold-cache-'))
    try {
      const file = join(legacy, 'sessions.db')
      const raw = new DatabaseSync(file)
      raw.exec(
        'CREATE TABLE fold_cache (session_key TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL)',
      )
      raw.exec("INSERT INTO fold_cache VALUES ('k', 3, '{}')")
      raw.close()
      const storage = createSqliteStorage({ file, tablesDir: join(legacy, 'tables') })
      expect(storage.coreTableNames()).not.toContain('fold_cache')
      await storage.close()
    } finally {
      rmSync(legacy, { recursive: true, force: true })
    }
  })
  it('discards every row of a newly opened session only while its writer lease is held', async () => {
    await s.open('discard', { writerRunId: 'r1', ttlMs: 1_000 })
    await s.commit('discard', {
      events: [ev('op.state', { step: 1 }, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    await s.discardNewSession('discard', 'r1')
    const reopened = await s.open('discard', { writerRunId: 'r2', ttlMs: 1_000 })
    expect(reopened).toMatchObject({ lastSeq: 0, formatVersion: 1, created: true, ownerEpoch: 2 })
    expect(await s.registers('discard')).toEqual([])
    await expect(s.discardNewSession('discard', 'r1')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
  })
  it('reopens a 1000+ row session from SQLite, folding everything from the ledger while verifying it', async () => {
    const file = join(dir, 'sessions.db')
    const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
    const options = {
      storage: s,
      key: 'cached',
      writerRunId: 'r1',
      ttlMs: 1_000,
      clock: () => now,
      ids: defaultIds(),
      relationCheck: () => undefined,
    }
    const first = await openTracked(options)
    await first.log.append(
      Array.from({ length: 1_001 }, (_, index) => ({
        type: 'user/message',
        actor,
        origin: 'system' as const,
        trust: 'trusted' as const,
        data: { content: [{ type: 'text' as const, text: `message-${index}` }] },
      })),
    )
    await first.log.close()
    await s.close()

    s = createSqliteStorage({ file, clock: () => now, tablesDir: join(dir, 'tables') })
    const scannedFrom: number[] = []
    const originalScan = s.scan.bind(s)
    s.scan = async (key, query) => {
      scannedFrom.push(query.fromSeq ?? 1)
      return originalScan(key, query)
    }
    const reopened = await openTracked({ ...options, storage: s, writerRunId: 'r2' })
    expect(reopened.tracker.state.lastSeq).toBe(1_001)
    expect(reopened.surface.nodes()).toHaveLength(1_001)
    expect(reopened.ui.diagnostics().applied).toBe(1_001)
    // Rows are folded while the open verifies them; nothing reads them a second time.
    expect(scannedFrom).toEqual([])
    await reopened.log.close()
  })
  it('reports an op cell written as a cell to crash reclaim', async () => {
    await s.open('cell-op', { writerRunId: 'dead-run', ttlMs: 100 })
    await s.commit('cell-op', {
      events: [ev('user/message', {})],
      expectedWriterRunId: 'dead-run',
      opState: { lane: 'main', data: { step: 4 } as never },
    })
    expect(s.crashReclaim.claimForReclaim('cell-op', 'dead-run', 1_100, 1_101)).toEqual({
      opState: { seq: 1, data: { step: 4 } },
      seq: 1,
    })
  })
  it('exposes only the narrow claim/op-state operations production crash reclaim needs', async () => {
    await s.open('recover-me', { writerRunId: 'dead-run', ttlMs: 100 })
    await s.commit('recover-me', {
      events: [ev('op.state', { step: 3 }, { register: 'op.state' })],
      expectedWriterRunId: 'dead-run',
    })
    await s.open('idle-one', { writerRunId: 'idle-run', ttlMs: 100 })
    await s.commit('idle-one', { events: [ev('user/message', {})], expectedWriterRunId: 'idle-run' })

    expect(s.crashReclaim.listExpired(1_099)).toEqual([])
    expect(s.crashReclaim.listExpired(1_101)).toEqual([
      { sessionKey: 'recover-me', runId: 'dead-run', until: 1_100, generation: 1 },
      { sessionKey: 'idle-one', runId: 'idle-run', until: 1_100, generation: 1 },
    ])
    // Only the exact expired row the listing saw is acted on.
    expect(s.crashReclaim.claimForReclaim('recover-me', 'wrong-run', 1_100, 1_101)).toBeNull()
    expect(s.crashReclaim.claimForReclaim('recover-me', 'dead-run', 1_099, 1_101)).toBeNull()
    expect(s.crashReclaim.claimForReclaim('recover-me', 'dead-run', 1_100, 1_100)).toBeNull()
    // An open turn is reported and the row left for the resuming writer.
    expect(s.crashReclaim.claimForReclaim('recover-me', 'dead-run', 1_100, 1_101)).toEqual({
      opState: { seq: 1, data: { step: 3 } },
      seq: 1,
    })
    // No turn open: the row is deleted.
    // The ledger head is reported for an idle session.
    expect(s.crashReclaim.claimForReclaim('idle-one', 'idle-run', 1_100, 1_101)).toEqual({
      opState: undefined,
      seq: 1,
    })
    expect(s.crashReclaim.listExpired(1_101)).toEqual([
      { sessionKey: 'recover-me', runId: 'dead-run', until: 1_100, generation: 1 },
    ])
  })
  it('round-trips every optional envelope field rather than dropping it on the floor', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [
        ev(
          'tool/call',
          { a: 1 },
          {
            lane: 'side',
            v: 2,
            ignorable: true,
            sourceEventSeqs: [1, 2],
            trust: 'untrusted',
            origin: 'model',
          },
        ),
      ],
      expectedWriterRunId: 'r1',
    })
    const [row] = await s.scan('k', { limit: 10 })
    expect(row).toMatchObject({
      seq: 1,
      type: 'tool/call',
      lane: 'side',
      v: 2,
      ignorable: true,
      sourceEventSeqs: [1, 2],
      trust: 'untrusted',
      origin: 'model',
      data: { a: 1 },
    })
    expect(row?.actor).toEqual({ id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} })
  })
  it('rejects a second writer while the lease is live and admits it after expiry', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    now += 2000
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).resolves.toBeDefined()
    await expect(
      s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r1' }),
    ).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
  })
  it('CAS on register seq refuses before anything is written', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('op.state', { step: 1 }, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    await expect(
      s.commit('k', {
        events: [ev('user/message', {}), ev('op.state', { step: 2 }, { register: 'op.state' })],
        expectedWriterRunId: 'r1',
        expectedRegisterSeq: { register: 'op.state', key: 'main', seq: 99 },
      }),
    ).rejects.toMatchObject({ code: 'E_CAS' })
    expect((await s.scan('k', { limit: 10 })).length).toBe(1)
  })
  // The CAS test above cannot show atomicity: its check runs before the first insert, so nothing
  // has been written when it throws and the assertion holds even with no transaction at all. This
  // one fails in the middle of the batch, after event 1 is already in, which is the only shape that
  // distinguishes a rolled-back batch from a partially applied one.
  it('a failure part-way through a batch rolls the whole batch back', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(
      s.commit('k', {
        events: [ev('user/message', { ok: true }), ev('user/message', circular)],
        expectedWriterRunId: 'r1',
      }),
    ).rejects.toThrow()
    expect((await s.scan('k', { limit: 10 })).length).toBe(0)
    expect((await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })).lastSeq).toBe(0)
  })
  it('rolls back the register rows of a failed batch too, not only the events', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('op.state', { step: 1 }, { register: 'op.state' })],
      expectedWriterRunId: 'r1',
    })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(
      s.commit('k', {
        events: [ev('op.state', { step: 2 }, { register: 'op.state' }), ev('user/message', circular)],
        expectedWriterRunId: 'r1',
      }),
    ).rejects.toThrow()
    expect(await s.registers('k')).toEqual([{ register: 'op.state', key: 'main', seq: 1, data: { step: 1 } }])
  })
  it('renew extends the lease by the ttl recorded at open', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    now += 900
    await s.renew('k', 'r1')
    now += 900
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    await expect(s.renew('k', 'r2')).rejects.toMatchObject({ code: 'E_WRITER_LEASE' })
    now += 1200
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).resolves.toBeDefined()
  })
  it('release drops the lease so another writer may open at once', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.release('k', 'r2')
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).rejects.toMatchObject({
      code: 'E_WRITER_LEASE',
    })
    await s.release('k', 'r1')
    await expect(s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).resolves.toBeDefined()
  })
  it('a commit waits out another process briefly holding the ledger write lock', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    const child = spawn(process.execPath, [
      '-e',
      `const db = new (require('node:sqlite').DatabaseSync)(process.argv[1])
       db.exec('BEGIN IMMEDIATE')
       process.stdout.write('locked')
       setTimeout(() => { db.exec('COMMIT'); db.close() }, 200)`,
      join(dir, 'sessions.db'),
    ])
    const exited = once(child, 'exit')
    await once(child.stdout, 'data')
    const started = performance.now()
    const committed = await s.commit('k', { events: [ev('user/message', {})], expectedWriterRunId: 'r1' })
    const waited = performance.now() - started
    await exited
    expect(committed).toEqual({ firstSeq: 1, seqs: [1] })
    expect(waited).toBeGreaterThan(100)
  })
  it('tombstone deletes a register row', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [
        ev('op.state', { step: 1 }, { register: 'op.state' }),
        ev('op.state', null, { register: 'op.state' }),
      ],
      expectedWriterRunId: 'r1',
    })
    expect(await s.registers('k')).toEqual([])
  })
  it('scan requires a bound and filters by type/lane/order', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', {
      events: [ev('user/message', {}), ev('assistant/message', {}, { lane: 'side' })],
      expectedWriterRunId: 'r1',
    })
    await expect(s.scan('k', {})).rejects.toMatchObject({ code: 'E_SCAN_UNBOUNDED' })
    expect((await s.scan('k', { type: 'assistant/message', limit: 10 })).map((e) => e.seq)).toEqual([2])
    expect((await s.scan('k', { lane: 'main', limit: 10 })).map((e) => e.seq)).toEqual([1])
    expect((await s.scan('k', { toSeq: 2, order: 'desc' })).map((e) => e.seq)).toEqual([2, 1])
    expect((await s.scan('k', { fromSeq: 2, limit: 10 })).map((e) => e.seq)).toEqual([2])
    expect(
      (await s.scan('k', { type: ['user/message', 'assistant/message'], limit: 10 })).map((e) => e.seq),
    ).toEqual([1, 2])
  })
  it('child session reads parent prefix and continues seq', async () => {
    await s.open('p', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('p', {
      events: [ev('user/message', { n: 1 }), ev('assistant/message', { n: 2 }), ev('user/message', { n: 3 })],
      expectedWriterRunId: 'r1',
    })
    await s.createChild('p', 2, 'c')
    expect(await s.open('c', { writerRunId: 'r9', ttlMs: 1000 })).toMatchObject({
      lastSeq: 2,
      parent: { key: 'p', boundarySeq: 2 },
    })
    expect(
      (await s.commit('c', { events: [ev('session/start', {})], expectedWriterRunId: 'r9' })).seqs,
    ).toEqual([3])
    expect((await s.scan('c', { fromSeq: 1, limit: 10 })).map((e) => e.seq)).toEqual([1, 2, 3])
  })
  it('a child never sees what the parent appended after the fork boundary', async () => {
    await s.open('p', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('p', {
      events: [ev('user/message', { n: 1 }), ev('user/message', { n: 2 })],
      expectedWriterRunId: 'r1',
    })
    await s.createChild('p', 2, 'c')
    await s.commit('p', { events: [ev('user/message', { n: 3 })], expectedWriterRunId: 'r1' })
    await s.open('c', { writerRunId: 'r9', ttlMs: 1000 })
    expect((await s.scan('c', { limit: 10 })).map((e) => e.seq)).toEqual([1, 2])
  })
  it('tables(owner) gives each package its own database file, out of reach of the core tables', () => {
    const t = s.tables('@agnes/base').table('usage_ledger')
    t.exec('create table if not exists usage_ledger (id integer primary key, credits real)')
    t.run('insert into usage_ledger (credits) values (?)', [1.5])
    expect(t.all<{ credits: number }>('select credits from usage_ledger')).toEqual([{ credits: 1.5 }])
    expect(t.get<{ credits: number }>('select credits from usage_ledger')).toEqual({ credits: 1.5 })
    expect(() => s.tables('@agnes/base').table('Bad Name')).toThrow(/table name/)
    // The property the name check alone never had: a package handle cannot see, read or drop the
    // ledger tables, because they are not on this connection.
    expect(() => t.all('select * from writer_claims')).toThrow(/no such table/)
    expect(() => t.exec('drop table events')).toThrow(/no such table/)
    // Nor another package's tables.
    expect(() => s.tables('@acme/other').table('usage_ledger').all('select * from usage_ledger')).toThrow(
      /no such table/,
    )
  })
  it('a package table transaction rolls back on throw', () => {
    const t = s.tables('@agnes/base').table('t')
    t.exec('create table t (v integer)')
    expect(() =>
      t.transaction(() => {
        t.run('insert into t (v) values (?)', [1])
        throw new Error('nope')
      }),
    ).toThrow('nope')
    expect(t.all('select v from t')).toEqual([])
  })
  it('refuses a bind parameter SQLite cannot carry instead of handing it to the driver', () => {
    const t = s.tables('@agnes/base').table('t')
    t.exec('create table t (v integer)')
    expect(() => t.run('insert into t (v) values (?)', [{ nope: true } as unknown as number])).toThrow(
      /bind parameter/,
    )
  })
  it('survives reopen (durability)', async () => {
    await s.open('k', { writerRunId: 'r1', ttlMs: 1000 })
    await s.commit('k', { events: [ev('user/message', { x: 1 })], expectedWriterRunId: 'r1' })
    await s.close()
    s = createSqliteStorage({ file: join(dir, 'sessions.db'), clock: () => now + 5000 })
    expect((await s.open('k', { writerRunId: 'r2', ttlMs: 1000 })).lastSeq).toBe(1)
  })

  it('adds nullable integrity columns to a legacy events table without rewriting rows', async () => {
    const file = join(dir, 'legacy.db')
    const legacy = new DatabaseSync(file)
    legacy.exec(`CREATE TABLE events (
      session_key TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, id TEXT NOT NULL,
      type TEXT NOT NULL, lane BLOB NOT NULL, v INTEGER NOT NULL, actor TEXT NOT NULL,
      origin TEXT NOT NULL, trust TEXT NOT NULL, register TEXT, ignorable INTEGER,
      surface_op TEXT, source_event_seqs TEXT, data TEXT NOT NULL,
      PRIMARY KEY (session_key, seq))`)
    legacy.exec(`INSERT INTO events VALUES (
      'k', 1, '2026-09-12T00:00:00.000Z', 'old', 'user/message', x'6d61696e', 1,
      '{"id":"u","org":"local","role":"owner","deptPath":[],"attrs":{}}',
      'principal', 'trusted', NULL, NULL, NULL, NULL, '{"content":[]}')`)
    legacy.close()

    const migrated = createSqliteStorage({ file, clock: () => now, tablesDir: join(dir, 'legacy-tables') })
    const opened = await migrated.open('k', { writerRunId: 'new', ttlMs: 1000 })
    expect(opened.lastSeq).toBe(1)
    expect(await migrated.scanIntegrity('k', { fromSeq: 1, toSeq: 1, limit: 10 })).toMatchObject([
      { sessionKey: 'k', event: { id: 'old', seq: 1 }, integrity: null },
    ])
    await migrated.close()
  })

  it('detects direct mutation of a protected SQLite event on the next open', async () => {
    const file = join(dir, 'sessions.db')
    const log = await SessionLogImpl.open({
      storage: s,
      key: 'protected',
      writerRunId: 'writer',
      ttlMs: 1000,
      ids: defaultIds(),
      clock: () => now,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    })
    await log.append([ev('user/message', { content: [{ type: 'text', text: 'original' }] })])
    await log.close()
    await s.close()

    const attacker = new DatabaseSync(file)
    attacker
      .prepare('UPDATE events SET data = ? WHERE session_key = ? AND seq = 1')
      .run(JSON.stringify({ content: [{ type: 'text', text: 'changed' }] }), 'protected')
    attacker.close()

    s = createSqliteStorage({ file, clock: () => now + 5000, tablesDir: join(dir, 'tables') })
    await expect(
      SessionLogImpl.open({
        storage: s,
        key: 'protected',
        writerRunId: 'reader',
        ttlMs: 1000,
        ids: defaultIds(),
        clock: () => now + 5000,
        timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      }),
    ).rejects.toMatchObject({ code: 'E_LEDGER_INTEGRITY' })
  })

  it('continues a protected parent prefix under the physical owner key', async () => {
    const openLog = (key: string, writerRunId: string) =>
      SessionLogImpl.open({
        storage: s,
        key,
        writerRunId,
        ttlMs: 1000,
        ids: defaultIds(),
        clock: () => now,
        timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      })
    const parent = await openLog('parent', 'parent-writer')
    await parent.append([ev('user/message', { content: [{ type: 'text', text: 'parent' }] })])
    await s.createChild('parent', 1, 'child')
    const child = await openLog('child', 'child-writer')
    await child.append([ev('user/message', { content: [{ type: 'text', text: 'child' }] })])
    await child.close()
    await parent.close()

    const rows = await s.scanIntegrity('child', { fromSeq: 1, toSeq: 2, limit: 10 })
    expect(rows.map((row) => [row.sessionKey, row.integrity?.mode])).toEqual([
      ['parent', 'anchor'],
      ['child', 'chain'],
    ])
    const reopened = await openLog('child', 'child-reader')
    expect(reopened.lastSeq).toBe(2)
    await reopened.close()
  })

  // Two owners legitimately close this handle - core's Kernel.close() and the adapter bundle that
  // opened it - and DatabaseSync throws on an already-closed handle, so a second close used to turn
  // an orderly shutdown into a reported teardown failure.
  it('close is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-sqlite-close-'))
    const s = createSqliteStorage({ file: join(dir, 'x.db'), tablesDir: join(dir, 'tables') })
    s.tables('@agnes/base').table('t')
    await s.close()
    await expect(s.close()).resolves.toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses an owner DB that still contains a session_profiles table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-sqlite-legacy-'))
    const tablesDir = join(dir, 'tables')
    const storage = createSqliteStorage({ file: join(dir, 'sessions.db'), tablesDir })
    const owner = '@agnes/daemon'
    mkdirSync(tablesDir, { recursive: true })
    const legacy = new DatabaseSync(join(tablesDir, `${ownerFile(owner)}.db`))
    legacy.exec('CREATE TABLE session_profiles (k TEXT)')
    legacy.close()
    // The refused owner file is closed again: Windows cannot delete a directory holding it open.
    const closes = vi.spyOn(DatabaseSync.prototype, 'close')
    try {
      expect(() => storage.tables(owner)).toThrow(/E_SESSION_TREE_SCHEMA/)
      expect(closes).toHaveBeenCalledOnce()
    } finally {
      closes.mockRestore()
    }
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
