import { randomUUID } from 'node:crypto'
import {
  decisionSubjectDigest,
  type SeamImplementations,
  type StorageAdapter,
  withTimeout,
} from '@agnes/core'
import {
  defaultToolPolicy,
  type Logger,
  type PersistenceMetadataPort,
  type PreparedServiceEffect,
  type ServiceContext,
  satisfiesApiRange,
} from '@agnes/extension-api'
import {
  type Actor,
  type DecisionCommandReceipt,
  type DecisionSnapshot,
  inspectJsonData,
  type JsonValue,
  type ProfileDecisionAnswerParams,
  type ProfileServiceCallParams,
  type ProfileServiceCallResult,
  type ProfileServiceOperationParams,
  type ProfileServiceReceipt,
  rpcError,
  validateActor,
  validateAgainst,
} from '@agnes/protocol'
import {
  ProfileServiceCallParams as CallSchema,
  ProfileServiceOperationParams as OperationSchema,
} from '@agnes/protocol/gen/extension-service'
import { bestEffort } from '../best-effort.js'
import { frozenJson } from '../ext-host/frozen-json.js'
import type { ServiceAuthority } from '../ext-host/service-invocation.js'
import type { ServiceRegistry } from '../ext-host/services.js'
import type { ProfileActivations } from './activation.js'
import { profileServiceContext } from './context.js'
import { ProfileEffectQueues } from './effect-queues.js'
import { type DecisionsChanged, ProfileJournal, type ProfileOperation } from './journal.js'
import { retainProfileJournal } from './shared-journal.js'

export type ProfileServiceRuntime = ReturnType<typeof createProfileServiceRuntime>
export function createProfileServiceRuntime(deps: {
  streams?: import('./streams.js').ProfileStreams
  managed?: import('./managed.js').ProfileManagedResources
  barrier?: import('../ext-host/activation-barrier.js').ExtensionActivationBarrier
  journalKey?: string
  publishCurrent?: () => void
  decisionsChanged?: (detail: DecisionsChanged) => void
  profileId: string
  registry: ServiceRegistry
  authority?: ServiceAuthority
  activations: ProfileActivations
  wakes?: import('./wakes.js').ProfileWakeBindings
  storage: StorageAdapter
  metadata: PersistenceMetadataPort
  seams: SeamImplementations
  log: Logger
  clock(): number
  signal: AbortSignal
  networkAllow: readonly string[]
  audit(detail: Record<string, unknown>): void
}) {
  const shared = deps.journalKey
    ? retainProfileJournal(deps.journalKey, deps.profileId, deps.storage, deps.clock, deps.decisionsChanged)
    : undefined
  const calls = new Set<Promise<ProfileServiceCallResult>>()
  let opening: Promise<ProfileJournal> | undefined
  const queues = new ProfileEffectQueues()
  let closed = false
  const journal = () => {
    if (closed || deps.signal.aborted) throw rpcError('CAPABILITY_DENIED')
    opening ??= shared
      ? shared.get()
      : ProfileJournal.open(deps.profileId, deps.storage, deps.clock, deps.decisionsChanged)
    return opening
  }
  const actorFor = async (
    credential: unknown,
    purpose: 'service' | 'approval' = 'service',
  ): Promise<Actor> => {
    const json = inspectJsonData(await deps.seams.principals.resolve(credential, purpose), 65536)
    if (!json.ok || !validateActor(json.value).ok) throw rpcError('CAPABILITY_DENIED')
    const actor = json.value as Actor
    if (actor.role === 'agent') throw rpcError('CAPABILITY_DENIED')
    return frozenJson(actor)
  }
  const resolve = async (
    params: ProfileServiceOperationParams | ProfileServiceCallParams,
    credential: unknown,
  ) => {
    if (closed || deps.signal.aborted || !deps.authority) throw rpcError('CAPABILITY_DENIED')
    const source = await deps.authority.resolve(credential)
    const entry = deps.registry.resolve(params.extension, params.service)
    if (
      entry?.capability.scope !== 'profile' ||
      !source.source ||
      !source.grants.some(
        (g) =>
          g.extension === entry.owner &&
          g.name === params.service &&
          satisfiesApiRange(g.range, entry.version),
      )
    )
      throw rpcError('CAPABILITY_DENIED')
    const requestedReads = 'input' in params ? (params.sessionReads ?? []) : []
    if (
      !Array.isArray(requestedReads) ||
      requestedReads.length > 16 ||
      (requestedReads.length > 0 && entry.capability.kind !== 'query') ||
      requestedReads.some(
        (sessionId) => typeof sessionId !== 'string' || !source.sessionReads?.includes(sessionId),
      )
    )
      throw rpcError('CAPABILITY_DENIED')
    const sessionReads = Object.freeze([...requestedReads])
    const actor = await actorFor(source.subjectCredential)
    const activationId = deps.activations.require(
      entry.owner,
      entry.integrity,
      undefined,
      entry.activationRevision,
    )
    const alive = () => {
      if (closed || deps.signal.aborted) throw rpcError('CAPABILITY_DENIED')
      entry.assertAlive()
      if (deps.registry.resolve(params.extension, params.service) !== entry)
        throw rpcError('CAPABILITY_DENIED')
      deps.activations.require(entry.owner, entry.integrity, activationId, entry.activationRevision)
    }
    const authorize = async () => {
      alive()
      const decision = await deps.seams.principals.authorize(actor, 'execute', {
        kind: 'datasource',
        id: `${entry.owner}/${entry.capability.name}`,
      })
      alive()
      if (decision.effect === 'deny') throw rpcError('CAPABILITY_DENIED')
      return decision.effect
    }
    const principalPolicy = await authorize()
    return {
      entry,
      actor,
      source: source.source,
      activationId,
      alive,
      authorize,
      principalPolicy,
      sessionReads,
    }
  }
  type Identity = Awaited<ReturnType<typeof resolve>>
  const context = (
    id: Identity,
    signal: AbortSignal,
    writable: boolean,
    admission?: ServiceContext['admission'],
  ) =>
    profileServiceContext({
      ...deps,
      ...id,
      identity: { actor: id.actor, source: id.source, requestId: randomUUID(), signal },
      writable,
      ...(admission ? { admission } : {}),
    })
  const keyFor = (id: Identity, operationId: string) =>
    decisionSubjectDigest({
      actor: { id: id.actor.id, org: id.actor.org },
      source: id.source,
      owner: id.entry.owner,
      operationId,
    })
  const sourceFor = (id: Identity, operationId: string) => ({
    owner: id.entry.owner,
    sourcePackage: id.entry.packageId,
    packageVersion: id.entry.version,
    operationId,
    alive: id.alive,
  })
  const prepare = async (
    id: Identity,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<PreparedServiceEffect> => {
    const reconciliation = deps.managed?.reconciliation(id.entry.owner, id.entry.capability.name)
    const value = reconciliation
      ? await reconciliation.prepare()
      : id.entry.prepare
        ? await id.entry.prepare(input, context(id, signal, false))
        : { input, presentation: { service: id.entry.capability.name } }
    const checked = inspectJsonData(value, 131072)
    if (!checked.ok || !checked.value || typeof checked.value !== 'object' || Array.isArray(checked.value))
      throw rpcError('INVALID_PARAMS')
    const record = checked.value as Record<string, JsonValue>
    if (
      !Object.keys(record).every((key) => ['input', 'presentation', 'resourceRevision'].includes(key)) ||
      !Object.hasOwn(record, 'input') ||
      !Object.hasOwn(record, 'presentation') ||
      (record.resourceRevision !== undefined &&
        (typeof record.resourceRevision !== 'string' || record.resourceRevision.length > 512)) ||
      !id.entry.input(record.input)
    )
      throw rpcError('INVALID_PARAMS')
    return frozenJson(checked.value) as unknown as PreparedServiceEffect
  }
  const readOperation = async (
    params: ProfileServiceOperationParams,
    credential: unknown,
  ): Promise<ProfileServiceReceipt> => {
    if (!validateAgainst(OperationSchema, params).ok) throw rpcError('INVALID_PARAMS')
    const id = await resolve(params, credential)
    const log = await journal()
    const operation = log.operations.get(keyFor(id, params.operationId))
    if (!operation || operation.service !== params.service) throw rpcError('CAPABILITY_DENIED')
    if (operation.activationId !== id.activationId)
      return { operationId: params.operationId, state: 'refused', code: 'ACTIVATION_CHANGED' }
    if (operation.receipt.state === 'approval-required' && !operation.receipt.decision)
      return { operationId: params.operationId, state: 'running' }
    return structuredClone(operation.receipt)
  }
  const callUnchecked = async (
    raw: ProfileServiceCallParams,
    credential: unknown,
    callerSignal?: AbortSignal,
  ): Promise<ProfileServiceCallResult> => {
    const checked = inspectJsonData(raw, 1049600)
    if (!checked.ok || !validateAgainst(CallSchema, checked.value).ok) throw rpcError('INVALID_PARAMS')
    const params = frozenJson(checked.value) as ProfileServiceCallParams
    const id = await resolve(params, credential)
    const cap = id.entry.capability
    const signal = AbortSignal.any([
      deps.signal,
      id.entry.signal,
      AbortSignal.timeout(cap.timeoutMs),
      ...(callerSignal ? [callerSignal] : []),
    ])
    const alive = () => {
      signal.throwIfAborted()
      id.alive()
    }
    alive()
    if (!id.entry.input(params.input)) throw rpcError('INVALID_PARAMS')
    if (cap.kind === 'query') {
      if (params.operationId || id.principalPolicy !== 'allow') throw rpcError('CAPABILITY_DENIED')
      const output = await withTimeout(
        id.entry.handler(params.input, context(id, signal, false)),
        cap.timeoutMs,
        'profile-query',
        signal,
      )
      alive()
      if (!inspectJsonData(output, cap.maxResultBytes).ok || !id.entry.output(output))
        throw rpcError('INTERNAL_ERROR')
      deps.audit({
        kind: 'query',
        owner: id.entry.owner,
        actorId: id.actor.id,
        source: id.source,
        inputDigest: decisionSubjectDigest(params.input),
        outcome: 'completed',
      })
      return { output }
    }
    if (!params.operationId || !cap.effectPolicy) throw rpcError('INVALID_PARAMS')
    const operationId = params.operationId
    const effectPolicy = cap.effectPolicy
    return queues.run<ProfileServiceReceipt>(id.entry.owner, cap.priority ?? 'normal', signal, async () => {
      const log = await journal()
      const key = keyFor(id, operationId)
      const requestDigest = decisionSubjectDigest({
        service: cap.name,
        input: params.input,
        actor: id.actor,
        source: id.source,
      })
      const existing = log.operations.get(key)
      if (existing) {
        if (existing.requestDigest !== requestDigest)
          throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT' })
        if (existing.activationId !== id.activationId)
          return { state: 'refused', operationId, code: 'ACTIVATION_CHANGED' }
        if (existing.receipt.state !== 'approval-required') return structuredClone(existing.receipt)
      }
      const prepared = await withTimeout(
        prepare(id, params.input, signal),
        cap.timeoutMs,
        'profile-prepare',
        signal,
      )
      alive()
      const digest = decisionSubjectDigest({
        profileId: deps.profileId,
        owner: id.entry.owner,
        integrity: id.entry.integrity,
        version: id.entry.version,
        capability: cap,
        actor: id.actor,
        source: id.source,
        activationId: id.activationId,
        input: params.input,
        prepared,
      })
      if (existing && existing.digest !== digest) throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT' })
      const policy = await defaultToolPolicy.decide(
        {
          sessionKey: '',
          workspaceRoot: '',
          cwd: '',
          actor: id.actor,
          call: { id: operationId, name: `${id.entry.owner}/${cap.name}`, args: prepared.input },
          policy: { isReadOnly: false, ...effectPolicy },
          tainted: false,
          fullAccess: false,
          approvalMode: 'manual',
        },
        signal,
      )
      const automaticRecovery =
        deps.managed?.reconciliation(id.entry.owner, cap.name)?.automatic(prepared) === true
      const needsApproval =
        (!automaticRecovery && policy.effect === 'ask') || id.principalPolicy === 'require_approval'
      if (policy.effect === 'deny') throw rpcError('CAPABILITY_DENIED')
      const decisions = log.decisions(id.actor),
        source = sourceFor(id, operationId)
      const decision = needsApproval
        ? await decisions.port(source).request({
            key,
            purpose: 'service.effect',
            subject: {
              digest,
              service: cap.name,
              owner: id.entry.owner,
              presentation: prepared.presentation,
              input: params.input,
              preparedInput: prepared.input,
              resourceRevision: prepared.resourceRevision ?? null,
            },
            prompt: `Approve ${cap.name}?`,
            options: ['allowed-once', 'rejected'],
            responseSchema: { type: 'null' },
          })
        : undefined
      const row = await log.locked(async () => {
        alive()
        const existing = log.operations.get(key)
        if (existing) {
          if (existing.digest !== digest) throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT' })
          return existing
        }
        const operation: ProfileOperation = {
          key,
          digest,
          requestDigest,
          control: null,
          actorId: id.actor.id,
          owner: id.entry.owner,
          source: id.source,
          service: cap.name,
          activationId: id.activationId,
          input: params.input,
          prepared: prepared as unknown as JsonValue,
          receipt: decision
            ? { state: 'approval-required', operationId, decision }
            : { state: 'approval-required', operationId },
        }
        await log.write(operation, [], alive)
        return operation
      })
      if (row.receipt.state !== 'approval-required') return structuredClone(row.receipt)
      const snapshot = decision ? await decisions.get(decision, source) : undefined
      if (snapshot && !snapshot.result) return structuredClone(row.receipt)
      const result = await log.locked(async () => {
        alive()
        const current = log.operations.get(key)
        if (!current) throw rpcError('INTERNAL_ERROR')
        if (current.receipt.state !== 'approval-required') return { receipt: current.receipt }
        await id.authorize()
        const latest = await withTimeout(
          prepare(id, params.input, signal),
          cap.timeoutMs,
          'profile-revalidate',
          signal,
        )
        if (decisionSubjectDigest(latest) !== decisionSubjectDigest(prepared))
          throw rpcError('SEMANTIC_REJECTED', { code: 'ID_CONFLICT' })
        alive()
        if (
          snapshot &&
          (snapshot.invalidation ||
            snapshot.consumption ||
            snapshot.result?.reason !== 'answered' ||
            snapshot.result.response.option !== 'allowed-once')
        ) {
          const receipt: ProfileServiceReceipt = { state: 'refused', operationId, code: 'APPROVAL_REFUSED' }
          await log.write({ ...current, receipt }, [], alive)
          return { receipt }
        }
        const events = decision ? decisions.consumptionEvents([decision], source, operationId) : []
        const control = cap.controlLeaseMs
          ? { grantId: randomUUID(), expiresAt: deps.clock() + cap.controlLeaseMs }
          : null
        const receipt: ProfileServiceReceipt = {
          state: 'running',
          operationId,
          ...(control ? { controlGrant: control } : {}),
        }
        const dispatched = { ...current, receipt, control }
        await log.write(dispatched, events, alive)
        return { dispatched }
      })
      if (result.receipt) return structuredClone(result.receipt)
      if (!result.dispatched) throw rpcError('INTERNAL_ERROR')
      const control = result.dispatched.control
      const executionSignal = control
        ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(0, control.expiresAt - deps.clock()))])
        : signal
      let receipt: ProfileServiceReceipt
      try {
        alive()
        const approval =
          snapshot?.result?.reason === 'answered'
            ? {
                requestId: snapshot.handle.id,
                subjectRevision: snapshot.request.subjectDigest,
                answeredBy: snapshot.result.answeredBy,
              }
            : undefined
        const output = await withTimeout(
          id.entry.handler(
            prepared.input,
            context(id, executionSignal, true, {
              operationId,
              subjectDigest: digest,
              prepared,
              ...(control ? { controlGrant: control } : {}),
              ...(approval ? { approval } : {}),
            }),
          ),
          cap.timeoutMs,
          'profile-effect',
          executionSignal,
        )
        if (!inspectJsonData(output, cap.maxResultBytes).ok || !id.entry.output(output))
          throw rpcError('INTERNAL_ERROR')
        receipt = { state: 'completed', operationId, output, ...(control ? { controlGrant: control } : {}) }
      } catch (error) {
        bestEffort(deps.log, 'profile-effect-execution')(error)
        receipt = { state: 'unknown', operationId, code: 'OUTCOME_UNKNOWN' }
      }
      try {
        await log.locked(() => log.write({ ...(log.operations.get(key) ?? row), receipt }))
      } catch (error) {
        bestEffort(deps.log, 'profile-effect-receipt-write')(error)
        return { state: 'unknown', operationId, code: 'OUTCOME_UNKNOWN' }
      }
      deps.audit({
        kind: 'effect',
        operationId,
        subjectDigest: digest,
        owner: id.entry.owner,
        activationId: id.activationId,
        actorId: id.actor.id,
        source: id.source,
        decisionId: decision?.id ?? null,
        outcome: receipt.state,
      })
      return receipt
    })
  }
  const call = (
    params: ProfileServiceCallParams,
    credential: unknown,
    signal?: AbortSignal,
  ): Promise<ProfileServiceCallResult> => {
    const invoke = () => callUnchecked(params, credential, signal)
    const pending = Promise.resolve(deps.barrier ? deps.barrier.admit('service').run(invoke) : invoke())
    calls.add(pending)
    void pending.finally(() => calls.delete(pending)).catch(() => undefined)
    return pending
  }
  const listDecisionState = async (credential: unknown) => {
    const actor = await actorFor(credential),
      log = await journal()
    const decisions = log.decisions(actor)
    const pending: DecisionSnapshot[] = []
    for (const value of await decisions.list()) {
      if (
        value.request.requestedBy.id !== actor.id ||
        value.request.requestedBy.org !== actor.org ||
        value.consumption ||
        value.invalidation ||
        value.result
      )
        continue
      const operation = [...log.operations.values()].find(
        (row) => row.receipt.decision?.id === value.handle.id,
      )
      if (!operation) continue
      const entry = deps.registry.resolve(operation.owner, operation.service)
      try {
        if (!entry) throw rpcError('CAPABILITY_DENIED')
        entry.assertAlive()
        deps.activations.require(
          operation.owner,
          entry.integrity,
          operation.activationId,
          entry.activationRevision,
        )
        pending.push(value)
      } catch {
        await decisions.withdraw(
          value.handle,
          {
            owner: value.request.owner,
            operationId: value.request.operationId,
            sourcePackage: value.request.sourcePackage,
            packageVersion: value.request.packageVersion,
            alive() {},
          },
          'activation-revoked',
        )
      }
    }
    return { principal: { id: actor.id, org: actor.org }, decisions: pending.slice(0, 1000) }
  }
  return Object.freeze({
    signal: deps.signal,
    streams: deps.streams,
    managed: deps.managed,
    publishCurrent() {
      deps.publishCurrent?.()
    },
    call,
    readOperation,
    async serviceIdentity(
      params: ProfileServiceOperationParams | ProfileServiceCallParams,
      credential: unknown,
    ) {
      const id = await resolve(params, credential)
      return { packageId: id.entry.packageId, integrity: id.entry.integrity }
    },
    async authorizeControl(params: ProfileServiceOperationParams, credential: unknown) {
      if (!validateAgainst(OperationSchema, params).ok) throw rpcError('INVALID_PARAMS')
      const id = await resolve(params, credential),
        log = await journal()
      const operation = log.operations.get(keyFor(id, params.operationId))
      if (
        !operation?.control ||
        operation.service !== params.service ||
        operation.requestDigest !==
          decisionSubjectDigest({
            service: id.entry.capability.name,
            input: operation.input,
            actor: id.actor,
            source: id.source,
          }) ||
        operation.activationId !== id.activationId ||
        operation.control.expiresAt <= deps.clock() ||
        !['running', 'completed'].includes(operation.receipt.state)
      )
        throw rpcError('CAPABILITY_DENIED')
      await id.authorize()
      id.alive()
      return Object.freeze({
        ...operation.control,
        operationId: params.operationId,
        subjectDigest: operation.digest,
        activationId: id.activationId,
        actor: id.actor,
        source: id.source,
      })
    },
    async resolveWake(bindingId: string, credential: unknown) {
      if (!deps.wakes || !deps.authority) throw rpcError('CAPABILITY_DENIED')
      const source = await deps.authority.resolve(credential)
      const binding = deps.wakes.read(bindingId)
      if (
        !source.grants.some(
          (grant) =>
            grant.extension === binding.producerOwner &&
            grant.name === 'wake.enqueue' &&
            satisfiesApiRange(grant.range, binding.producerVersion ?? '0.0.0'),
        )
      )
        throw rpcError('CAPABILITY_DENIED')
      const actor = await actorFor(source.subjectCredential)
      if (
        actor.id !== binding.actorId ||
        (binding.actorOrg !== undefined && binding.actorOrg !== actor.org) ||
        binding.profileId !== deps.profileId
      )
        throw rpcError('CAPABILITY_DENIED')
      let active = true
      try {
        deps.wakes.require(bindingId)
      } catch {
        active = false
      }
      return { binding, active }
    },
    revokeWakeSession(sessionId: string) {
      if (!deps.wakes || closed) throw rpcError('CAPABILITY_DENIED')
      deps.wakes.revokeSession(sessionId)
    },
    readWake(bindingId: string) {
      if (!deps.wakes || closed || deps.signal.aborted) throw rpcError('CAPABILITY_DENIED')
      return deps.wakes.read(bindingId)
    },
    requireWake(bindingId: string) {
      if (!deps.wakes || closed || deps.signal.aborted) throw rpcError('CAPABILITY_DENIED')
      return deps.wakes.require(bindingId)
    },
    listDecisionState,
    async listDecisions(credential: unknown): Promise<DecisionSnapshot[]> {
      return (await listDecisionState(credential)).decisions
    },
    async answerDecision(
      params: ProfileDecisionAnswerParams,
      credential: unknown,
    ): Promise<DecisionCommandReceipt> {
      const actor = await actorFor(credential, 'approval'),
        log = await journal()
      return log.decisions(actor).answer(params, {
        actor,
        category: 'human',
        authorize: async (snapshot) => {
          const operation = [...log.operations.values()].find(
            (row) => row.receipt.decision?.id === snapshot.handle.id,
          )
          const entry = operation && deps.registry.resolve(operation.owner, operation.service)
          if (!operation || !entry) throw rpcError('CAPABILITY_DENIED')
          entry.assertAlive()
          deps.activations.require(
            operation.owner,
            entry.integrity,
            operation.activationId,
            entry.activationRevision,
          )
          if (
            closed ||
            snapshot.request.requestedBy.id !== actor.id ||
            snapshot.request.requestedBy.org !== actor.org ||
            decisionSubjectDigest(await actorFor(credential, 'approval')) !== decisionSubjectDigest(actor)
          )
            throw rpcError('CAPABILITY_DENIED')
        },
      })
    },
    async close() {
      closed = true
      await Promise.allSettled([...calls])
      if (shared) await shared.close()
      else await (await opening)?.close()
    },
  })
}
