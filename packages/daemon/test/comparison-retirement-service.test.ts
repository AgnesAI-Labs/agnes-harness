import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CliWorkspaceAuthority,
  createComparisonStore,
  createComparisonWorkspaces,
  createSqliteStorage,
  type SessionTreeInspection,
} from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { ComparisonRecord } from '@agnes/runtime-comparison'
import { expect, it } from 'vitest'
import { CommandQueue } from '../src/local/command-queue.js'
import { comparisonIdleGate } from '../src/local/comparison-idle-gate.js'
import { createComparisonRetirementService } from '../src/local/comparison-retirement-service.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { registerComparisonRetirementRPC } from '../src/local/methods/comparison-retirement.js'
import type { JsonRpcResponse } from '../src/rpc.js'

it.each([
  'normal',
  'lost acknowledgement',
  'failed preparation',
  'missing owner',
  'active failed preparation',
  'mismatched runtime',
])('authorizes and releases exact SQLite owners with the real Host idle gate (%s)', async (mode) => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-retirement-service-'))
  const dataDir = join(dir, 'data'),
    source = join(dir, 'source')
  mkdirSync(source)
  writeFileSync(join(source, 'keep.txt'), 'preserved')
  const physical = createHash('sha256').update('principal\0pair').digest('hex')
  const snapshots = createComparisonWorkspaces({
    directory: join(dataDir, 'comparisons', 'workspaces'),
    authorizeRead: async () => undefined,
  })
  const baseline = await snapshots.prepare({ comparisonId: physical, cwd: source })
  const { host } = await createTestHost({
    dataDir,
    disableSessionTitle: true,
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
  })
  const ledger = createSqliteStorage({ file: join(dataDir, 'sessions.db') })
  const storage = createComparisonStore(join(dataDir, 'comparisons', 'index.sqlite'), {
    sessionKeys: () => ({ left: 'left', right: mode === 'missing owner' ? 'never-acquired' : 'right' }),
  })
  const queue = new CommandQueue()
  try {
    const sessions = await Promise.all(
      (['left', 'right'] as const).map((side) =>
        host.createSession({
          key: side,
          cwd: baseline.roots[side],
          binding: new CliWorkspaceAuthority(baseline.roots[side]).bind(side),
        }),
      ),
    )
    const [left, right] = sessions
    if (!left || !right) throw new Error('missing sessions')
    const record: ComparisonRecord = {
      id: 'pair',
      revision: 0,
      createPayload: 'fixture',
      creation: 'ready',
      baseline,
      lanes: {
        left: {
          side: 'left',
          sessionId: left.key,
          runtime: left.runtimeIdentity,
          workspaceLabel: 'left',
          phase: 'idle',
          lastSeq: left.lastSeq,
        },
        right: {
          side: 'right',
          sessionId: right.key,
          runtime: right.runtimeIdentity,
          workspaceLabel: 'right',
          phase: 'idle',
          lastSeq: right.lastSeq,
        },
      },
      rounds: [],
      cancellation: {},
      cleanup: { exited: [], released: false },
    }
    const failed = [
      'failed preparation',
      'missing owner',
      'active failed preparation',
      'mismatched runtime',
    ].includes(mode)
    if (failed) {
      record.createPayload = JSON.stringify({
        requestId: 'pair',
        cwd: source,
        left: { runtime: 'native' },
        right: { runtime: mode === 'mismatched runtime' ? 'jevloop' : 'native' },
      })
      record.creation = 'failed'
      record.lanes = {}
      record.error = { code: 'PREPARE_REPLY_LOST', message: 'Preparation acknowledgement unavailable' }
    }
    if (mode === 'active failed preparation')
      await left.enqueue('next-turn', {
        actor: left.d.actor,
        content: [{ type: 'text', text: 'pending work' }],
        commandId: 'pending',
      })
    await storage.scoped('principal').compareAndSwap('pair', null, record)
    let closes = 0
    const options = {
      storage,
      backend: { ledger },
      queue,
      dataDir,
      ownership: {
        resolve: (key: string) =>
          sessions.some((session) => session.key === key)
            ? { principalId: 'principal', active: true as const }
            : undefined,
      },
      registry: {
        get: (key: string) => {
          const session = sessions.find((session) => session.key === key)
          return session ? { session } : undefined
        },
        async closeAndConfirm(key: string) {
          closes++
          const session = sessions.find((session) => session.key === key)
          if (!session) throw new Error('missing')
          await session.close()
          return {
            exited: true as const,
            owner: {
              sessionKey: key,
              writerRunId: session.writerRunId,
              generation: 1,
              workerGeneration: null,
            },
          }
        },
      },
    }
    if (failed) {
      const service = createComparisonRetirementService({
        ...options,
        backend: { ledger, idleGate: comparisonIdleGate({ ledger, local: host.sessionIdleGates }) },
      })
      const input = { principal: 'principal', id: 'pair', expectedRevision: 0 }
      if (mode !== 'failed preparation') {
        await expect(service.release(input)).rejects.toMatchObject({
          code: mode === 'active failed preparation' ? 'COMPARISON_BUSY' : 'COMPARISON_OWNER_UNKNOWN',
        })
        expect(closes).toBe(0)
        expect(existsSync(baseline.roots.left)).toBe(true)
        expect(existsSync(baseline.roots.right)).toBe(true)
        expect(storage.scoped('principal').treeArchive.read('pair', 'left')).toBeUndefined()
        return
      }
      const endpoint = new LocalEndpoint({ principalId: 'principal', clock: Date.now })
      endpoint.conn.initialized = true
      registerComparisonRetirementRPC(endpoint, service)
      const reply = (await endpoint.handle({
        jsonrpc: '2.0',
        id: 1,
        method: '_agnes/v1/comparison.release',
        params: { id: input.id, expectedRevision: input.expectedRevision },
      })) as JsonRpcResponse
      expect(reply).toMatchObject({
        result: { id: 'pair', storageState: 'released', kind: 'failed-preparation' },
      })
      expect('error' in reply).toBe(false)
      const released = await storage.scoped('principal').read('pair')
      if (!released) throw new Error('Missing released failed preparation')
      expect(released).toMatchObject({
        creation: 'failed',
        error: record.error,
        retirement: { state: 'released', epoch: 2 },
      })
      expect(closes).toBe(2)
      expect(existsSync(baseline.roots.left)).toBe(false)
      expect(existsSync(baseline.roots.right)).toBe(false)
      expect(storage.scoped('principal').treeArchive.read('pair', 'right')?.members).toHaveLength(1)
      expect(await service.release(input)).toEqual(released)
      expect(
        (await service.remove({ ...input, expectedRevision: released.revision })).retirement?.state,
      ).toBe('removed')
      expect(existsSync(join(source, 'keep.txt'))).toBe(true)
      return
    }
    const unavailable = createComparisonRetirementService(options)
    await expect(
      unavailable.release({ principal: 'foreign', id: 'pair', expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'COMPARISON_NOT_FOUND' })
    await expect(
      unavailable.release({ principal: 'principal', id: 'pair', expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'COMPARISON_REVISION_CONFLICT' })
    await expect(
      unavailable.release({ principal: 'principal', id: 'pair', expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'COMPARISON_RETIREMENT_UNAVAILABLE' })
    expect(closes).toBe(0)
    expect((await storage.scoped('principal').read('pair'))?.retirement).toBeUndefined()
    let busy = true
    const realGate = comparisonIdleGate({ ledger, local: host.sessionIdleGates })
    const service = createComparisonRetirementService({
      ...options,
      backend: {
        ledger,
        idleGate: {
          async acquire(input) {
            if (busy) throw new Error('test gate busy')
            return realGate.acquire(input)
          },
        },
      },
    })
    await expect(
      service.release({ principal: 'principal', id: 'pair', expectedRevision: 0 }),
    ).rejects.toThrow('test gate busy')
    expect((await ledger.inspectSessionTree('left')).sealed).toBeUndefined()
    busy = false
    const conflicted = createComparisonRetirementService({
      ...options,
      storage: {
        ...storage,
        scoped(principal) {
          const scoped = storage.scoped(principal)
          return { ...scoped, compareAndSwap: async () => false }
        },
      },
      backend: {
        ledger,
        idleGate: {
          async acquire() {
            return { async check() {}, async release() {} }
          },
        },
      },
    })
    await expect(
      conflicted.release({ principal: 'principal', id: 'pair', expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'COMPARISON_REVISION_CONFLICT' })
    expect(closes).toBe(0)
    expect((await ledger.inspectSessionTree('left')).sealed).toBeUndefined()
    const lostAck = createComparisonRetirementService({
      ...options,
      storage: {
        ...storage,
        scoped(principal) {
          const scoped = storage.scoped(principal)
          return {
            ...scoped,
            async compareAndSwap(id, expected, next) {
              const committed = await scoped.compareAndSwap(id, expected, next)
              if (committed) throw new Error('lost CAS acknowledgement')
              return committed
            },
          }
        },
      },
      backend: {
        ledger,
        idleGate: {
          async acquire() {
            return { async check() {}, async release() {} }
          },
        },
      },
    })
    if (mode === 'lost acknowledgement') {
      await expect(
        lostAck.release({ principal: 'principal', id: 'pair', expectedRevision: 0 }),
      ).rejects.toThrow('lost CAS acknowledgement')
      expect(closes).toBe(0)
      expect((await ledger.inspectSessionTree('left')).sealed).toBeUndefined()
      expect(() => ledger.assertSessionAdmittedTree('left')).toThrow()
      expect((await storage.scoped('principal').read('pair'))?.retirement?.state).toBe('releasing')
      // A committed index CAS is not an idle gate. Retry must still refuse while the runtime
      // producer cannot pin every owner, and it must not publish either Core seal or close.
      busy = true
      await expect(
        service.release({ principal: 'principal', id: 'pair', expectedRevision: 1 }),
      ).rejects.toThrow('test gate busy')
      expect(closes).toBe(0)
      expect((await ledger.inspectSessionTree('left')).idleSealed).toBeUndefined()
      expect((await ledger.inspectSessionTree('right')).idleSealed).toBeUndefined()
      busy = false
    }
    const released = await service.release({
      principal: 'principal',
      id: 'pair',
      expectedRevision: mode === 'normal' ? 0 : 1,
    })
    expect(released.retirement?.state).toBe('released')
    expect(
      (await service.release({ principal: 'principal', id: 'pair', expectedRevision: 0 })).retirement?.state,
    ).toBe('released')
    expect(closes).toBe(2)
    expect(existsSync(baseline.roots.left)).toBe(false)
    expect(existsSync(join(source, 'keep.txt'))).toBe(true)
    expect(storage.scoped('principal').treeArchive.read('pair', 'left')?.members).toHaveLength(1)
    expect(
      await service.release({ principal: 'principal', id: 'pair', expectedRevision: released.revision }),
    ).toEqual(released)
    const refused = await service.prune({
      principal: 'principal',
      operation: 'remove',
      items: [{ id: 'pair', expectedRevision: 0 }],
    })
    expect(refused).toEqual([{ id: 'pair', error: 'COMPARISON_REVISION_CONFLICT' }])
    const removed = await service.prune({
      principal: 'principal',
      operation: 'remove',
      items: [{ id: 'pair', expectedRevision: released.revision }],
    })
    expect(removed[0]?.record?.retirement?.state).toBe('removed')
    expect((await storage.scoped('principal').list()).items).toEqual([])
    expect(closes).toBe(2)
    // Lost replies can be confirmed using the old revision only at the requested terminal state.
    const removedAgain = await service.remove({ principal: 'principal', id: 'pair', expectedRevision: 0 })
    expect(removedAgain.retirement?.state).toBe('removed')
    await expect(
      service.release({ principal: 'principal', id: 'pair', expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'COMPARISON_REVISION_CONFLICT' })
    let finishRead: () => void = () => undefined
    const blockedRead = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    const drainingService = createComparisonRetirementService({
      ...options,
      storage: {
        ...storage,
        scoped(principal) {
          const scoped = storage.scoped(principal)
          return {
            ...scoped,
            async read(id) {
              await blockedRead
              return scoped.read(id)
            },
          }
        },
      },
    })
    const inFlight = drainingService.remove({ principal: 'principal', id: 'pair', expectedRevision: 0 })
    const drained = drainingService.drain()
    let finished = false
    void drained.then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    finishRead()
    await inFlight
    await drained
    await expect(
      drainingService.remove({ principal: 'principal', id: 'pair', expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'COMPARISON_RETIREMENT_CLOSED' })
  } finally {
    await queue.close()
    await host.close()
    await ledger.close()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('pins internal descendants through their root, raw reopened children separately, and retires changed channels', async () => {
  const tree: SessionTreeInspection = {
    rootSessionKey: 'root',
    members: ['root', 'internal', 'raw', 'closed'].map((sessionKey) => ({
      sessionKey,
      parentKey: sessionKey === 'root' ? null : 'root',
      kind: sessionKey === 'root' ? 'root' : 'delegated',
    })),
    ownerEvidence: ['root', 'internal', 'raw', 'closed'].map((sessionKey) => ({
      sessionKey,
      evidence: {
        owner: { sessionKey, writerRunId: `writer:${sessionKey}`, ownerEpoch: 1 },
        ...(sessionKey === 'closed' ? { closed: { finalSeq: 9 } } : {}),
      },
    })),
    writerClaims: [],
    openTurns: [],
    externalHistoryDependents: [],
  }
  const acquired: string[][] = [],
    released: string[] = []
  const channel = (id: string) => ({
    async acquireIdleGate(members: readonly { sessionKey: string }[]) {
      acquired.push(members.map((member) => member.sessionKey))
      return {
        async check() {},
        async release() {
          released.push(id)
        },
      }
    },
  })
  const root = channel('root'),
    raw = channel('raw')
  const channels = new Map([
    ['root', root],
    ['raw', raw],
  ])
  const adapter = comparisonIdleGate({
    ledger: {
      readSessionOwnerEvidence: (key) => tree.ownerEvidence.find((row) => row.sessionKey === key)?.evidence,
      inspectSessionTree: async () => structuredClone(tree),
    },
    remote: (key) => channels.get(key),
  })
  const input = { roots: ['root'], trees: [tree], signal: new AbortController().signal }
  const gate = await adapter.acquire(input)
  expect(acquired).toEqual([['raw'], ['root', 'internal']])
  await gate.check()
  channels.set('raw', channel('replacement'))
  await expect(gate.check()).rejects.toMatchObject({ code: 'COMPARISON_IDLE_OWNER_CHANGED' })
  await gate.release()
  expect(released.sort()).toEqual(['raw', 'root'])
  channels.clear()
  await expect(adapter.acquire(input)).rejects.toMatchObject({ code: 'COMPARISON_IDLE_OWNER_CHANGED' })
  expect(acquired).toHaveLength(2)
})
