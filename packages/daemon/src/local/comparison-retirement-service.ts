import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  type ComparisonRetirementPorts,
  createComparisonRetirement,
  createComparisonWorkspaces,
  type SessionOwnerIdentity,
  type SessionTreeInspection,
} from '@agnes/host'
import type { ComparisonRecord } from '@agnes/runtime-comparison'
import type { Registry } from '../registry.js'
import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'
import { type CommandQueue, withSessionQueues } from './command-queue.js'
import type { ComparisonStorage } from './methods/comparison.js'

export class ComparisonRetirementError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ComparisonRetirementError'
  }
}
const fail = (code: string): never => {
  throw new ComparisonRetirementError(code)
}
export interface ComparisonRetirementRequest {
  /** Server-authenticated identity, never copied from public request payloads. */
  principal: string
  id: string
  expectedRevision: number
}
/** Producer must pin exact runtime/configuration owners AND in-flight child allocation.
 * This is not a daemon command-queue lock and must never cancel work to obtain idle state. */
export interface ComparisonRetirementIdleGate {
  acquire(input: {
    roots: readonly string[]
    trees: readonly SessionTreeInspection[]
    signal: AbortSignal
  }): Promise<{
    check(): Promise<void>
    release(): Promise<void>
  }>
}
export interface ComparisonRetirementBackend {
  ledger: ComparisonRetirementPorts['ledger'] & {
    readSessionOwnerEvidence(
      sessionKey: string,
    ): { owner: SessionOwnerIdentity; closed?: { finalSeq: number } } | undefined
  }
  idleGate?: ComparisonRetirementIdleGate
  /** Shared workspaces need no Git cleanup. Worktree retirement requires a trusted maintenance
   * capability and exact persisted cleanup receipts; omission deliberately refuses those trees.
   * A closed session, a cwd or a registry close receipt grants no filesystem deletion authority. */
  cleanupChildWorkspaces?: ComparisonRetirementPorts['cleanupChildWorkspaces']
}
export interface ComparisonRetirementService {
  /** Stop new work and await admitted cleanup before either underlying database closes. */
  drain(): Promise<void>
  release(input: ComparisonRetirementRequest, signal?: AbortSignal): Promise<ComparisonRecord>
  remove(input: ComparisonRetirementRequest, signal?: AbortSignal): Promise<ComparisonRecord>
  /** Explicit bounded selection. Never discovers and deletes all comparisons implicitly. */
  prune(
    input: {
      principal: string
      operation: 'release' | 'remove'
      items: readonly { id: string; expectedRevision: number }[]
    },
    signal?: AbortSignal,
  ): Promise<Array<{ id: string; record?: ComparisonRecord; error?: string }>>
}

/** Production composition shared by local and supervisor endpoints. No session opens or runs. */
export function createComparisonRetirementService(options: {
  storage: ComparisonStorage
  backend: ComparisonRetirementBackend
  queue: CommandQueue
  ownership: Pick<SessionPrincipalOwnership, 'resolve'>
  registry: Pick<Registry<{ session: { writerRunId: string } }>, 'get' | 'closeAndConfirm'>
  dataDir: string
}): ComparisonRetirementService {
  const { storage, backend, queue, ownership, registry } = options
  const signalOf = (signal?: AbortSignal) => signal ?? new AbortController().signal
  const owned = async (
    input: ComparisonRetirementRequest,
    terminal: 'released' | 'removed',
  ): Promise<ComparisonRecord> => {
    if (
      !input.principal ||
      !input.id ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      fail('COMPARISON_INVALID_ARGUMENT')
    const record = await storage.scoped(input.principal).read(input.id)
    if (!record) return fail('COMPARISON_NOT_FOUND')
    if (
      record.revision !== input.expectedRevision &&
      !(record.retirement?.state === terminal && input.expectedRevision <= record.revision)
    )
      fail('COMPARISON_REVISION_CONFLICT')
    for (const lane of Object.values(record.lanes))
      if (lane && ownership.resolve(lane.sessionId)?.principalId !== input.principal)
        fail('COMPARISON_OWNER_DENIED')
    return record
  }
  const closeExact = async (principal: string, owner: SessionOwnerIdentity) => {
    const bound = ownership.resolve(owner.sessionKey)
    if (bound && bound.principalId !== principal) fail('COMPARISON_OWNER_DENIED')

    const evidence =
      backend.ledger.readSessionOwnerEvidence(owner.sessionKey) ?? fail('COMPARISON_OWNER_UNKNOWN')
    if (
      evidence.owner.sessionKey !== owner.sessionKey ||
      evidence.owner.writerRunId !== owner.writerRunId ||
      evidence.owner.ownerEpoch !== owner.ownerEpoch
    )
      fail('COMPARISON_OWNER_CHANGED')
    if (evidence.closed) return
    const close = registry.closeAndConfirm?.bind(registry) ?? fail('COMPARISON_OWNER_UNKNOWN')
    const result = await close(owner.sessionKey, {
      expectedWriterRunId: owner.writerRunId,
      expectedOwnerEpoch: owner.ownerEpoch,
    })
    // This transport proof only confirms which registry owner was asked. The driver separately
    // aggregates the durable owner epoch/head receipts for every delegated member.
    if (
      !result.exited ||
      result.owner.writerRunId !== owner.writerRunId ||
      result.owner.sessionKey !== owner.sessionKey
    )
      fail('COMPARISON_CLOSE_UNCONFIRMED')
  }
  const driverFor = (principal: string) =>
    createComparisonRetirement({
      store: storage.scoped(principal),
      ledger: backend.ledger,
      closeOwner: (owner) => closeExact(principal, owner),
      closeDetachedOwner: (owner) => closeExact(principal, owner),
      ...(backend.cleanupChildWorkspaces ? { cleanupChildWorkspaces: backend.cleanupChildWorkspaces } : {}),
      async releaseSnapshots({ id }) {
        const physicalId = createHash('sha256').update(`${principal}\0${id}`).digest('hex')
        const snapshots = createComparisonWorkspaces({
          directory: join(options.dataDir, 'comparisons', 'workspaces'),
          authorizeRead: async () => fail('COMPARISON_UNEXPECTED_WORKSPACE_READ'),
        })
        await snapshots.release(physicalId)
      },
    })
  const locked = async <T>(
    input: ComparisonRetirementRequest,
    signal: AbortSignal,
    terminal: 'released' | 'removed',
    work: (record: ComparisonRecord) => Promise<T>,
  ) => {
    const initial = await owned(input, terminal)
    const roots = Object.values(initial.lanes).flatMap((lane) => (lane ? [lane.sessionId] : []))
    const trees = await Promise.all(roots.map((root) => backend.ledger.inspectSessionTree(root)))
    const keys = trees.flatMap((tree) => tree.members.map((member) => member.sessionKey))
    return withSessionQueues(queue, keys, signal, async () => work(await owned(input, terminal)))
  }
  const implementation: Omit<ComparisonRetirementService, 'drain'> = {
    async release(input, signal) {
      const activeSignal = signalOf(signal)
      const initial = await owned(input, 'released')
      if (initial.retirement?.state === 'released') return initial
      if (initial.creation === 'failed' && (!initial.lanes.left || !initial.lanes.right)) {
        const recovered = await driverFor(input.principal).recoverPreparation(input.id)
        return implementation.release({ ...input, expectedRevision: recovered.revision }, activeSignal)
      }
      return locked(input, activeSignal, 'released', async (record) => {
        const driver = driverFor(input.principal)
        if (record.retirement?.state === 'released') return record
        if (
          record.retirement &&
          record.retirement.state !== 'full' &&
          record.retirement.state !== 'releasing'
        )
          return fail('COMPARISON_RETIREMENT_CONFLICT')
        const full = !record.retirement || record.retirement.state === 'full'
        const epoch = full
          ? record.revision + 1
          : (record.retirement?.epoch ?? fail('COMPARISON_RETIREMENT_CONFLICT'))
        const existing = full
          ? []
          : await Promise.all(
              (['left', 'right'] as const).map(async (side) => {
                const tree = await backend.ledger.inspectSessionTree(
                  record.lanes[side]?.sessionId ?? fail('COMPARISON_NOT_READY'),
                )
                if (
                  tree.sealed &&
                  (tree.sealed.retirementId !== `comparison:${input.id}:${side}` ||
                    tree.sealed.epoch !== epoch)
                )
                  fail('COMPARISON_RETIREMENT_CONFLICT')
                return tree
              }),
            )
        if (full || !existing.every((tree) => tree.idleSealed)) {
          const ready = await driver.readiness(input.id)
          const gate = backend.idleGate ?? fail('COMPARISON_RETIREMENT_UNAVAILABLE')
          const lease = await gate.acquire({
            roots: ready.trees.map((tree) => tree.rootSessionKey),
            trees: ready.trees,
            signal: activeSignal,
          })
          try {
            await lease.check()
            await owned(input, 'released')
            await driver.readiness(input.id)
            activeSignal.throwIfAborted()
            const next: ComparisonRecord = full
              ? {
                  ...record,
                  revision: record.revision + 1,
                  retirement: { state: 'releasing', epoch },
                }
              : record
            if (
              full &&
              !(await storage.scoped(input.principal).compareAndSwap(input.id, record.revision, next))
            )
              fail('COMPARISON_REVISION_CONFLICT')
            // Same epoch is retried after a crash. Never close any owner after a failed CAS.
            await backend.ledger.sealIdleSessionTrees(
              (['left', 'right'] as const).map((side) => ({
                rootSessionKey: next.lanes[side]?.sessionId ?? fail('COMPARISON_NOT_READY'),
                retirementId: `comparison:${input.id}:${side}`,
                epoch,
                expectedOwners: (
                  ready.trees.find((tree) => tree.rootSessionKey === next.lanes[side]?.sessionId) ??
                  fail('COMPARISON_NOT_READY')
                ).ownerEvidence.map((row) => row.evidence ?? fail('COMPARISON_OWNER_UNKNOWN')),
              })),
            )
          } finally {
            await lease.release()
          }
        }
        return driver.release(input.id)
      })
    },
    async remove(input, signal) {
      return locked(input, signalOf(signal), 'removed', async (record) => {
        if (record.retirement?.state === 'removed') return record
        if (!['released', 'removing'].includes(record.retirement?.state ?? ''))
          return fail('COMPARISON_NOT_RELEASED')
        return driverFor(input.principal).remove(input.id)
      })
    },
    async prune(input, signal) {
      if (
        !['release', 'remove'].includes(input.operation) ||
        input.items.length > 100 ||
        new Set(input.items.map((item) => item.id)).size !== input.items.length
      )
        return fail('COMPARISON_INVALID_ARGUMENT')
      const results: Array<{ id: string; record?: ComparisonRecord; error?: string }> = []
      for (const item of input.items) {
        signal?.throwIfAborted()
        try {
          results.push({
            id: item.id,
            record: await service[input.operation]({ ...item, principal: input.principal }, signal),
          })
        } catch (error) {
          results.push({
            id: item.id,
            error: error instanceof ComparisonRetirementError ? error.code : 'COMPARISON_RETIREMENT_FAILED',
          })
        }
      }
      return results
    },
  }
  let accepting = true
  let draining: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!accepting) return Promise.reject(new ComparisonRetirementError('COMPARISON_RETIREMENT_CLOSED'))
    const promise = Promise.resolve().then(operation)
    pending.add(promise)
    void promise.finally(() => pending.delete(promise)).catch(() => undefined)
    return promise
  }
  const service: ComparisonRetirementService = {
    release: (input, signal) => track(() => implementation.release(input, signal)),
    remove: (input, signal) => track(() => implementation.remove(input, signal)),
    prune: (input, signal) => track(() => implementation.prune(input, signal)),
    drain() {
      accepting = false
      draining ??= Promise.allSettled([...pending]).then(() => undefined)
      return draining
    },
  }
  return service
}
