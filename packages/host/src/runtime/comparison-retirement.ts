import { canonicalJson, type IntegrityRow } from '@agnes/core'
import type { ComparisonRecord, Side, WorkspaceBaseline } from '@agnes/runtime-comparison'
import type { SessionOwnerIdentity } from '../adapters/session-owner-evidence.js'
import type { ClosedSessionTree } from '../adapters/session-retirement-proof.js'
import type { SessionTreeInspection } from '../adapters/session-retirement-sqlite.js'
import type { SqliteStorage } from '../adapters/storage-sqlite.js'
import { ComparisonJournalError } from './comparison-journal-types.js'
import type { ScopedComparisonStore } from './comparison-store.js'

const SIDES = ['left', 'right'] as const
function fail(code: string, message: string): never {
  throw new ComparisonJournalError(code, message)
}
function required<T>(value: T | undefined): T {
  if (value === undefined) fail('COMPARISON_RETIREMENT_INVALID', 'Required retirement evidence is missing')
  return value
}
export interface ComparisonRetirementPorts {
  store: ScopedComparisonStore
  ledger: Pick<
    SqliteStorage,
    | 'sealIdleSessionTrees'
    | 'inspectSessionTree'
    | 'confirmSealedSessionTreeClosed'
    | 'registers'
    | 'readSessionOwnerEvidence'
    | 'scanIntegrity'
    | 'purgeSealedSessionTree'
    | 'checkSealedSessionTreePurge'
  >
  /** Close ONLY this acquisition, never load/run/cancel a missing or replacement owner. */
  closeOwner(owner: SessionOwnerIdentity): Promise<void>
  /** Optional exact close for a raw-reopened descendant outside the root runtime ownership. */
  closeDetachedOwner?(owner: SessionOwnerIdentity): Promise<void>
  /** Idempotent existing worktree cleanup. Dirty/unknown worktrees must reject, not force removal. */
  cleanupChildWorkspaces?(trees: readonly ClosedSessionTree[]): Promise<void>
  /** Delete only this comparison's private snapshots, never the source directory. */
  releaseSnapshots(input: { id: string; baseline: WorkspaceBaseline }): Promise<void>
}

/** Private execution half. Public authority/admission must first CAS full -> releasing.
 * The caller MUST hold a joint execution/configuration idle gate while fencing admission.
 * Every retry revalidates durable owner proofs; no close RPC reply substitutes for those proofs. */
export function createComparisonRetirement(ports: ComparisonRetirementPorts) {
  const { store, ledger } = ports
  async function read(id: string): Promise<ComparisonRecord> {
    const record = await store.read(id)
    return record ?? fail('COMPARISON_NOT_FOUND', 'Comparison not found')
  }
  async function assertIdle(tree: SessionTreeInspection): Promise<void> {
    if (tree.ownerEvidence.some((member) => !member.evidence))
      fail('COMPARISON_OWNER_UNKNOWN', 'Member acquisition evidence is missing')
    if (
      tree.externalHistoryDependents.length ||
      tree.openTurns.length ||
      tree.members.some(
        (member) =>
          member.kind === 'delegated' &&
          (!['completed', 'failed', 'cancelled', 'interrupted'].includes(member.state ?? '') ||
            !['committed', 'cancelled'].includes(member.creationPhase ?? '')),
      )
    )
      fail('COMPARISON_BUSY', 'A delegated member is still active or unresolved')
    for (const member of tree.members)
      for (const row of await ledger.registers(member.sessionKey)) {
        if (row.register === 'op.state' && row.data !== null)
          fail('COMPARISON_BUSY', 'An active program counter remains')
        if (
          row.register === 'inbox' &&
          (!Array.isArray((row.data as { items?: unknown } | null)?.items) ||
            (row.data as { items: unknown[] }).items.length > 0)
        )
          fail('COMPARISON_BUSY', 'A pending input remains')
      }
  }
  async function archive(id: string, side: Side, tree: ClosedSessionTree): Promise<void> {
    const { purged: _purged, ...proof } = tree
    let snapshot = store.treeArchive.read(id, side)
    if (snapshot) {
      if (canonicalJson(snapshot.proof) !== canonicalJson(proof))
        fail('COMPARISON_CLOSE_PROOF_CHANGED', 'Archived owner proof differs from the closed tree')
    } else {
      if (tree.purged) fail('HISTORY_UNAVAILABLE', 'Purged tree has no complete archive')
      snapshot = { proof, members: [] }
      let total = 0
      let bytes = 0
      for (const member of proof.members) {
        const rows: IntegrityRow[] = []
        while (rows.length < member.finalSeq) {
          const page = await ledger.scanIntegrity(member.sessionKey, {
            fromSeq: rows.length + 1,
            toSeq: member.finalSeq,
            limit: 500,
          })
          if (!page.length) fail('HISTORY_UNAVAILABLE', 'Closed tree ledger prefix is incomplete')
          for (const row of page) {
            bytes += Buffer.byteLength(JSON.stringify(row))
            if (++total > 100_000 || bytes > 256 * 1024 * 1024)
              fail('HISTORY_LIMIT', 'Complete tree archive exceeds its explicit storage bound')
            if (row.event.seq !== rows.length + 1 || row.event.seq > member.finalSeq)
              fail('HISTORY_UNAVAILABLE', 'Closed tree ledger prefix is unordered')
            rows.push(row)
          }
        }
        snapshot.members.push({ sessionKey: member.sessionKey, rows })
      }
      store.treeArchive.write(id, side, snapshot)
    }
    const root = snapshot.members.find((member) => member.sessionKey === proof.rootSessionKey)
    if (!root) fail('HISTORY_UNAVAILABLE', 'Archive root is missing')
    store.archive.write(id, side, {
      sessionId: proof.rootSessionKey,
      epoch: proof.epoch,
      throughSeq: root.rows.length,
      rows: root.rows,
    })
  }
  return {
    /** Recover allocation facts hidden by a failed prepare reply. This never opens a session,
     * substitutes a missing owner, repairs prepared configuration, or changes failure history. */
    async recoverPreparation(id: string): Promise<ComparisonRecord> {
      const record = await read(id)
      if (record.creation !== 'failed' || (record.lanes.left && record.lanes.right)) return record
      if (!record.baseline)
        fail('COMPARISON_OWNER_UNKNOWN', 'Failed preparation has no proven workspace allocation')
      let request: Partial<Record<Side, { runtime?: unknown }>>
      try {
        request = JSON.parse(record.createPayload) as typeof request
      } catch {
        fail('COMPARISON_OWNER_UNKNOWN', 'Failed preparation request identity is unavailable')
      }
      if (!request || typeof request !== 'object')
        fail('COMPARISON_OWNER_UNKNOWN', 'Failed preparation request identity is unavailable')
      const reserved = store.reservedBindings(id)
      const lanes = { ...record.lanes }
      for (const side of SIDES) {
        if (lanes[side]) continue
        const key =
          reserved[side] ??
          fail('COMPARISON_OWNER_UNKNOWN', 'Failed preparation has no durable session reservation')
        const owner =
          ledger.readSessionOwnerEvidence(key) ??
          fail('COMPARISON_OWNER_UNKNOWN', 'Missing acquisition is not proof of an unused reservation')
        const first = (await ledger.scanIntegrity(key, { fromSeq: 1, toSeq: 1, limit: 1 }))[0]
        const start = first?.event
        const data = start?.data as
          | { key?: unknown; cwd?: unknown; parent?: unknown; runtime?: { id?: unknown; version?: unknown } }
          | undefined
        const runtime = data?.runtime ?? { id: 'native', version: '1' }
        if (
          first?.sessionKey !== key ||
          start?.seq !== 1 ||
          start.type !== 'session/start' ||
          start.origin !== 'system' ||
          start.trust !== 'trusted' ||
          data?.key !== key ||
          data.parent !== undefined ||
          (data.cwd !== undefined && data.cwd !== record.baseline.roots[side]) ||
          owner.owner.sessionKey !== key ||
          typeof runtime.id !== 'string' ||
          !['native', 'jevloop'].includes(runtime.id) ||
          runtime.id !== request[side]?.runtime ||
          typeof runtime.version !== 'string' ||
          !runtime.version
        )
          fail('COMPARISON_OWNER_UNKNOWN', 'Failed preparation allocation identity is unproven')
        lanes[side] = {
          side,
          sessionId: key,
          runtime: { id: runtime.id, version: runtime.version },
          workspaceLabel: record.baseline.labels[side],
          phase: 'recovering',
          lastSeq: start.seq,
        }
      }
      const next = { ...record, lanes, revision: record.revision + 1 }
      if (!(await store.compareAndSwap(id, record.revision, next)))
        fail('COMPARISON_RETIREMENT_CONFLICT', 'Failed preparation recovery revision changed')
      return next
    },
    /** Read-only preflight. Caller must recheck under its joint admission lock before fencing. */
    async readiness(id: string): Promise<{ revision: number; trees: SessionTreeInspection[] }> {
      const record = await read(id)
      if (!record.lanes.left || !record.lanes.right || !record.baseline)
        fail('COMPARISON_NOT_READY', 'Both prepared roots are required')
      if (
        record.rounds.some((round) =>
          SIDES.some((side) => !['settled', 'skipped'].includes(round.runs[side].status)),
        )
      )
        fail('COMPARISON_BUSY', 'Active or unresolved rounds remain')
      const trees = []
      for (const side of SIDES) {
        const tree = await ledger.inspectSessionTree(required(record.lanes[side]).sessionId)
        await assertIdle(tree)
        trees.push(tree)
      }
      return { revision: record.revision, trees }
    },
    async release(id: string): Promise<ComparisonRecord> {
      let record = await read(id)
      if (record.retirement?.state === 'released') return record
      if (record.retirement?.state !== 'releasing')
        fail('COMPARISON_RETIREMENT_REQUIRED', 'Release requires the permanent comparison admission fence')
      if (!record.baseline || !record.lanes.left || !record.lanes.right)
        fail('COMPARISON_NOT_READY', 'Release requires both allocated comparison roots')
      if (
        record.rounds.some((round) =>
          SIDES.some((side) => !['settled', 'skipped'].includes(round.runs[side].status)),
        )
      )
        fail('COMPARISON_BUSY', 'Active or unresolved comparison rounds cannot be released')
      const epoch = record.retirement.epoch
      const identities = SIDES.map((side) => ({
        rootSessionKey: required(record.lanes[side]).sessionId,
        retirementId: `comparison:${id}:${side}`,
        epoch,
      }))
      // The caller must publish BOTH idle seals while holding its runtime gates. A retry must
      // never turn an earlier index CAS into permission to seal an unpinned successor owner.
      const inspections = await Promise.all(
        identities.map((identity) => ledger.inspectSessionTree(identity.rootSessionKey)),
      )
      for (const [index, tree] of inspections.entries()) {
        const identity = required(identities[index])
        if (
          !tree.idleSealed ||
          tree.sealed?.retirementId !== identity.retirementId ||
          tree.sealed.epoch !== identity.epoch
        )
          fail(
            'COMPARISON_IDLE_SEAL_REQUIRED',
            'Both exact runtime idle seals are required before owner closure',
          )
      }
      const alreadyPurged = new Set<string>()
      for (const [index, tree] of inspections.entries()) {
        if (tree.ownerEvidence.every((member) => member.evidence?.closed)) {
          const proof = await ledger.confirmSealedSessionTreeClosed(required(identities[index]))
          if (proof.purged) alreadyPurged.add(tree.rootSessionKey)
        }
      }
      for (const tree of inspections) if (!alreadyPurged.has(tree.rootSessionKey)) await assertIdle(tree)
      for (const tree of inspections) {
        const root = tree.ownerEvidence.find((member) => member.sessionKey === tree.rootSessionKey)?.evidence
        if (!root) fail('COMPARISON_OWNER_UNKNOWN', 'Root acquisition evidence is missing')
        if (!root.closed) await ports.closeOwner(root.owner)
      }
      for (const tree of inspections) {
        const current = await ledger.inspectSessionTree(tree.rootSessionKey)
        for (const member of current.ownerEvidence) {
          if (!member.evidence) fail('COMPARISON_OWNER_UNKNOWN', 'Member acquisition evidence is missing')
          if (!member.evidence.closed && member.sessionKey !== tree.rootSessionKey) {
            if (!ports.closeDetachedOwner)
              fail('COMPARISON_OWNER_UNKNOWN', 'Detached member owner must close explicitly')
            await ports.closeDetachedOwner(member.evidence.owner)
          }
        }
      }
      const trees: ClosedSessionTree[] = []
      for (const identity of identities) trees.push(await ledger.confirmSealedSessionTreeClosed(identity))
      const keys = trees.flatMap((tree) => tree.members.map((member) => member.sessionKey))
      if (new Set(keys).size !== keys.length) fail('COMPARISON_TREE_OVERLAP', 'Comparison trees overlap')
      const cuts = Object.fromEntries(
        SIDES.map((side, i) => [
          side,
          required(
            required(trees[i]).members.find(
              (member) => member.sessionKey === required(identities[i]).rootSessionKey,
            ),
          ).finalSeq,
        ]),
      ) as Record<Side, number>
      const published = await store.journal.head(id)
      if (!published || SIDES.some((side) => published.cuts[side] !== cuts[side]))
        await store.journal.checkpoint(id, { reason: published ? 'recovery' : 'legacy', cuts })
      for (const [index, side] of SIDES.entries()) await archive(id, side, required(trees[index]))
      // Check both sides before any resource deletion, including unresolved accounting.
      for (const tree of trees)
        await ledger.checkSealedSessionTreePurge(
          { ...tree, accounting: 'retain-verified-ended' },
          { beforeWorkspaceCleanup: true },
        )
      await ports.cleanupChildWorkspaces?.(trees.filter((tree) => !tree.purged))
      for (const tree of trees)
        await ledger.checkSealedSessionTreePurge({ ...tree, accounting: 'retain-verified-ended' })
      for (const tree of trees)
        await ledger.purgeSealedSessionTree({
          ...tree,
          accounting: 'retain-verified-ended',
          members: tree.members.map(({ sessionKey, finalSeq }) => ({ sessionKey, finalSeq })),
        })
      await ports.releaseSnapshots({ id, baseline: record.baseline })
      for (let attempt = 0; attempt < 8; attempt++) {
        record = await read(id)
        if (record.retirement?.state === 'released') return record
        if (
          record.retirement?.state !== 'releasing' ||
          record.retirement.epoch !== required(identities[0]).epoch
        )
          fail('COMPARISON_RETIREMENT_CONFLICT', 'Comparison retirement changed')
        const next: ComparisonRecord = {
          ...record,
          revision: record.revision + 1,
          retirement: { ...record.retirement, state: 'released' },
          cleanup: { exited: ['left', 'right'], released: true },
        }
        if (await store.compareAndSwap(id, record.revision, next)) return next
      }
      return fail('COMPARISON_RETIREMENT_CONFLICT', 'Comparison retirement revision changed')
    },
    async remove(id: string): Promise<ComparisonRecord> {
      for (let attempt = 0; attempt < 8; attempt++) {
        const record = await read(id)
        if (record.retirement?.state === 'removed') return record
        if (record.retirement?.state === 'removing') return store.removeRetiredHistory(id, record.revision)
        if (record.retirement?.state !== 'released')
          fail('COMPARISON_RELEASE_REQUIRED', 'Release execution resources before removing retained history')
        const next: ComparisonRecord = {
          ...record,
          revision: record.revision + 1,
          retirement: { ...record.retirement, state: 'removing' },
        }
        if (await store.compareAndSwap(id, record.revision, next))
          return store.removeRetiredHistory(id, next.revision)
      }
      return fail('COMPARISON_RETIREMENT_CONFLICT', 'Comparison removal revision changed')
    },
  }
}
