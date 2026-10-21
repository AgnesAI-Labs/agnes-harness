import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { Seq } from '@agnes/core-common/types'
import { CoreError, type EventInput } from '@agnes/core-common/types'
import { decisionSubjectDigest } from '@agnes/core-ledger'
import type { SessionLogImpl } from '@agnes/core-ledger/log/session-log'
import type {
  DecisionHandle,
  DecisionPort,
  DecisionSnapshot,
  DecisionSpec,
  DecisionWaitResult,
} from '@agnes/extension-api'
import {
  type Actor,
  automaticPermissionDecision,
  compilePluginConfig,
  type DecisionCommandReceipt,
  type DecisionResponse,
  inspectJsonData,
  isPermissionPurpose,
  permissionEffectAdmission,
  validateAgainst,
} from '@agnes/protocol'
import {
  DecisionHandle as HandleSchema,
  DecisionResponse as ResponseSchema,
  DecisionSpec as SpecSchema,
} from '@agnes/protocol/gen/session-v1'
import { ROLE_APPROVAL_REFUSAL } from '../child/roles.js'
import { delegatedDecisionRefused, humanDecisionActorAllowed } from './decision-authority.js'

/** Minimal authority needed by the decision commands; the session supplies the writer gate. */
export interface DecisionAuthority {
  readonly refuseApprovals?: boolean
  readonly delegatedToolApprovals?: boolean
  readonly key: string
  /** A profile journal uses AR1 without creating a session or granting session access. */
  readonly profileId?: string
  readonly lane: string
  readonly lastSeq: Seq
  readonly closed: boolean
  readonly cancelled: boolean
  readonly actor: Actor
  readonly permissionContext?: import('@agnes/protocol').PermissionContext | undefined
  readonly ttlMs: number
  readonly timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
  readonly log: Pick<
    SessionLogImpl,
    'append' | 'observeCommitted' | 'claimLease' | 'leaseRemainingMs' | 'faulted'
  >
  beforeAttestation?(): Promise<void>
  historyVerified?(): boolean
  readDecisions(): ReadonlyMap<string, { value: DecisionSnapshot; seq: Seq }>
  clock(): number
  id(): string
  transact<T>(work: () => Promise<T>): Promise<T>
  event(value: DecisionSnapshot): EventInput
}

export interface DecisionSource {
  readonly permission?: true
  readonly owner: string
  readonly operationId: string
  readonly sourcePackage: string
  readonly packageVersion: string
  alive(): void
}
/** Supplied only by the authenticated backend ingress, never by an author or answer body. */
export interface DecisionAnswerContext {
  readonly actor: Actor
  readonly category: 'human'
  authorize(snapshot: DecisionSnapshot): void | Promise<void>
}
function fail(message: string): never {
  throw new CoreError('E_RELATION', `DECISION_${message}`, {
    reason: message.toLowerCase().replaceAll('_', '-'),
  })
}
const detached = <T>(value: T): T => structuredClone(value)

/** Shares the session's writer gate with phase transitions, stop and checkpoints. */
export class DecisionCommands {
  private get timers() {
    return (
      this.s.timers ?? {
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      }
    )
  }
  private readonly waiters = new Set<() => void>()
  private readonly automaticSkips = new Set<string>()
  /** Decision waits in flight; a run blocked on one is waiting on a person, not stuck. */
  get waiting(): number {
    return this.waiters.size
  }
  private epoch = { alive: true }
  private readonly requestEpochs = new Map<string, { alive: boolean }>()
  constructor(private readonly s: DecisionAuthority) {}
  get scopeRevoked(): boolean {
    return !this.epoch.alive
  }
  revokeScope(): void {
    this.epoch.alive = false
  }
  renewScope(): void {
    this.epoch = { alive: true }
  }
  bindSource(source: DecisionSource): DecisionSource {
    const epoch = this.epoch
    return {
      ...source,
      alive() {
        if (!epoch.alive) fail('STOPPED')
        source.alive()
      },
    }
  }
  private execution(id?: string): void {
    if (!this.epoch.alive || (id && this.requestEpochs.get(id)?.alive === false)) fail('STOPPED')
  }
  detach(): void {
    for (const end of this.waiters) end()
  }
  private live(source?: DecisionSource): void {
    if (this.s.closed) throw new CoreError('E_CLOSED', 'Session closed')
    source?.alive()
  }
  private owns(handle: DecisionHandle): boolean {
    return this.s.profileId !== undefined
      ? handle.sessionId === null && handle.profileId === this.s.profileId
      : handle.sessionId === this.s.key && handle.profileId == null
  }
  private read(handle: DecisionHandle, source?: DecisionSource): DecisionSnapshot {
    const checked = inspectJsonData(handle, 4096)
    if (!checked.ok || !validateAgainst(HandleSchema, checked.value).ok) fail('HANDLE')
    if (!this.owns(handle)) fail('SCOPE')
    const value = this.s.readDecisions().get(handle.id)?.value
    if (!value || !this.owns(value.handle) || value.request.lane !== this.s.lane) fail('NOT_FOUND')
    if (
      source &&
      (value.request.owner !== source.owner ||
        value.request.sourcePackage !== source.sourcePackage ||
        value.request.packageVersion !== source.packageVersion)
    )
      fail('SOURCE_CHANGED')
    return value
  }
  private event(value: DecisionSnapshot): EventInput {
    return this.s.event(value)
  }
  private async attesting<T>(work: () => Promise<T>): Promise<T> {
    await this.s.beforeAttestation?.()
    return this.s.transact(work)
  }
  private automaticAnswer(spec: DecisionSpec, permission: boolean) {
    if (this.s.refuseApprovals) return undefined
    return automaticPermissionDecision(
      this.s.permissionContext,
      spec.purpose,
      spec.options,
      permission ? 'permission' : 'question',
      spec.presentation,
    )
  }
  private async write(
    value: DecisionSnapshot,
    recheck: () => void | Promise<void> = () => undefined,
    executionCheck: () => void = () => undefined,
    initial?: DecisionSnapshot,
  ): Promise<void> {
    const cell = this.s.readDecisions().get(value.handle.id)
    const event = this.event(value)
    const { register: _register, ...checkpoint } = event
    await this.s.log.append(
      [
        ...(initial ? [this.event(initial)] : []),
        event,
        ...(value.consumption && !cell?.value.consumption
          ? [
              {
                ...checkpoint,
                type: 'x/core/decision-checkpoint',
                data: { handle: value.handle, operationId: value.request.operationId },
                ignorable: true as const,
              },
            ]
          : []),
      ],
      {
        beforeFullVerify: 'refuse',
        expectedRegisterSeq: { register: 'decision/state', key: value.handle.id, seq: cell?.seq ?? null },
        beforeCommit: recheck,
        commitCheck: () => {
          executionCheck()
          if (
            !value.invalidation &&
            value.result?.reason === 'answered' &&
            value.result.code === 'full-access'
          )
            this.checkAuthorization(value)
          if (
            !value.invalidation &&
            (value.result?.reason === 'answered' || value.consumption) &&
            this.due(value)
          )
            fail('DEADLINE')
          if (value.result?.reason === 'answered' && !value.invalidation && this.s.cancelled) fail('STOPPED')
        },
      },
    )
  }
  private async automatic(value: DecisionSnapshot, source?: DecisionSource): Promise<DecisionSnapshot> {
    if (this.s.historyVerified?.() === false) return value
    if (value.result || value.invalidation || value.consumption || this.s.cancelled || this.due(value))
      return value
    const answer = this.automaticAnswer(value.request.spec, value.request.category === 'permission')
    if (!answer) {
      await this.recordAutomaticSkip(value, 'ambiguous-business-confirmation', source)
      return value
    }
    if (
      value.request.spec.responseSchema &&
      compilePluginConfig(value.request.spec.responseSchema)(answer.responseValue ?? null).length
    ) {
      if (value.request.spec.purpose !== 'business.confirm') fail('RESPONSE_SCHEMA')
      await this.recordAutomaticSkip(value, 'response-schema', source)
      return value
    }
    const next: DecisionSnapshot = {
      ...value,
      revision: value.revision + 1,
      result: {
        reason: 'answered',
        code: answer.reason,
        authorization: this.authorizationBinding(),
        at: new Date(this.s.clock()).toISOString(),
        response: { option: answer.verdict, value: answer.responseValue ?? null },
        answeredBy: answer.answeredBy,
      },
    }
    await this.write(
      next,
      () => this.live(source),
      () => {
        this.live(source)
        this.execution(value.handle.id)
      },
    )
    return next
  }
  private async recordAutomaticSkip(value: DecisionSnapshot, reason: string, source?: DecisionSource) {
    const context = this.s.permissionContext
    if (context?.policy !== 'full-access' || value.request.spec.purpose !== 'business.confirm') return
    const key = `${context.sessionId}:${context.epoch}:${value.handle.id}`
    if (this.automaticSkips.has(key)) return
    const { register: _register, ...event } = this.event(value)
    await this.s.log.append(
      [
        {
          ...event,
          type: 'x/core/decision-automatic-skipped',
          ignorable: true,
          data: { decisionId: value.handle.id, subjectDigest: value.request.subjectDigest, reason },
        },
      ],
      {
        beforeCommit: () => this.live(source),
        commitCheck: () => {
          this.live(source)
          this.execution(value.handle.id)
        },
      },
    )
    this.automaticSkips.add(key)
  }
  private authorizationBinding() {
    const context = this.s.permissionContext
    if (!context) fail('AUTHORITY_REVOKED')
    return { sessionId: context.sessionId, epoch: context.epoch }
  }
  private checkAuthorization(value: DecisionSnapshot): void {
    if (value.result?.reason !== 'answered' || value.result.code !== 'full-access') return
    const current = this.s.permissionContext,
      binding = value.result.authorization
    if (
      !current ||
      current.policy !== 'full-access' ||
      !binding ||
      binding.sessionId !== current.sessionId ||
      binding.epoch !== current.epoch
    )
      fail('AUTHORITY_REVOKED')
  }
  /** Called under the preset writer gate. History of consumed effects remains immutable. */
  revokedAutomaticEvents(): EventInput[] {
    return [...this.s.readDecisions().values()].flatMap(({ value }) => {
      if (
        !this.owns(value.handle) ||
        value.request.lane !== this.s.lane ||
        value.result?.reason !== 'answered' ||
        value.result.code !== 'full-access' ||
        value.consumption ||
        value.invalidation
      )
        return []
      try {
        this.checkAuthorization(value)
        return []
      } catch {
        return [
          this.event({
            ...value,
            revision: value.revision + 1,
            invalidation: { at: new Date(this.s.clock()).toISOString(), code: 'authorization-revoked' },
          }),
        ]
      }
    })
  }
  private due(value: DecisionSnapshot): boolean {
    return value.request.expiresAt !== null && this.s.clock() >= Date.parse(value.request.expiresAt)
  }
  private async expire(value: DecisionSnapshot, source?: DecisionSource): Promise<DecisionSnapshot> {
    if (
      !value.consumption &&
      !value.invalidation &&
      value.result?.reason === 'answered' &&
      value.result.code === 'full-access'
    ) {
      try {
        this.checkAuthorization(value)
      } catch {
        const next = {
          ...value,
          revision: value.revision + 1,
          invalidation: { at: new Date(this.s.clock()).toISOString(), code: 'authorization-revoked' },
        }
        await this.write(next, () => this.live(source))
        return next
      }
    }
    if (
      !this.due(value) ||
      value.consumption ||
      value.invalidation ||
      (value.result && value.result.reason !== 'answered')
    )
      return value
    const at = new Date(this.s.clock()).toISOString()
    const next: DecisionSnapshot = {
      ...value,
      revision: value.revision + 1,
      ...(value.result
        ? { invalidation: { at, code: 'deadline' } }
        : { result: { reason: 'expired', at, code: 'deadline' } }),
    }
    await this.write(
      next,
      () => this.live(source),
      () => this.live(source),
    )
    return next
  }
  port(input: DecisionSource): DecisionPort {
    const source = this.bindSource(input)
    return Object.freeze({
      request: (spec: DecisionSpec) => this.request(spec, source),
      get: (handle: DecisionHandle) => this.get(handle, source),
      wait: (handle: DecisionHandle, options?: { readonly signal?: AbortSignal }) =>
        this.wait(handle, source, options?.signal),
      admit: (handle: DecisionHandle) => this.admit(handle, source),
    })
  }
  private async request(input: DecisionSpec, source: DecisionSource): Promise<DecisionHandle> {
    const json = inspectJsonData(input, 131072)
    if (!json.ok) return Promise.reject(new CoreError('E_ENVELOPE', 'Decision spec must be bounded JSON'))
    if (!validateAgainst<DecisionSpec>(SpecSchema, json.value).ok)
      return Promise.reject(new CoreError('E_ENVELOPE', 'Invalid decision spec'))
    const spec = json.value as DecisionSpec
    if (spec.responseSchema) {
      if (!inspectJsonData(spec.responseSchema, 32768).ok) fail('SCHEMA_SIZE')
      compilePluginConfig(spec.responseSchema)
    }
    if (!this.s.refuseApprovals && this.automaticAnswer(spec, source.permission === true))
      await this.s.beforeAttestation?.()
    return this.s.transact(async () => {
      this.live(source)
      this.execution()
      if (this.s.cancelled) fail('STOPPED')
      const existing = [...this.s.readDecisions().values()].find(
        ({ value }) =>
          this.owns(value.handle) &&
          value.request.owner === source.owner &&
          value.request.spec.key === spec.key,
      )
      if (existing) {
        if (
          existing.value.request.operationId !== source.operationId ||
          canonicalJson(existing.value.request.spec) !== canonicalJson(spec)
        )
          fail('KEY_CONFLICT')
        this.read(existing.value.handle, source)
        await this.automatic(await this.expire(existing.value, source), source)
        return detached(existing.value.handle)
      }
      const now = this.s.clock()
      const handle: DecisionHandle =
        this.s.profileId === undefined
          ? { id: this.s.id(), sessionId: this.s.key }
          : { id: this.s.id(), sessionId: null, profileId: this.s.profileId }
      const value: DecisionSnapshot = {
        handle,
        revision: 1,
        request: {
          spec,
          ...(source.permission && isPermissionPurpose(spec.purpose)
            ? { category: 'permission' as const }
            : {}),
          subjectDigest: decisionSubjectDigest(spec.subject),
          owner: source.owner,
          operationId: source.operationId,
          sourcePackage: source.sourcePackage,
          packageVersion: source.packageVersion,
          requestedBy: detached(this.s.actor),
          lane: this.s.lane,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + this.s.ttlMs).toISOString(),
        },
        result: null,
        answerCommand: null,
        consumption: null,
        invalidation: null,
      }
      const refused = delegatedDecisionRefused(this.s, source, spec)
      // Persist request and refusal in one commit, following the existing decision transition contract.
      const initial = refused ? detached(value) : undefined
      if (refused) {
        value.revision = 2
        value.result = {
          reason: 'unavailable',
          code: 'delegated-approval-refused',
          at: new Date(now).toISOString(),
        }
      }
      const automatic = this.s.refuseApprovals
        ? undefined
        : this.automaticAnswer(spec, source.permission === true)
      if (
        automatic &&
        spec.purpose !== 'business.confirm' &&
        spec.responseSchema &&
        compilePluginConfig(spec.responseSchema)(null).length
      )
        fail('RESPONSE_SCHEMA')
      if (
        automatic &&
        !(
          spec.responseSchema &&
          compilePluginConfig(spec.responseSchema)(automatic.responseValue ?? null).length
        )
      ) {
        value.result = {
          reason: 'answered',
          code: automatic.reason,
          authorization: this.authorizationBinding(),
          at: new Date(now).toISOString(),
          response: { option: automatic.verdict, value: automatic.responseValue ?? null },
          answeredBy: automatic.answeredBy,
        }
      }
      await this.write(
        value,
        () => this.live(source),
        () => {
          this.live(source)
          this.execution()
        },
        initial,
      )
      if (!value.result)
        await this.recordAutomaticSkip(
          value,
          automatic ? 'response-schema' : 'ambiguous-business-confirmation',
          source,
        )
      this.requestEpochs.set(handle.id, this.epoch)
      return detached(handle)
    })
  }
  /** One decision, one consumption, and a private lease checked inside the effect transaction. */
  private async admit(handle: DecisionHandle, source: DecisionSource) {
    await this.s.beforeAttestation?.()
    const context = this.s.permissionContext
    const value = await this.s.transact(async () => {
      this.live(source)
      const value = await this.expire(this.read(handle, source), source)
      if (value.result?.reason !== 'answered' || value.result.response.option !== 'allowed-once')
        fail('NOT_CONSUMABLE')
      this.consumptionEvents([handle], source, null)
      const consumed: DecisionSnapshot = {
        ...value,
        revision: value.revision + 1,
        consumption: {
          at: new Date(this.s.clock()).toISOString(),
          operationId: source.operationId,
          effectId: null,
        },
      }
      // The normal write path rechecks epoch, deadline and cancellation at the ledger commit.
      await this.write(
        consumed,
        () => this.live(source),
        () => {
          this.live(source)
          this.execution(handle.id)
        },
      )
      return value
    })
    const admission = permissionEffectAdmission({
      unavailable: () =>
        new CoreError('E_RELATION', 'DECISION_AUTHORITY_REVOKED', { reason: 'authority-revoked' }),
      verify: () => this.s.log.claimLease(),
      clock: () => this.s.clock(),
      ...(value.request.expiresAt !== null ? { expiresAt: Date.parse(value.request.expiresAt) } : {}),
      ...(value.result?.reason === 'answered' && value.result.code === 'full-access' && context
        ? { context: { expected: context, current: () => this.s.permissionContext } }
        : {}),
      assertBound: () => {
        this.live(source)
        this.execution(handle.id)
        const current = this.read(handle, source)
        this.checkAuthorization(current)
        if (
          this.s.log.faulted ||
          this.s.log.leaseRemainingMs() <= 0 ||
          this.s.cancelled ||
          this.due(current) ||
          current.invalidation ||
          !current.consumption ||
          canonicalJson(current.result) !== canonicalJson(value.result)
        )
          fail('AUTHORITY_REVOKED')
      },
    })
    admission.assertActive()
    return admission
  }

  /** Backend withdrawal never manufactures a human refusal or effect receipt. */
  withdraw(handle: DecisionHandle, source: DecisionSource, code: string): Promise<DecisionSnapshot> {
    return this.s.transact(async () => {
      this.live()
      const value = await this.expire(this.read(handle, source))
      if (value.consumption || value.invalidation || (value.result && value.result.reason !== 'answered'))
        return detached(value)
      const at = new Date(this.s.clock()).toISOString()
      const next: DecisionSnapshot = {
        ...value,
        revision: value.revision + 1,
        ...(value.result
          ? { invalidation: { at, code } }
          : { result: { reason: code === 'stopped' ? 'stopped' : 'unavailable', at, code } }),
      }
      await this.write(next)
      return detached(next)
    })
  }
  /**
   * Ends a session-wide allowance. Its decision was consumed by the call it was first given for,
   * so this is the one invalidation written after consumption: the grant is what is withdrawn,
   * and the call that already ran keeps its receipt.
   */
  revokeSessionGrant(id: string): Promise<boolean> {
    return this.s.transact(async () => {
      this.live()
      const value = this.s.readDecisions().get(id)?.value
      if (
        !value?.consumption ||
        value.invalidation ||
        value.request.lane !== this.s.lane ||
        value.result?.reason !== 'answered' ||
        value.result.response.option !== 'allowed-session'
      )
        return false
      const at = new Date(this.s.clock()).toISOString()
      await this.write({
        ...value,
        revision: value.revision + 1,
        invalidation: { at, code: 'grant-revoked' },
      })
      return true
    })
  }
  async get(handle: DecisionHandle, source?: DecisionSource): Promise<DecisionSnapshot> {
    const pending = this.read(handle, source)
    // Restored answers can authorize effects; wait before taking the shared writer gate.
    if (
      !pending.invalidation &&
      !pending.consumption &&
      (pending.result?.reason === 'answered' ||
        (!pending.result &&
          this.automaticAnswer(pending.request.spec, pending.request.category === 'permission')))
    )
      await this.s.beforeAttestation?.()
    return this.s.transact(async () => {
      this.live()
      return detached(await this.automatic(await this.expire(this.read(handle, source), source), source))
    })
  }
  async list(): Promise<DecisionSnapshot[]> {
    return this.s.transact(async () => {
      this.live()
      const values: DecisionSnapshot[] = []
      for (const { value } of this.s.readDecisions().values()) {
        if (this.owns(value.handle) && value.request.lane === this.s.lane)
          values.push(detached(await this.automatic(await this.expire(value))))
      }
      return values
    })
  }
  answer(
    input: { handle: DecisionHandle; revision: number; commandId: string; response: DecisionResponse },
    context: DecisionAnswerContext,
  ): Promise<DecisionCommandReceipt> {
    const json = inspectJsonData(input, 65536)
    if (!json.ok) fail('INVALID_ANSWER')
    const command = json.value as typeof input
    if (
      !command.commandId ||
      command.commandId.length > 256 ||
      command.commandId.includes('\0') ||
      !Number.isSafeInteger(command.revision) ||
      !validateAgainst(ResponseSchema, command.response).ok
    )
      fail('INVALID_ANSWER')
    const digest = sha256Hex(canonicalJson(command))
    return this.attesting(async () => {
      this.live()
      const original = this.read(command.handle)
      await context.authorize(detached(original))
      if (!humanDecisionActorAllowed(this.s, context)) fail('HUMAN_REQUIRED')
      if (original.answerCommand?.commandId === command.commandId) {
        if (original.answerCommand.digest !== digest) fail('COMMAND_CONFLICT')
        return detached(original.answerCommand)
      }
      const value = await this.expire(original)
      if (!value.result && !value.invalidation) this.execution(value.handle.id)
      if (this.s.cancelled || value.result || value.invalidation || value.consumption) fail('NOT_PENDING')
      if (value.revision !== command.revision) throw new CoreError('E_CAS', 'Decision revision changed')
      if (!value.request.spec.options.includes(command.response.option)) fail('UNOFFERED_ANSWER')
      if (
        value.request.spec.responseSchema &&
        compilePluginConfig(value.request.spec.responseSchema)(command.response.value).length
      )
        fail('RESPONSE_SCHEMA')
      const receipt = {
        commandId: command.commandId,
        digest,
        revision: value.revision + 1,
        seq: this.s.lastSeq + 1,
      }
      await this.write(
        {
          ...value,
          revision: receipt.revision,
          answerCommand: receipt,
          result: {
            reason: 'answered',
            at: new Date(this.s.clock()).toISOString(),
            response: command.response,
            answeredBy: detached(context.actor),
          },
        },
        async () => {
          this.live()
          await context.authorize(detached(this.read(command.handle)))
          this.live()
          this.execution(command.handle.id)
        },
        () => {
          this.live()
          this.execution(command.handle.id)
        },
      )
      return detached(receipt)
    })
  }
  stop(): Promise<void> {
    this.revokeScope()
    return this.s.transact(async () => {
      const events = this.stoppedEvents()
      if (events.length) await this.s.log.append(events)
    })
  }
  /** Called inside the same writer lock as the operation's cancellation transition. */
  stoppedEvents(): EventInput[] {
    const at = new Date(this.s.clock()).toISOString()
    return [...this.s.readDecisions().values()].flatMap(({ value }) => {
      if (
        !this.owns(value.handle) ||
        value.request.lane !== this.s.lane ||
        value.consumption ||
        value.invalidation ||
        (value.result && value.result.reason !== 'answered')
      )
        return []
      return [
        this.event({
          ...value,
          revision: value.revision + 1,
          ...(value.result
            ? { invalidation: { at, code: 'stopped' } }
            : { result: { reason: 'stopped', at, code: 'stopped' } }),
        }),
      ]
    })
  }
  /**
   * `withdraw` as rows, for a caller that closes the requesting operation in the same commit. Called
   * inside the writer lock; a decision already closed is left as it is.
   */
  withdrawnEvents(handles: readonly DecisionHandle[], code: string): EventInput[] {
    const at = new Date(this.s.clock()).toISOString()
    return handles.flatMap((handle) => {
      const value = this.s.readDecisions().get(handle.id)?.value
      if (
        !value ||
        !this.owns(value.handle) ||
        value.request.lane !== this.s.lane ||
        value.consumption ||
        value.invalidation ||
        (value.result && value.result.reason !== 'answered')
      )
        return []
      return [
        this.event({
          ...value,
          revision: value.revision + 1,
          ...(value.result
            ? { invalidation: { at, code } }
            : { result: { reason: 'unavailable', at, code } }),
        }),
      ]
    })
  }
  /** Backend-only: callers append these rows beside the original effect intent or next checkpoint. */
  consumptionEvents(
    handles: readonly DecisionHandle[],
    source: DecisionSource,
    effectId: string | null,
  ): EventInput[] {
    if (handles.length === 0) return []
    if (this.s.historyVerified?.() === false)
      throw new CoreError('E_LANE_BUSY', 'verifying history; retry decision consumption after verification')
    this.live(source)
    this.execution()
    if (this.s.cancelled) fail('STOPPED')
    if (new Set(handles.map((h) => h.id)).size !== handles.length) fail('DUPLICATE_REF')
    return handles.map((handle) => {
      const value = this.read(handle, source)
      this.checkAuthorization(value)
      if (value.consumption || value.invalidation || this.due(value) || value.result?.reason !== 'answered')
        fail('NOT_CONSUMABLE')
      if (value.request.operationId !== source.operationId) fail('OPERATION_CHANGED')
      return this.event({
        ...value,
        revision: value.revision + 1,
        consumption: {
          at: new Date(this.s.clock()).toISOString(),
          operationId: source.operationId,
          effectId,
        },
      })
    })
  }
  private async wait(
    handle: DecisionHandle,
    source: DecisionSource,
    signal?: AbortSignal,
  ): Promise<DecisionWaitResult> {
    this.live(source)
    let wake: () => void = () => undefined
    let timer: unknown
    let ended = signal?.aborted === true
    const end = () => {
      ended = true
      wake()
    }
    const off = this.s.log.observeCommitted(['decision/state'], () => wake())
    this.waiters.add(end)
    signal?.addEventListener('abort', end, { once: true })
    try {
      for (;;) {
        let notify!: () => void
        const changed = new Promise<void>((resolve) => {
          notify = resolve
        })
        wake = notify
        if (ended) return { status: 'pending', handle: detached(handle), waitEndedBy: 'detached' }
        const value = await this.get(handle, source)
        if (value.result?.code === 'delegated-approval-refused')
          throw new CoreError('E_UNSUPPORTED', ROLE_APPROVAL_REFUSAL)
        if (value.result || value.invalidation) return { status: 'resolved', snapshot: value }
        if (ended) return { status: 'pending', handle: detached(handle), waitEndedBy: 'detached' }
        if (value.request.expiresAt !== null)
          timer = this.timers.setTimeout(
            notify,
            Math.min(2147483647, Math.max(0, Date.parse(value.request.expiresAt) - this.s.clock())),
          )
        await changed
        if (timer !== undefined) {
          this.timers.clearTimeout(timer)
          timer = undefined
        }
      }
    } finally {
      if (timer !== undefined) this.timers.clearTimeout(timer)
      off()
      this.waiters.delete(end)
      signal?.removeEventListener('abort', end)
    }
  }
}
