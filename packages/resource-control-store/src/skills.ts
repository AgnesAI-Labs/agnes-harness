import { randomUUID } from 'node:crypto'
import type { ResourceControlMethodName } from '@agnes/protocol'
import {
  type ResourceOperation,
  rpcError,
  type SkillDescriptor,
  type SkillScanObservation,
  type TrustState,
  validateResourceControlData,
} from '@agnes/protocol'
import type { SkillCatalogAdapter } from './adapters.js'
import type { ResourceAuthority, ResourceEffectAdmission } from './permissions.js'
import type { ResourceProfileScope } from './profile-scope.js'
import { type ResourceOperationRecord, SkillJournalStore, type SkillTrustDecision } from './skill-journal.js'
import { readSkillView, skillListPage } from './skill-list.js'
import { checkedSkillScanObservation, SkillScanReports, type SkillScanToken } from './skill-scan-reports.js'
import {
  changed,
  clone,
  defaultPriority,
  deriveIncomingRoots,
  deriveRoots,
  findCommand,
  hash,
  mergeRoots,
  observeSkills,
  projected,
  prune,
  receipt,
  reconcileSkillObservations,
  replaceOperation,
  rootTarget,
  safeError,
  setState,
  skillControl,
  skillNameGroup,
  skillRuntimeRevision,
  terminal,
} from './skill-state.js'

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
/** Daemon-owned desired/trust/operation state. Host adapters are the sole source of discovery and actual observations. */
export class SkillResourceStore {
  private readonly active = new Map<string, AbortController>()
  private deferDrive = false
  private readonly admissions = new Map<string, ResourceEffectAdmission>()
  private readonly scanReports = new SkillScanReports()
  private readonly scanTokens = new Map<string, SkillScanToken>()
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
    for (const row of pending) {
      if (row.requiresAdmission && !this.admissions.has(row.operation.operationId)) continue
      await this.drive(
        profile,
        row.operation.operationId,
        () => beforeTerminal?.(profile) ?? Promise.resolve(),
      )
    }
  }
  async workerControl(profile: string): Promise<{
    priorities: Readonly<Record<string, number>>
    removed: readonly string[]
    desired: Array<{ resourceId: string; state: 'enabled' | 'disabled' }>
    trust: Array<{ resourceId: string; revision: string; capabilityHash: string; state: TrustState }>
  }> {
    return this.journal.read(profile, skillControl)
  }

  async observeWorker(profile: string, values: readonly SkillDescriptor[]): Promise<void> {
    if (!values.every((value) => validateResourceControlData('SkillDescriptor', value).ok))
      throw new Error('invalid worker skill observation')
    await this.journal.transact(profile, (journal) => observeSkills(journal, values))
  }

  private async bindWorkspace(workspaceId?: string): Promise<string | undefined> {
    if (!this.resolveWorkspaceId) return workspaceId
    return this.resolveWorkspaceId(workspaceId)
  }
  /** One complete read for the unified list; its outer pagination must not reread changing runtime IDs. */
  async view(params: Record<string, unknown>) {
    const workspaceId = await this.bindWorkspace(params.workspaceId as string | undefined)
    const skillScanReport =
      params.kind === 'mcp' ? undefined : this.scanReports.read(params.profile as string, workspaceId)
    return readSkillView(this.journal, this.adapter, params, workspaceId, skillScanReport)
  }
  private async list(params: Record<string, unknown>) {
    return skillListPage(await this.view(params), params)
  }
  private async get(params: Record<string, unknown>) {
    const saved = await this.journal.read(params.profile as string, (journal) => ({
      source: journal.discovered.find((item) => item.resourceId === params.resourceId),
      skills: projected(journal, skillNameGroup(journal, params.resourceId as string)),
    }))
    const workspaceId = await this.bindWorkspace(
      saved.source?.workspaceId ?? (params.workspaceId as string | undefined),
    )
    const skills = saved.skills.filter(
      (item) => item.sourceIdentity.scope !== 'workspace' || !workspaceId || item.workspaceId === workspaceId,
    )
    if (!saved.source && String(params.resourceId).startsWith('skill/runtime/')) {
      const item = (await this.view(params)).items.find((item) => item.resourceId === params.resourceId)
      if (item) return item
    }
    // Runtime-only resources have no journal row; the adapter supplies their current view.
    const items = this.adapter?.view
      ? await this.adapter.view({
          profile: params.profile as string,
          skills,
          signal: AbortSignal.timeout(31_000),
        })
      : skills
    const item = items.find((value) => value.resourceId === params.resourceId)
    if (!item)
      throw rpcError('SEMANTIC_REJECTED', { code: 'RESOURCE_NOT_FOUND', resourceId: params.resourceId })
    return item
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
    if (typeof params.resourceId === 'string' && params.resourceId.startsWith('skill/runtime/'))
      throw rpcError('CAPABILITY_DENIED', {
        code: 'SKILL_MANAGED_BY_PLUGIN',
        reason: 'Runtime Skills are managed by their owning plugin',
      })
    const profile = params.profile as string
    const workspaceId =
      method === '_agnes/v1/skills.refresh'
        ? await this.bindWorkspace(params.workspaceId as string | undefined)
        : undefined
    const result = await this.journal.transact(
      profile,
      async (journal) => {
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
                  previous.operation.kind === '_agnes/v1/resources.operation.cancel'
                    ? 'succeeded'
                    : 'received',
              },
            },
          }
        }
        if (method === '_agnes/v1/resources.operation.cancel') {
          const target = journal.operations.find(
            (value) => value.operation.operationId === params.operationId,
          )
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
            ...(authority.admission ? { requiresAdmission: true as const } : {}),
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
                : setState(
                    value,
                    'cancelled',
                    safeError('CANCELLED', 'operation cancellation was requested'),
                  ),
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
          ...(authority.admission ? { requiresAdmission: true as const } : {}),
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
      },
      authority.admission,
    )
    if (authority.admission && method !== '_agnes/v1/resources.operation.cancel')
      this.admissions.set(result.receipt.operationId, authority.admission)
    if (
      !result.replay &&
      method === '_agnes/v1/skills.refresh' &&
      (!params.rootKey || params.rootKey === 'user-agnes')
    )
      this.scanTokens.set(
        result.receipt.operationId,
        this.scanReports.begin(profile, workspaceId, result.receipt.operationId),
      )
    if (!this.deferDrive && !result.replay && method !== '_agnes/v1/resources.operation.cancel')
      void this.drive(profile, result.receipt.operationId).catch(() => undefined)
    return result.receipt
  }
  private async drive(
    profile: string,
    id: string,
    beforeTerminal?: () => Promise<void>,
    afterSuccess?: () => void,
  ): Promise<void> {
    const admission = this.admissions.get(id)
    const controller = new AbortController()
    // Publish before examining the durable row so an immediately following cancel can never miss
    // an adapter invocation in the admission-to-drive gap.
    this.active.set(id, controller)
    try {
      const record = await this.journal.transact(
        profile,
        (journal) => {
          const row = journal.operations.find((value) => value.operation.operationId === id)
          if (row?.requiresAdmission && !admission) throw new Error('RESOURCE_PERMISSION_REQUIRED')
          if (!row || terminal.has(row.operation.state)) return { next: journal, result: undefined }
          return {
            next: replaceOperation(journal, id, (operation) => setState(operation, 'running')),
            result: clone(row),
          }
        },
        admission,
      )
      if (!record) return
      const reportsScan =
        record.operation.kind === '_agnes/v1/skills.refresh' &&
        ['all', 'user-agnes'].includes(record.operation.target.split('/')[2] ?? '')
      const scanToken = reportsScan
        ? (this.scanTokens.get(id) ?? this.scanReports.begin(profile, record.workspaceId, id))
        : undefined
      let scanObservation: SkillScanObservation | undefined
      try {
        if (admission) {
          await admission.verify()
          admission.assertActive()
        }
        if (!this.adapter) throw new Error('skill catalog adapter unavailable')
        let resourcesChanged = true
        if (record.operation.kind === '_agnes/v1/skills.refresh') {
          const before = await this.journal.read(profile, skillRuntimeRevision)
          // The scan observed actual state under the old decisions. When the refresh changed them,
          // publish the worker snapshot the observer reads, then reconcile. The committed catalog
          // stands even if that observation fails; the next one catches up.
          if (
            await this.refresh(profile, record, controller.signal, admission, (observation) => {
              scanObservation = observation
            })
          ) {
            await beforeTerminal?.()
            await this.reconcile(profile, controller.signal, admission).catch(() => undefined)
          }
          resourcesChanged = before !== (await this.journal.read(profile, skillRuntimeRevision))
        } else if (record.operation.kind === '_agnes/v1/skills.remove') {
          const descriptor = await this.journal.read(profile, (journal) =>
            journal.discovered.find((item) => item.resourceId === record.operation.target),
          )
          if (descriptor) {
            if (descriptor.revision !== record.operation.revision)
              throw new Error('Skill revision changed before deletion')
            if (!this.adapter.remove) throw new Error('Skill deletion unavailable')
            if (admission) {
              await admission.verify()
              admission.assertActive()
            }
            await this.adapter.remove({ profile, descriptor, signal: controller.signal })
            await this.journal.transact(
              profile,
              (journal) => {
                const omit = <T>(map: Readonly<Record<string, T>>) =>
                  Object.fromEntries(Object.entries(map).filter(([key]) => key !== descriptor.resourceId))
                return {
                  next: changed(journal, {
                    discovered: journal.discovered.filter(
                      (item) => item.resourceId !== descriptor.resourceId,
                    ),
                    capability: omit(journal.capability),
                    trust: omit(journal.trust),
                    desired: omit(journal.desired),
                    actual: omit(journal.actual),
                    priorities: omit(journal.priorities),
                  }),
                  result: undefined,
                }
              },
              admission,
            )
          }
          await this.reconcile(profile, controller.signal, admission)
        } else
          await this.reconcile(
            profile,
            controller.signal,
            admission,
            ['_agnes/v1/resources.desired.set', '_agnes/v1/skills.trust.set'].includes(record.operation.kind)
              ? record.operation.target
              : undefined,
          )
        await beforeTerminal?.()
        const completion = await this.journal.transact(
          profile,
          (journal) => {
            const next = replaceOperation(journal, id, (operation) =>
              terminal.has(operation.state) ? operation : setState(operation, 'succeeded'),
            )
            return {
              next,
              result: next.operations.find((row) => row.operation.operationId === id)?.operation.state,
            }
          },
          admission,
        )
        if (completion === 'succeeded' && !controller.signal.aborted && scanToken && scanObservation)
          this.scanReports.publish(scanToken, scanObservation)
        // The snapshot has been durably published and this operation is terminal. Consumers may now
        // safely replace an idle session generation; active turns keep their immutable snapshot.
        // Session replacement is downstream bookkeeping. It must not retroactively turn a committed
        // successful resource operation into a failed one.
        try {
          if (resourcesChanged) afterSuccess?.()
        } catch {}
      } catch {
        if (controller.signal.aborted) return
        if (admission) {
          await admission.verify()
          admission.assertActive()
        }
        if (record.operation.kind === '_agnes/v1/skills.refresh')
          await this.markStale(profile, record, admission)
        await beforeTerminal?.().catch(() => undefined)
        if (record.operation.kind === '_agnes/v1/skills.remove') {
          try {
            afterSuccess?.()
          } catch {}
        }
        await this.journal.transact(
          profile,
          (journal) => ({
            next: replaceOperation(journal, id, (operation) =>
              terminal.has(operation.state)
                ? operation
                : setState(
                    operation,
                    'failed',
                    safeError(
                      'RESOURCE_RECONCILE_FAILED',
                      'resource adapter did not accept the requested state',
                    ),
                  ),
            ),
            result: undefined,
          }),
          admission,
        )
      }
    } finally {
      this.active.delete(id)
      this.admissions.delete(id)
      this.scanTokens.delete(id)
    }
  }
  private async refresh(
    profile: string,
    record: ResourceOperationRecord,
    signal: AbortSignal,
    admission?: ResourceEffectAdmission,
    onObservation?: (observation: SkillScanObservation) => void,
  ): Promise<boolean> {
    if (admission) {
      await admission.verify()
      admission.assertActive()
    }
    if (!this.adapter) throw new Error('skill catalog adapter unavailable')
    const rootKey = record.operation.target.split('/')[2]
    const refresh = await this.adapter.refresh({
      profile,
      ...(rootKey === 'all' ? {} : { rootKey }),
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      signal,
    })
    const observed = 'candidates' in refresh ? refresh.candidates : refresh
    if ('candidates' in refresh && refresh.skillScanObservation !== undefined)
      onObservation?.(checkedSkillScanObservation(refresh.skillScanObservation))
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
    return await this.journal.transact(
      profile,
      (journal) => {
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
        const discovered = [
          ...retained.filter((item) => !incomingIds.has(item.resourceId)),
          ...values,
        ].filter((item) => !removed.includes(item.resourceId))
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
      },
      admission,
    )
  }
  private async markStale(
    profile: string,
    record: ResourceOperationRecord,
    admission?: ResourceEffectAdmission,
  ): Promise<void> {
    const rootKey = record.operation.target.split('/')[2]
    await this.journal.transact(
      profile,
      (journal) => ({
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
      }),
      admission,
    )
  }
  private async reconcile(
    profile: string,
    signal: AbortSignal,
    admission?: ResourceEffectAdmission,
    resourceId?: string,
  ): Promise<void> {
    if (!this.adapter) throw new Error('skill catalog adapter unavailable')
    const resources = await this.journal.read(profile, (journal) =>
      projected(journal, resourceId ? skillNameGroup(journal, resourceId) : journal.discovered),
    )
    if (admission) {
      await admission.verify()
      admission.assertActive()
    }
    const observations = await this.adapter.reconcile({
      profile,
      resources,
      signal,
    })
    await this.journal.transact(
      profile,
      (journal) => reconcileSkillObservations(journal, resources, observations),
      admission,
    )
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
