import { createHash, randomUUID } from 'node:crypto'
import type { ResourceControlMethodName } from '@agnes/protocol'
import {
  jcs,
  type ResourceOperation,
  rpcError,
  type SkillDescriptor,
  type SkillRootStatus,
  type TrustState,
  validateResourceControlData,
} from '@agnes/protocol'
import type { SkillCatalogAdapter } from './adapters.js'
import type { ResourceAuthority } from './permissions.js'
import type { ResourceProfileScope } from './profile-scope.js'
import {
  type ResourceOperationRecord,
  type SkillJournal,
  SkillJournalStore,
  type SkillTrustDecision,
} from './skill-journal.js'

type EffectMethod =
  | '_agnes/v1/skills.remove'
  | '_agnes/v1/skills.priority.set'
  | '_agnes/v1/resources.desired.set'
  | '_agnes/v1/skills.refresh'
  | '_agnes/v1/skills.trust.set'
  | '_agnes/v1/resources.operation.cancel'
const effects = new Set<ResourceControlMethodName>([
  '_agnes/v1/skills.remove',
  '_agnes/v1/skills.priority.set',
  '_agnes/v1/resources.desired.set',
  '_agnes/v1/skills.refresh',
  '_agnes/v1/skills.trust.set',
  '_agnes/v1/resources.operation.cancel',
])
const terminal = new Set<ResourceOperation['state']>(['succeeded', 'failed', 'cancelled'])
const hash = (value: unknown) => createHash('sha256').update(jcs(value), 'utf8').digest('hex')
const rootTarget = (rootKey: string | undefined) => `skill/user/${rootKey ?? 'all'}/${hash(rootKey ?? 'all')}`
const defaultPriority = (item: SkillDescriptor): number =>
  ({
    'workspace-agnes': 500,
    'user-agnes': 400,
    'user-agents': 300,
    'user-claude': 200,
    'user-codex': 100,
    package: 50,
    runtime: 450,
  })[item.sourceIdentity.rootKey]
const clone = <T>(value: T): T => structuredClone(value)
const safeError = (code: string, message: string) => ({ code, message })
const receipt = (operation: ResourceOperation) => ({
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

function deriveRoots(journal: SkillJournal, workspaceId?: string): SkillRootStatus[] {
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

function projectRoots(journal: SkillJournal, workspaceId?: string): SkillRootStatus[] {
  const persisted = journal.roots ?? []
  if (!persisted.length) return deriveRoots(journal, workspaceId)
  return persisted.filter(
    (root) => root.rootKey !== 'workspace-agnes' || !workspaceId || root.workspaceId === workspaceId,
  )
}

function mergeRoots(
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

function deriveIncomingRoots(
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

function projected(journal: SkillJournal): SkillDescriptor[] {
  return journal.discovered.map((source) => {
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
              '永久删除尚未完成；已阻止重新启用，可排除文件占用后重试删除。',
            ),
          }
        : {}),
    }
  })
}
const changed = (journal: SkillJournal, patch: Partial<SkillJournal>): SkillJournal => ({
  ...journal,
  ...patch,
})
function findCommand(journal: SkillJournal, authority: ResourceAuthority, commandId: string) {
  return journal.operations.find(
    (row) =>
      row.owner.principalId === authority.principalId &&
      row.owner.clientId === authority.clientId &&
      row.command.commandId === commandId,
  )
}
function replaceOperation(
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
function prune(journal: SkillJournal): SkillJournal {
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
function setState(
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

/** Daemon-owned desired/trust/operation state. Host adapters are the sole source of discovery and actual observations. */
export class SkillResourceStore {
  private readonly active = new Map<string, AbortController>()
  private deferDrive = false
  constructor(
    private readonly journal: SkillJournalStore,
    private adapter?: SkillCatalogAdapter,
    private readonly resolveWorkspaceId?: (workspaceId?: string) => Promise<string>,
  ) {}
  setAdapter(adapter: SkillCatalogAdapter): void {
    this.adapter = adapter
  }
  /** ResourceControlStore uses this to make snapshot publication the admission barrier. */
  setDeferredDrive(defer: boolean): void {
    this.deferDrive = defer
  }
  async driveOperation(
    profile: string,
    operationId: string,
    beforeTerminal?: () => Promise<void>,
    afterSuccess?: () => void,
  ): Promise<void> {
    await this.drive(profile, operationId, beforeTerminal, afterSuccess)
  }
  async call(
    method: ResourceControlMethodName,
    params: Record<string, unknown>,
    authority: ResourceAuthority,
  ): Promise<unknown> {
    if (method.startsWith('_agnes/v1/mcp.'))
      throw rpcError('CAPABILITY_DENIED', {
        code: 'RESOURCE_METHOD_UNAVAILABLE',
        method,
        reason: 'MCP lifecycle is not installed in this daemon',
      })
    if (method === '_agnes/v1/resources.list') return this.list(params)
    if (method === '_agnes/v1/resources.get') return this.get(params)
    if (method === '_agnes/v1/resources.operation.get') return this.operation(params, authority)
    if (!effects.has(method))
      throw rpcError('CAPABILITY_DENIED', { code: 'RESOURCE_METHOD_UNAVAILABLE', method })
    return this.effect(method as EffectMethod, params, authority)
  }
  async recover(beforeTerminal?: (profile: string) => Promise<void>): Promise<void> {
    for (const profile of await this.journal.profiles()) await this.recoverProfile(profile, beforeTerminal)
  }
  async recoverProfile(profile: string, beforeTerminal?: (profile: string) => Promise<void>): Promise<void> {
    const pending = await this.journal.read(profile, (journal) =>
      journal.operations.filter((row) => !terminal.has(row.operation.state)).map(clone),
    )
    for (const row of pending)
      await this.drive(
        profile,
        row.operation.operationId,
        () => beforeTerminal?.(profile) ?? Promise.resolve(),
      )
  }
  async workerControl(profile: string): Promise<{
    priorities: Readonly<Record<string, number>>
    removed: readonly string[]
    desired: Array<{ resourceId: string; state: 'enabled' | 'disabled' }>
    trust: Array<{ resourceId: string; revision: string; capabilityHash: string; state: TrustState }>
  }> {
    return this.journal.read(profile, (journal) => ({
      priorities: journal.priorities,
      removed: journal.removed,
      desired: Object.entries(journal.desired).map(([resourceId, state]) => ({ resourceId, state })),
      trust: Object.entries(journal.trust).map(([resourceId, decision]) => ({
        resourceId,
        revision: decision.revision,
        capabilityHash: decision.capabilityHash,
        state: decision.state,
      })),
    }))
  }
  async observeWorker(profile: string, values: readonly SkillDescriptor[]): Promise<void> {
    if (!values.every((value) => validateResourceControlData('SkillDescriptor', value).ok))
      throw new Error('invalid worker skill observation')
    await this.journal.transact(profile, (journal) => {
      const known = new Set(journal.discovered.map((value) => value.resourceId))
      if (!values.every((value) => known.has(value.resourceId)))
        throw new Error('worker reported unknown skill')
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
    })
  }
  private async bindWorkspace(workspaceId?: string): Promise<string | undefined> {
    if (!this.resolveWorkspaceId) return workspaceId
    return this.resolveWorkspaceId(workspaceId)
  }
  private async list(params: Record<string, unknown>) {
    const workspaceId = await this.bindWorkspace(params.workspaceId as string | undefined)
    return this.journal.read(params.profile as string, (journal) => {
      const cursor = params.cursor as string | undefined
      const all = projected(journal)
        .filter((item) => !params.kind || item.kind === params.kind)
        .filter((item) => {
          if (!workspaceId || item.sourceIdentity.scope !== 'workspace') return true
          return item.workspaceId === workspaceId
        })
        .sort((a, b) => a.resourceId.localeCompare(b.resourceId))
        .filter((item) => !cursor || item.resourceId > cursor)
      const items = all.slice(0, 100)
      const last = items.at(-1)
      return {
        items,
        ...(all.length > items.length && last ? { nextCursor: last.resourceId } : {}),
        ...(params.kind === 'mcp' ? {} : { skillRoots: projectRoots(journal, workspaceId) }),
      }
    })
  }
  private async get(params: Record<string, unknown>) {
    return this.journal.read(params.profile as string, (journal) => {
      const item = projected(journal).find((value) => value.resourceId === params.resourceId)
      if (!item)
        throw rpcError('SEMANTIC_REJECTED', { code: 'RESOURCE_NOT_FOUND', resourceId: params.resourceId })
      return item
    })
  }
  private async operation(params: Record<string, unknown>, authority: ResourceAuthority) {
    return this.journal.read(params.profile as string, (journal) => {
      const row = journal.operations.find((value) => value.operation.operationId === params.operationId)
      if (!row) throw rpcError('CAPABILITY_DENIED', { code: 'RESOURCE_OPERATION_UNAVAILABLE' })
      if (
        row.owner.principalId !== authority.principalId &&
        !authority.permissions.includes('resources.reconcile')
      )
        throw rpcError('CAPABILITY_DENIED', { code: 'RESOURCE_OPERATION_OWNER_REQUIRED' })
      return clone(row.operation)
    })
  }
  private async effect(method: EffectMethod, params: Record<string, unknown>, authority: ResourceAuthority) {
    const profile = params.profile as string
    const workspaceId =
      method === '_agnes/v1/skills.refresh'
        ? await this.bindWorkspace(params.workspaceId as string | undefined)
        : undefined
    const result = await this.journal.transact(profile, async (journal) => {
      journal = prune(journal)
      const commandId = params.commandId as string
      const payloadHash = hash({
        method,
        payload: Object.fromEntries(
          Object.entries({
            ...params,
            ...(workspaceId ? { workspaceId } : {}),
          }).filter(([key]) => key !== 'clientId' && key !== 'commandId'),
        ),
      })
      const previous = findCommand(journal, authority, commandId)
      if (previous) {
        if (previous.command.method !== method || previous.command.payloadHash !== payloadHash)
          throw rpcError('SEMANTIC_REJECTED', {
            code: 'COMMAND_CONFLICT',
            reason: 'commandId was already used for a different request',
          })
        // The original effect response is an admission receipt. Returning its mutable live phase
        // would make identical retries observably different while reconciliation is running.
        return {
          next: journal,
          result: {
            replay: true,
            receipt: {
              operationId: previous.operation.operationId,
              state:
                previous.operation.kind === '_agnes/v1/resources.operation.cancel' ? 'succeeded' : 'received',
            },
          },
        }
      }
      if (method === '_agnes/v1/resources.operation.cancel') {
        const target = journal.operations.find((value) => value.operation.operationId === params.operationId)
        // `ResourceControlStore` owns cross-kind lookup. Absence is the only error it may route
        // to MCP; owner/capability failures must remain distinguishable and never be swallowed.
        if (!target) throw rpcError('CAPABILITY_DENIED', { code: 'RESOURCE_OPERATION_UNAVAILABLE' })
        if (
          target.owner.principalId !== authority.principalId &&
          !authority.permissions.includes('resources.reconcile')
        )
          throw rpcError('CAPABILITY_DENIED', { code: 'RESOURCE_OPERATION_OWNER_REQUIRED' })
        // A cancellation command is an admission-time state transition. Once the target has
        // settled it must not manufacture a second receipt, mutate history, or signal a stale
        // controller. Check after idempotent replay so an identical accepted cancellation keeps
        // its original receipt semantics.
        if (terminal.has(target.operation.state))
          throw rpcError('SEMANTIC_REJECTED', {
            code: 'RESOURCE_OPERATION_TERMINAL',
            reason: 'operation has already reached a terminal state',
          })
        if (target.operation.kind === '_agnes/v1/skills.remove')
          throw rpcError('SEMANTIC_REJECTED', { code: 'SKILL_DELETE_NOT_CANCELLABLE' })
        const timestamp = new Date().toISOString()
        const operation: ResourceOperation = {
          operationId: `resource-${randomUUID()}`,
          kind: method,
          state: 'received',
          profile,
          target: target.operation.target,
          revision: target.operation.revision,
          createdAt: timestamp,
          updatedAt: timestamp,
          progress: 0,
        }
        const record: ResourceOperationRecord = {
          operation,
          owner: { principalId: authority.principalId, clientId: authority.clientId },
          command: { method, commandId, payloadHash },
        }
        this.active.get(target.operation.operationId)?.abort()
        const completed = setState(operation, 'succeeded')
        const next = replaceOperation(
          changed(journal, { operations: [...journal.operations, { ...record, operation: completed }] }),
          target.operation.operationId,
          (value) =>
            terminal.has(value.state)
              ? value
              : setState(value, 'cancelled', safeError('CANCELLED', 'operation cancellation was requested')),
          true,
        )
        return { next, result: { replay: false, receipt: receipt(completed) } }
      }
      const target =
        method === '_agnes/v1/skills.refresh'
          ? rootTarget(params.rootKey as string | undefined)
          : (params.resourceId as string)
      const source =
        method === '_agnes/v1/skills.refresh'
          ? undefined
          : journal.discovered.find((value) => value.resourceId === target)
      if (method !== '_agnes/v1/skills.refresh' && !source)
        throw rpcError('SEMANTIC_REJECTED', { code: 'RESOURCE_NOT_FOUND', resourceId: target })
      const revision =
        method === '_agnes/v1/skills.refresh'
          ? hash({ profile, rootKey: params.rootKey ?? null })
          : source?.revision
      if (!revision) throw rpcError('SEMANTIC_REJECTED', { code: 'RESOURCE_NOT_FOUND', resourceId: target })
      if (params.expectedRevision && params.expectedRevision !== revision)
        throw rpcError('SEMANTIC_REJECTED', { code: 'REVISION_CONFLICT' })
      if (source && (method === '_agnes/v1/skills.remove' || method === '_agnes/v1/skills.priority.set')) {
        if (
          source.sourceIdentity.scope === 'runtime' ||
          (method === '_agnes/v1/skills.remove' && source.sourceIdentity.scope === 'package')
        )
          throw rpcError('SEMANTIC_REJECTED', { code: 'SKILL_SOURCE_MANAGED' })
        if (method === '_agnes/v1/skills.remove' && source.stale && !journal.removed.includes(target))
          throw rpcError('SEMANTIC_REJECTED', { code: 'SKILL_STALE' })
        if (
          journal.operations.some(
            (row) => !terminal.has(row.operation.state) && row.operation.target === target,
          )
        )
          throw rpcError('SEMANTIC_REJECTED', { code: 'RESOURCE_BUSY' })
        if (
          method === '_agnes/v1/skills.priority.set' &&
          params.expectedPriority !== (journal.priorities[target] ?? defaultPriority(source))
        )
          throw rpcError('SEMANTIC_REJECTED', { code: 'REVISION_CONFLICT' })
      }
      if (journal.removed.includes(target) && method !== '_agnes/v1/skills.remove')
        throw rpcError('SEMANTIC_REJECTED', { code: 'SKILL_REMOVED' })
      if (method === '_agnes/v1/skills.remove' && source) {
        try {
          if (!this.adapter?.remove || !this.adapter.validateRemove) throw new Error('Deletion unavailable')
          await this.adapter.validateRemove({ profile, descriptor: source })
        } catch {
          throw rpcError('SEMANTIC_REJECTED', { code: 'SKILL_DELETE_PREFLIGHT_FAILED' })
        }
      }
      const timestamp = new Date().toISOString()
      const operation: ResourceOperation = {
        operationId: `resource-${randomUUID()}`,
        kind: method,
        state: 'received',
        profile,
        target,
        revision,
        createdAt: timestamp,
        updatedAt: timestamp,
        progress: 0,
      }
      const record: ResourceOperationRecord = {
        operation,
        owner: { principalId: authority.principalId, clientId: authority.clientId },
        command: { method, commandId, payloadHash },
        ...(workspaceId ? { workspaceId } : {}),
        ...(method === '_agnes/v1/skills.refresh' && params.reinstall
          ? { reinstall: params.reinstall as NonNullable<ResourceOperationRecord['reinstall']> }
          : {}),
      }
      let next = changed(journal, { operations: [...journal.operations, record] })
      if (method === '_agnes/v1/skills.priority.set') {
        const priorities = { ...next.priorities }
        if (params.priority === null) delete priorities[target]
        else priorities[target] = params.priority as number
        next = changed(next, { priorities })
      }
      if (method === '_agnes/v1/skills.remove') {
        if (!next.removed.includes(target) && next.removed.length >= 1000)
          throw rpcError('OVERLOADED', { code: 'RESOURCE_OPERATION_LIMIT' })
        next = changed(next, {
          removed: [...new Set([...next.removed, target])],
          desired: { ...next.desired, [target]: 'disabled' },
        })
      }
      // Desired/trust and the received operation are one durable admission transaction.
      if (method === '_agnes/v1/resources.desired.set')
        next = changed(next, {
          desired: { ...next.desired, [target]: params.state as 'enabled' | 'disabled' },
        })
      if (method === '_agnes/v1/skills.trust.set') {
        const capabilityHash = next.capability[target]
        if (!capabilityHash)
          throw rpcError('SEMANTIC_REJECTED', { code: 'RESOURCE_NOT_FOUND', resourceId: target })
        next = changed(next, {
          trust: {
            ...next.trust,
            [target]: {
              revision,
              capabilityHash,
              state: params.trust as TrustState,
            },
          },
        })
      }
      return { next, result: { replay: false, receipt: receipt(operation) } }
    })
    if (!this.deferDrive && !result.replay && method !== '_agnes/v1/resources.operation.cancel')
      void this.drive(profile, result.receipt.operationId)
    return result.receipt
  }
  private async drive(
    profile: string,
    id: string,
    beforeTerminal?: () => Promise<void>,
    afterSuccess?: () => void,
  ): Promise<void> {
    const controller = new AbortController()
    // Publish before examining the durable row so an immediately following cancel can never miss
    // an adapter invocation in the admission-to-drive gap.
    this.active.set(id, controller)
    const record = await this.journal.transact(profile, (journal) => {
      const row = journal.operations.find((value) => value.operation.operationId === id)
      if (!row || terminal.has(row.operation.state)) return { next: journal, result: undefined }
      return {
        next: replaceOperation(journal, id, (operation) => setState(operation, 'running')),
        result: clone(row),
      }
    })
    if (!record) {
      this.active.delete(id)
      return
    }
    try {
      if (!this.adapter) throw new Error('skill catalog adapter unavailable')
      if (record.operation.kind === '_agnes/v1/skills.refresh') {
        // The scan observed actual state under the old decisions. When the refresh changed them,
        // publish the worker snapshot the observer reads, then reconcile. The committed catalog
        // stands even if that observation fails; the next one catches up.
        if (await this.refresh(profile, record, controller.signal)) {
          await beforeTerminal?.()
          await this.reconcile(profile, controller.signal).catch(() => undefined)
        }
      } else if (record.operation.kind === '_agnes/v1/skills.remove') {
        const descriptor = await this.journal.read(profile, (journal) =>
          journal.discovered.find((item) => item.resourceId === record.operation.target),
        )
        if (descriptor) {
          if (descriptor.revision !== record.operation.revision)
            throw new Error('Skill revision changed before deletion')
          if (!this.adapter.remove) throw new Error('Skill deletion unavailable')
          await this.adapter.remove({ profile, descriptor, signal: controller.signal })
          await this.journal.transact(profile, (journal) => {
            const omit = <T>(map: Readonly<Record<string, T>>) =>
              Object.fromEntries(Object.entries(map).filter(([key]) => key !== descriptor.resourceId))
            return {
              next: changed(journal, {
                discovered: journal.discovered.filter((item) => item.resourceId !== descriptor.resourceId),
                capability: omit(journal.capability),
                trust: omit(journal.trust),
                desired: omit(journal.desired),
                actual: omit(journal.actual),
                priorities: omit(journal.priorities),
              }),
              result: undefined,
            }
          })
        }
        await this.reconcile(profile, controller.signal)
      } else await this.reconcile(profile, controller.signal)
      await beforeTerminal?.()
      await this.journal.transact(profile, (journal) => ({
        next: replaceOperation(journal, id, (operation) =>
          terminal.has(operation.state) ? operation : setState(operation, 'succeeded'),
        ),
        result: undefined,
      }))
      // The snapshot has been durably published and this operation is terminal. Consumers may now
      // safely replace an idle session generation; active turns keep their immutable snapshot.
      // Session replacement is downstream bookkeeping. It must not retroactively turn a committed
      // successful resource operation into a failed one.
      try {
        afterSuccess?.()
      } catch {}
    } catch {
      if (controller.signal.aborted) return
      if (record.operation.kind === '_agnes/v1/skills.refresh') await this.markStale(profile, record)
      await beforeTerminal?.().catch(() => undefined)
      if (record.operation.kind === '_agnes/v1/skills.remove') {
        try {
          afterSuccess?.()
        } catch {}
      }
      await this.journal.transact(profile, (journal) => ({
        next: replaceOperation(journal, id, (operation) =>
          terminal.has(operation.state)
            ? operation
            : setState(
                operation,
                'failed',
                safeError('RESOURCE_RECONCILE_FAILED', 'resource adapter did not accept the requested state'),
              ),
        ),
        result: undefined,
      }))
    } finally {
      this.active.delete(id)
    }
  }
  private async refresh(
    profile: string,
    record: ResourceOperationRecord,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.adapter) throw new Error('skill catalog adapter unavailable')
    const rootKey = record.operation.target.split('/')[2]
    const refresh = await this.adapter.refresh({
      profile,
      ...(rootKey === 'all' ? {} : { rootKey }),
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      signal,
    })
    const observed = 'candidates' in refresh ? refresh.candidates : refresh
    const failedRoots = 'candidates' in refresh ? refresh.failedRoots : []
    // A skipped entry keeps its record and decisions, marked stale, just like a failed root's items.
    const skipped = new Set('candidates' in refresh ? (refresh.skippedResourceIds ?? []) : [])
    const incomingRoots =
      'candidates' in refresh && refresh.roots
        ? refresh.roots
        : deriveIncomingRoots(observed, failedRoots, record.workspaceId)
    const values = observed.map((item) => ({
      ...item.descriptor,
      priority: defaultPriority(item.descriptor),
    }))
    const reinstall = record.reinstall
    if (reinstall) {
      const matched = values.find((item) => item.resourceId === reinstall.resourceId)
      if (
        !matched ||
        matched.revision !== reinstall.expectedRevision ||
        matched.sourceIdentity.rootKey !== rootKey ||
        matched.stale ||
        (matched.sourceIdentity.scope === 'workspace' && matched.workspaceId !== record.workspaceId)
      )
        throw new Error('approved Skill reinstall did not match the observed resource')
    }
    if (
      values.length > 1000 ||
      !observed.every(
        (item) =>
          /^[a-f0-9]{64}$/.test(item.capabilityHash) &&
          validateResourceControlData('SkillDescriptor', item.descriptor).ok,
      )
    )
      throw new Error('invalid skill catalog observation')
    return await this.journal.transact(profile, (journal) => {
      if (
        reinstall &&
        journal.operations.some(
          (row) =>
            row.operation.kind === '_agnes/v1/skills.remove' &&
            row.operation.target === reinstall.resourceId &&
            !terminal.has(row.operation.state),
        )
      )
        throw new Error('Skill deletion is still running')
      const removed = reinstall
        ? journal.removed.filter((id) => id !== reinstall.resourceId)
        : journal.removed
      const retain = (item: SkillDescriptor) => {
        if (skipped.has(item.resourceId)) return true
        if (item.sourceIdentity.rootKey === 'workspace-agnes') {
          // The adapter only observes the requested root, so another root's refresh says nothing here.
          if (rootKey !== 'all' && rootKey !== 'workspace-agnes') return true
          if (item.workspaceId && record.workspaceId && item.workspaceId !== record.workspaceId) return true
          return failedRoots.includes('workspace-agnes')
        }
        return rootKey === 'all'
          ? failedRoots.includes(item.sourceIdentity.rootKey)
          : item.sourceIdentity.rootKey !== rootKey || failedRoots.includes(item.sourceIdentity.rootKey)
      }
      const retained = journal.discovered.filter(retain)
      const incomingIds = new Set(values.map((item) => item.resourceId))
      const discovered = [...retained.filter((item) => !incomingIds.has(item.resourceId)), ...values].filter(
        (item) => !removed.includes(item.resourceId),
      )
      discovered.push(...journal.discovered.filter((item) => removed.includes(item.resourceId)))
      const ids = new Set(discovered.map((item) => item.resourceId))
      const capability = {
        ...Object.fromEntries(Object.entries(journal.capability).filter(([id]) => ids.has(id))),
        ...Object.fromEntries(
          observed
            .filter((item) => ids.has(item.descriptor.resourceId))
            .map((item) => [item.descriptor.resourceId, item.capabilityHash]),
        ),
      }
      // A decision follows its Skill across edits: it is rebound to the observed revision and
      // capability instead of being dropped, so an edited Skill keeps its trust or rejection.
      // The worker that produced this scan still has the deletion barrier in its snapshot.
      // Publish the cleared barrier before reconcile can establish the new winner/actual state.
      let controlChanged = !!reinstall && journal.removed.includes(reinstall.resourceId)
      const trust: Record<string, SkillTrustDecision> = {}
      for (const [id, decision] of Object.entries(journal.trust)) {
        const descriptor = discovered.find((item) => item.resourceId === id)
        const capabilityHash = capability[id]
        if (!descriptor || !capabilityHash) continue
        if (decision.revision !== descriptor.revision || decision.capabilityHash !== capabilityHash)
          controlChanged = true
        trust[id] = { ...decision, revision: descriptor.revision, capabilityHash }
      }
      const desired: Record<string, 'enabled' | 'disabled'> = Object.fromEntries(
        Object.entries(journal.desired).filter(([id]) => ids.has(id)),
      )
      // A Skill seen for the first time is trusted and enabled; any recorded decision wins over this.
      const known = new Set([
        ...journal.discovered.map((item) => item.resourceId),
        ...Object.keys(journal.trust),
        ...Object.keys(journal.desired),
      ])
      for (const item of values) {
        const capabilityHash = capability[item.resourceId]
        if (known.has(item.resourceId) || removed.includes(item.resourceId) || !capabilityHash) continue
        trust[item.resourceId] = { revision: item.revision, capabilityHash, state: 'trusted' }
        desired[item.resourceId] = 'enabled'
        controlChanged = true
      }
      return {
        next: changed(journal, {
          removed,
          roots: mergeRoots(journal.roots, incomingRoots, record.workspaceId).map((root) => {
            if (root.state !== 'unavailable') return root
            const owned = discovered.some(
              (item) =>
                item.sourceIdentity.rootKey === root.rootKey &&
                (root.rootKey !== 'workspace-agnes' ||
                  !root.workspaceId ||
                  item.workspaceId === root.workspaceId),
            )
            return owned ? { ...root, state: 'stale' as const } : root
          }),
          discovered: discovered.map((item) =>
            failedRoots.includes(item.sourceIdentity.rootKey) || skipped.has(item.resourceId)
              ? { ...item, stale: true }
              : item,
          ),
          capability,
          actual: {
            ...Object.fromEntries(Object.entries(journal.actual).filter(([id]) => ids.has(id))),
            ...Object.fromEntries(
              values
                .filter((item) => ids.has(item.resourceId))
                .map((item) => [
                  item.resourceId,
                  {
                    state: item.actual,
                    ...(item.lastSafeError ? { lastSafeError: item.lastSafeError } : {}),
                  },
                ]),
            ),
          },
          trust,
          desired,
        }),
        result: controlChanged,
      }
    })
  }
  private async markStale(profile: string, record: ResourceOperationRecord): Promise<void> {
    const rootKey = record.operation.target.split('/')[2]
    await this.journal.transact(profile, (journal) => ({
      next: changed(journal, {
        roots: (journal.roots.length ? journal.roots : deriveRoots(journal, record.workspaceId)).map(
          (root) => {
            if (
              root.rootKey === 'workspace-agnes' &&
              record.workspaceId &&
              root.workspaceId !== record.workspaceId
            )
              return root
            if (rootKey !== 'all' && root.rootKey !== rootKey) return root
            const owned = journal.discovered.some(
              (item) =>
                item.sourceIdentity.rootKey === root.rootKey &&
                (root.rootKey !== 'workspace-agnes' ||
                  !record.workspaceId ||
                  item.workspaceId === record.workspaceId),
            )
            return { ...root, state: owned ? ('stale' as const) : ('unavailable' as const) }
          },
        ),
        discovered: journal.discovered.map((item) =>
          (rootKey === 'all' || item.sourceIdentity.rootKey === rootKey) &&
          (item.sourceIdentity.rootKey !== 'workspace-agnes' ||
            !record.workspaceId ||
            item.workspaceId === record.workspaceId)
            ? { ...item, stale: true }
            : item,
        ),
      }),
      result: undefined,
    }))
  }
  private async reconcile(profile: string, signal: AbortSignal): Promise<void> {
    if (!this.adapter) throw new Error('skill catalog adapter unavailable')
    const observations = await this.adapter.reconcile({
      profile,
      resources: await this.journal.read(profile, projected),
      signal,
    })
    await this.journal.transact(profile, (journal) => {
      const expected = new Set(journal.discovered.map((source) => source.resourceId))
      const seen = new Set(observations.map((item) => item.resourceId))
      const valid =
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
                { state: item.actual, ...(item.lastSafeError ? { lastSafeError: item.lastSafeError } : {}) },
              ]),
            ),
          },
        }),
        result: undefined,
      }
    })
  }
}

export function createSkillResourceStore(options: {
  directory: string
  scope: ResourceProfileScope
  adapter?: SkillCatalogAdapter
  resolveWorkspaceId?: (workspaceId?: string) => Promise<string>
}): SkillResourceStore {
  return new SkillResourceStore(
    new SkillJournalStore(options.directory, options.scope),
    options.adapter,
    options.resolveWorkspaceId,
  )
}
