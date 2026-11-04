import { createHash } from 'node:crypto'
import {
  jcs,
  type ResourceOperation,
  rpcError,
  type SkillDescriptor,
  type SkillRootStatus,
  validateResourceControlData,
} from '@agnes/protocol'
import type { ResourceAuthority } from './permissions.js'
import type { SkillJournal } from './skill-journal.js'
export const terminal = new Set<ResourceOperation['state']>(['succeeded', 'failed', 'cancelled'])
export const hash = (value: unknown) => createHash('sha256').update(jcs(value), 'utf8').digest('hex')
export const rootTarget = (rootKey: string | undefined) =>
  `skill/user/${rootKey ?? 'all'}/${hash(rootKey ?? 'all')}`
export const defaultPriority = (item: SkillDescriptor): number =>
  ({
    'workspace-agnes': 500,
    'user-agnes': 400,
    'user-agents': 300,
    'user-claude': 200,
    'user-codex': 100,
    package: 50,
    runtime: 450,
  })[item.sourceIdentity.rootKey]
export const clone = <T>(value: T): T => structuredClone(value)
export const safeError = (code: string, message: string) => ({ code, message })
export const receipt = (operation: ResourceOperation) => ({
  operationId: operation.operationId,
  state: operation.state,
})

const SKILL_ROOTS = [
  { rootKey: 'workspace-agnes', scope: 'workspace' },
  { rootKey: 'user-agnes', scope: 'user' },
  { rootKey: 'user-agents', scope: 'user' },
  { rootKey: 'user-claude', scope: 'user' },
  { rootKey: 'user-codex', scope: 'user' },
  { rootKey: 'package', scope: 'package' },
] as const

export function deriveRoots(journal: SkillJournal, workspaceId?: string): SkillRootStatus[] {
  const items = projected(journal)
  return SKILL_ROOTS.map(({ rootKey, scope }) => {
    const owned = items.filter((item) => item.sourceIdentity.rootKey === rootKey)
    const state = owned.length === 0 ? 'empty' : owned.every((item) => item.stale) ? 'stale' : 'ready'
    return {
      rootKey,
      scope,
      state,
      ...(rootKey === 'workspace-agnes' && workspaceId ? { workspaceId } : {}),
    }
  })
}

export function projectRoots(journal: SkillJournal, workspaceId?: string): SkillRootStatus[] {
  const persisted = journal.roots ?? []
  if (!persisted.length) return deriveRoots(journal, workspaceId)
  return persisted.filter(
    (root) => root.rootKey !== 'workspace-agnes' || !workspaceId || root.workspaceId === workspaceId,
  )
}

export function mergeRoots(
  previous: readonly SkillRootStatus[],
  incoming: readonly SkillRootStatus[],
  workspaceId?: string,
): SkillRootStatus[] {
  const kept = previous.filter(
    (root) => root.rootKey === 'workspace-agnes' && root.workspaceId && root.workspaceId !== workspaceId,
  )
  return [...kept, ...incoming].sort(
    (left, right) =>
      left.rootKey.localeCompare(right.rootKey) ||
      (left.workspaceId ?? '').localeCompare(right.workspaceId ?? ''),
  )
}

export function deriveIncomingRoots(
  observed: readonly { descriptor: SkillDescriptor }[],
  failedRoots: readonly string[],
  workspaceId?: string,
): SkillRootStatus[] {
  return SKILL_ROOTS.map(({ rootKey, scope }) => {
    const owned = observed.filter((item) => item.descriptor.sourceIdentity.rootKey === rootKey)
    const failed = failedRoots.includes(rootKey)
    const state = failed ? (owned.length ? 'stale' : 'unavailable') : owned.length ? 'ready' : 'empty'
    return {
      rootKey,
      scope,
      state,
      ...(rootKey === 'workspace-agnes' && workspaceId ? { workspaceId } : {}),
    }
  })
}

/** Only a shared name can affect arbitration when desired/trust changes. */
export function skillNameGroup(journal: SkillJournal, resourceId: string): readonly SkillDescriptor[] {
  const source = journal.discovered.find((item) => item.resourceId === resourceId)
  if (!source) return []
  const key = source.name.trim().toLocaleLowerCase('en-US')
  return journal.discovered.filter(
    (item) =>
      item.name.trim().toLocaleLowerCase('en-US') === key &&
      (!source.workspaceId ||
        item.sourceIdentity.scope !== 'workspace' ||
        item.workspaceId === source.workspaceId),
  )
}

export function projected(journal: SkillJournal, sources = journal.discovered): SkillDescriptor[] {
  return sources.map((source) => {
    // Discovery metadata is not an actual observation. In particular a stale discovery diagnostic
    // must never survive as the Host's current runtime error after a later reconcile.
    const { lastSafeError: _discoveryError, ...descriptor } = source
    const trust = journal.trust[source.resourceId]
    const observed = journal.actual[source.resourceId]
    return {
      ...descriptor,
      priority: journal.priorities[source.resourceId] ?? defaultPriority(descriptor),
      trust:
        trust &&
        trust.revision === source.revision &&
        trust.capabilityHash === journal.capability[source.resourceId]
          ? trust.state
          : 'untrusted',
      desired: journal.desired[source.resourceId] ?? 'disabled',
      actual: observed?.state ?? source.actual,
      ...(observed?.lastSafeError ? { lastSafeError: observed.lastSafeError } : {}),
      ...(journal.removed.includes(source.resourceId)
        ? {
            lastSafeError: safeError(
              'SKILL_REMOVAL_PENDING',
              'Permanent deletion has not finished. Re-enabling is blocked. Clear any file lock and retry the delete.',
            ),
          }
        : {}),
    }
  })
}
export const changed = (journal: SkillJournal, patch: Partial<SkillJournal>): SkillJournal => ({
  ...journal,
  ...patch,
})
/** Ignore operation history and root scan bookkeeping when deciding whether workers must reload. */
export const skillRuntimeRevision = (journal: SkillJournal): string =>
  hash({
    skills: projected(journal).sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
    capability: journal.capability,
    priorities: journal.priorities,
    removed: [...journal.removed].sort(),
    desired: journal.desired,
    trust: journal.trust,
  })

export function findCommand(journal: SkillJournal, authority: ResourceAuthority, commandId: string) {
  return journal.operations.find(
    (row) =>
      row.owner.principalId === authority.principalId &&
      row.owner.clientId === authority.clientId &&
      row.command.commandId === commandId,
  )
}
export function replaceOperation(
  journal: SkillJournal,
  id: string,
  mutate: (value: ResourceOperation) => ResourceOperation,
  cancelRequested?: boolean,
): SkillJournal {
  return changed(journal, {
    operations: journal.operations.map((row) =>
      row.operation.operationId === id
        ? {
            ...row,
            operation: mutate(row.operation),
            ...(cancelRequested === undefined ? {} : { cancelRequested }),
          }
        : row,
    ),
  })
}
export function prune(journal: SkillJournal): SkillJournal {
  if (journal.operations.length < 1_000) return journal
  const retained = journal.operations.filter((row) => !terminal.has(row.operation.state))
  if (retained.length >= 900)
    throw rpcError('OVERLOADED', {
      code: 'RESOURCE_OPERATION_LIMIT',
      reason: 'too many non-terminal resource operations',
    })
  // Non-terminal operations are never pruned; the 900 total is met by trimming finished history only.
  const finished = journal.operations
    .filter((row) => terminal.has(row.operation.state))
    .slice(-Math.min(500, 900 - retained.length))
  return changed(journal, { operations: [...retained, ...finished] })
}
export function setState(
  value: ResourceOperation,
  state: ResourceOperation['state'],
  error?: { code: string; message: string },
): ResourceOperation {
  return {
    ...value,
    state,
    updatedAt: new Date().toISOString(),
    progress: terminal.has(state) ? 100 : 50,
    ...(error ? { lastSafeError: error } : {}),
  }
}

export function observeSkills(journal: SkillJournal, values: readonly SkillDescriptor[]) {
  const known = new Set(journal.discovered.map((value) => value.resourceId))
  if (!values.every((value) => known.has(value.resourceId))) throw new Error('worker reported unknown skill')
  const actual = {
    ...journal.actual,
    ...Object.fromEntries(
      values.map((value) => [
        value.resourceId,
        { state: value.actual, ...(value.lastSafeError ? { lastSafeError: value.lastSafeError } : {}) },
      ]),
    ),
  }
  const operations = journal.operations.map((entry) =>
    terminal.has(entry.operation.state) ||
    !['_agnes/v1/resources.desired.set', '_agnes/v1/skills.trust.set'].includes(entry.operation.kind) ||
    !values.some(
      (value) =>
        value.resourceId === entry.operation.target &&
        (value.actual === 'ready' || value.actual === 'disabled'),
    )
      ? entry
      : { ...entry, operation: setState(entry.operation, 'succeeded') },
  )
  return { next: changed(journal, { actual, operations }), result: undefined }
}

export function skillControl(journal: SkillJournal) {
  return {
    priorities: journal.priorities,
    removed: journal.removed,
    desired: Object.entries(journal.desired).map(([resourceId, state]) => ({ resourceId, state })),
    trust: Object.entries(journal.trust).map(([resourceId, decision]) => ({
      resourceId,
      revision: decision.revision,
      capabilityHash: decision.capabilityHash,
      state: decision.state,
    })),
  }
}

export function reconcileSkillObservations(
  journal: SkillJournal,
  resources: readonly SkillDescriptor[],
  observations: readonly import('./adapters.js').SkillActualObservation[],
) {
  const expected = new Set(resources.map((source) => source.resourceId))
  if (
    resources.some(
      (source) =>
        !journal.discovered.some(
          (item) => item.resourceId === source.resourceId && item.revision === source.revision,
        ),
    )
  )
    throw new Error('skill catalog changed during observation')
  const seen = new Set(observations.map((item) => item.resourceId))
  const valid =
    observations.length === seen.size &&
    seen.size === expected.size &&
    [...expected].every((id) => seen.has(id)) &&
    observations.every(
      (item) =>
        expected.has(item.resourceId) &&
        ['unavailable', 'disabled', 'preparing', 'ready', 'degraded'].includes(item.actual) &&
        (!item.lastSafeError || validateResourceControlData('SafeError', item.lastSafeError).ok),
    )
  if (!valid) throw new Error('invalid skill actual observation')
  return {
    next: changed(journal, {
      discovered: journal.discovered.map((item) => {
        const seen = observations.find((value) => value.resourceId === item.resourceId)
        return seen?.resolution ? { ...item, resolution: seen.resolution } : item
      }),
      actual: {
        ...journal.actual,
        ...Object.fromEntries(
          observations.map((item) => [
            item.resourceId,
            {
              state: item.actual,
              ...(item.lastSafeError ? { lastSafeError: item.lastSafeError } : {}),
            },
          ]),
        ),
      },
    }),
    result: undefined,
  }
}
