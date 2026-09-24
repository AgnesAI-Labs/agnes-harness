import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type ArtifactGcExecutionLease,
  authorizeLinuxArtifactGcExecution,
  authorizeMacOSArtifactGcExecution,
  authorizeWindowsArtifactGcExecution,
  createArtifactGcScheduler,
  executeArtifactGc,
  planRetainedArtifactGc,
  prepareArtifactGcExecutionPrerequisite,
} from '@agnes/core/artifacts'
import {
  deletePrivateArtifactSync,
  nodeArtifactGcPreparationRuntime,
  privateArtifactDeleteAvailable,
} from '@agnes/system-node'
import { createPlatform } from './adapters/platform.js'
import { scanComputerUseArtifactCandidates } from './artifact-gc-candidate-scanner.js'
import { computerUseArtifactRootSnapshot } from './artifact-gc-roots-sqlite.js'
import {
  catchUpArtifactRefIndex,
  catchUpArtifactRefIndexWithinBudget,
  openArtifactRefIndex,
  REF_INDEX_LOCKED_WAIT_MS,
  readIndexedActivity,
  readIndexedRoots,
  verifyRootsUnderLedgerLock,
} from './artifact-ref-index.js'
import {
  planRetentionProtection,
  readLastReferencedAt,
  recomputeRetentionProtectionLocked,
} from './artifact-retention-protection.js'
import { withComputerUseArtifactMutation, writeComputerUseTombstoneLocked } from './private-artifact-store.js'
import type { ResolvedComputerUseProfile } from './profile/types.js'

export type ComputerUseArtifactGcRun = Readonly<{
  batches: number
  deleted: number
  deletedBytes: number
  remainingBytes: number
  unresolvedPressureBytes: number
}>

export type ComputerUseArtifactGcRuntime = Readonly<{
  trigger(): Promise<ComputerUseArtifactGcRun>
  close(): Promise<void>
}>

/**
 * Longest the ledger write lock may be held before deletion starts. Ledger writers give up after
 * 5 s of busy waiting, and the deletions themselves still follow.
 */
const LOCKED_PROOF_LIMIT_MS = 2_000

function sameSnapshot(
  left: Readonly<{ epoch: string; hash: string }>,
  right: Readonly<{ epoch: string; hash: string }>,
): boolean {
  return left.epoch === right.epoch && left.hash === right.hash
}

/** Production collector for write-time-classified Computer Use screenshots only. */
export function createComputerUseArtifactGcRuntime(
  input: Readonly<{
    dataDir: string
    retention: ResolvedComputerUseProfile['retention']
    clock?: () => number
    onError?: (error: unknown) => void
    /** Once per round while referenced or protected bytes keep the store above its cap. */
    onPressure?: (pressure: Readonly<{ remainingBytes: number; unresolvedPressureBytes: number }>) => void
  }>,
): ComputerUseArtifactGcRuntime {
  const platform = createPlatform().os
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux')
    throw new Error('Computer Use artifact GC native deletion is unavailable on this platform')
  if (!privateArtifactDeleteAvailable())
    throw new Error('Computer Use artifact GC native deletion capability is unavailable')
  const clock = input.clock ?? Date.now

  const abort = new AbortController()
  const ledgerFile = join(input.dataDir, 'sessions.db')
  // A deferred batch deletes nothing, so everything above the cap is still pressure.
  const deferred = (storedBytes: number) =>
    Object.freeze({
      deleted: 0,
      deletedBytes: 0,
      remainingBytes: storedBytes,
      unresolvedPressureBytes: Math.max(0, storedBytes - input.retention.globalMaxBytes),
    })

  // `refs` is absent only when no ledger database exists; then only an empty store is collectable.
  const runBatch = async (refs?: Readonly<{ ledger: DatabaseSync; index: DatabaseSync }>) =>
    withComputerUseArtifactMutation(input.dataDir, async () => {
      const nowMs = clock()
      // A republished screenshot's age can come from its file time, which may run ahead of `clock`.
      const candidates = (await scanComputerUseArtifactCandidates(input.dataDir)).map((candidate) =>
        candidate.createdAtMs > nowMs ? { ...candidate, createdAtMs: nowMs } : candidate,
      )
      const candidateDigests = new Set(candidates.map((candidate) => candidate.sha256))
      const storedBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0)
      if (refs && !(await catchUpArtifactRefIndexWithinBudget(refs))) return deferred(storedBytes)
      const settings = {
        nowMs,
        ttlMs: input.retention.ttlMs,
        maxRecent: input.retention.maxRecentPerSession,
      }
      const indexed = refs ? await readIndexedRoots(refs.index, candidateDigests) : undefined
      const protection = refs
        ? await planRetentionProtection({
            ...refs,
            activity: await readIndexedActivity(refs.index),
            candidates: candidateDigests,
            settings,
          })
        : undefined
      const roots = await computerUseArtifactRootSnapshot({
        candidateDigests,
        ...(indexed ? { roots: indexed, retention: protection?.digests ?? new Set() } : {}),
      })
      const selected = planRetainedArtifactGc({
        dataDir: input.dataDir,
        candidates,
        roots: roots.roots,
        nowMs,
        ttlMs: input.retention.ttlMs,
        maxExtendedTtlMs: input.retention.maxExtendedTtlMs,
        globalMaxBytes: input.retention.globalMaxBytes,
        capacityGraceMs: input.retention.gcIntervalMs,
        maxDeletes: 64,
        maxDeleteBytes: 32 * 1024 * 1024,
        lastReferencedAtMs: refs ? await readLastReferencedAt(refs.index, candidateDigests) : new Map(),
      })
      if (selected.plan.blocked || selected.executionPlan.blocked)
        throw new Error(
          `Computer Use artifact GC is blocked: ${[...selected.plan.issues, ...selected.executionPlan.issues].join('; ')}`,
        )
      const outcome = (deleted: number, deletedBytes: number) =>
        Object.freeze({
          deleted,
          deletedBytes,
          remainingBytes: selected.remainingBytes,
          unresolvedPressureBytes: selected.unresolvedPressureBytes,
        })
      if (selected.executionPlan.eligibleForDeletion.length === 0 || abort.signal.aborted)
        return outcome(0, 0)
      const prerequisite = prepareArtifactGcExecutionPrerequisite(
        {
          dataDir: input.dataDir,
          plan: selected.executionPlan,
          reachabilitySnapshot: roots.identity,
        },
        nodeArtifactGcPreparationRuntime,
      )
      const permit =
        platform === 'win32'
          ? authorizeWindowsArtifactGcExecution(prerequisite, true)
          : platform === 'darwin'
            ? authorizeMacOSArtifactGcExecution(prerequisite, true)
            : authorizeLinuxArtifactGcExecution(prerequisite, true)
      const deleting = new Set(selected.executionPlan.eligibleForDeletion.map((entry) => entry.sha256))
      // Referenced bytes get their tombstone before the ledger lock, so the lock is not held for
      // these writes. A batch abandoned under the lock leaves tombstone plus bytes, and readers
      // answer from the bytes.
      for (const candidate of candidates)
        if (
          deleting.has(candidate.sha256) &&
          (indexed?.ledger.has(candidate.sha256) || indexed?.requestMedia.has(candidate.sha256))
        )
          await writeComputerUseTombstoneLocked(input.dataDir, platform, {
            sha256: candidate.sha256,
            size: candidate.bytes,
            createdAtMs: candidate.createdAtMs,
            collectedAtMs: nowMs,
          })
      const lease: ArtifactGcExecutionLease = {
        async withCurrentSnapshot(expected, run) {
          if (!refs || !protection) {
            const current = await computerUseArtifactRootSnapshot({ candidateDigests })
            if (!sameSnapshot(expected, current.identity))
              throw new Error('Computer Use artifact GC reachability snapshot changed')
            return run()
          }
          const database = new DatabaseSync(ledgerFile)
          database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE')
          const locked = performance.now()
          // Every index wait under the ledger lock shares one budget.
          const waitMs = () => Math.max(0, locked + REF_INDEX_LOCKED_WAIT_MS - performance.now())
          try {
            // Under the ledger write lock: the indexed prefix of every live session is proven by its
            // anchor and every later row is extracted here, so the roots cover the whole ledger.
            const verified = await verifyRootsUnderLedgerLock({
              ledger: database,
              index: refs.index,
              candidates: candidateDigests,
              waitMs: waitMs(),
            })
            if (!verified)
              throw new Error('Computer Use artifact GC reachability proof under lock was declined')
            // Activity is judged at the planning time, so only real changes move the protected set.
            const now = await recomputeRetentionProtectionLocked({
              ledger: database,
              index: refs.index,
              activity: verified.activity,
              candidates: candidateDigests,
              settings,
              planned: protection,
              waitMs: waitMs(),
            })
            if (!now) throw new Error('Computer Use artifact GC ancestor boundary changed')
            // Protection that moved without touching this batch's deletions does not stop it.
            const retention = [...now.digests].some((digest) => deleting.has(digest))
              ? now.digests
              : protection.digests
            const current = await computerUseArtifactRootSnapshot({
              candidateDigests,
              roots: verified,
              retention,
            })
            if (!sameSnapshot(expected, current.identity))
              throw new Error('Computer Use artifact GC reachability snapshot changed')
            if (performance.now() - locked > LOCKED_PROOF_LIMIT_MS)
              throw new Error('Computer Use artifact GC proof under lock took too long')
            const result = await run()
            database.exec('COMMIT')
            return result
          } catch (error) {
            try {
              database.exec('ROLLBACK')
            } catch {
              // Preserve the collection/deletion failure.
            }
            throw error
          } finally {
            database.close()
          }
        },
      }
      const execution = await executeArtifactGc(permit, lease, deletePrivateArtifactSync, (dataDir) =>
        join(dataDir, 'artifacts', 'sha256'),
      )
      return outcome(
        execution.deleted.length,
        execution.deleted.reduce((sum, row) => sum + row.bytes, 0),
      )
    })

  const collect = async (refs?: Readonly<{ ledger: DatabaseSync; index: DatabaseSync }>) => {
    let batches = 0
    let deleted = 0
    let deletedBytes = 0
    let remainingBytes = 0
    let unresolvedPressureBytes = 0
    let lastDeleted = 0
    while (batches < 256) {
      const batch = await runBatch(refs)
      batches += 1
      deleted += batch.deleted
      deletedBytes += batch.deletedBytes
      remainingBytes = batch.remainingBytes
      unresolvedPressureBytes = batch.unresolvedPressureBytes
      lastDeleted = batch.deleted
      if (batch.deleted === 0 || abort.signal.aborted) break
    }
    // Only a round whose last batch had nothing left to delete has seen the settled store; one cut
    // short by close() or the batch ceiling says nothing about remaining pressure.
    const settled = batches > 0 && lastDeleted === 0
    return {
      run: Object.freeze({ batches, deleted, deletedBytes, remainingBytes, unresolvedPressureBytes }),
      settled,
    }
  }

  // Opened once and kept for the runtime's life, so its integrity check runs once per open; any
  // failed round drops it and the next round reopens and re-checks.
  let index: DatabaseSync | undefined
  const dropIndex = () => {
    index?.close()
    index = undefined
  }
  const collectRound = async (): Promise<ReturnType<typeof collect> | undefined> => {
    if (!existsSync(ledgerFile)) return collect()
    index ??= await openArtifactRefIndex(input.dataDir)
    const ledger = new DatabaseSync(ledgerFile, { readOnly: true })
    try {
      // Unlocked catch-up; an unfinished backfill neither plans nor deletes this round.
      if ((await catchUpArtifactRefIndex({ ledger, index, signal: abort.signal })) === 'aborted')
        return undefined
      return await collect({ ledger, index })
    } finally {
      ledger.close()
    }
  }
  const perform = async (): Promise<ComputerUseArtifactGcRun> => {
    let round: Awaited<ReturnType<typeof collect>> | undefined
    try {
      round = await collectRound()
    } catch (error) {
      dropIndex()
      throw error
    }
    if (!round)
      return Object.freeze({
        batches: 0,
        deleted: 0,
        deletedBytes: 0,
        remainingBytes: 0,
        unresolvedPressureBytes: 0,
      })
    const result = round.run
    if (round.settled && result.unresolvedPressureBytes > 0)
      try {
        input.onPressure?.({
          remainingBytes: result.remainingBytes,
          unresolvedPressureBytes: result.unresolvedPressureBytes,
        })
      } catch {
        // A diagnostic callback must not fail the collection round.
      }
    return result
  }
  let pending: Promise<ComputerUseArtifactGcRun> | undefined
  let closed = false
  let closeTask: Promise<void> | undefined
  const run = (): Promise<ComputerUseArtifactGcRun> => {
    pending ??= perform().finally(() => {
      pending = undefined
    })
    return pending
  }
  const trigger = (): Promise<ComputerUseArtifactGcRun> => {
    if (closed) return Promise.reject(new Error('Computer Use artifact GC runtime is closed'))
    return run()
  }
  const scheduler = createArtifactGcScheduler(async () => void (await run()), {
    intervalMs: input.retention.gcIntervalMs,
    ...(input.onError ? { onError: input.onError } : {}),
  })
  const close = (): Promise<void> => {
    if (closeTask) return closeTask
    closed = true
    const running = pending
    abort.abort()
    closeTask = (async () => {
      await scheduler.close()
      await Promise.allSettled(running ? [running] : [])
      dropIndex()
    })()
    return closeTask
  }
  return Object.freeze({ trigger, close })
}
