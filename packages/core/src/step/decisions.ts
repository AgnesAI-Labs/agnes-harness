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
  compilePluginConfig,
  type DecisionCommandReceipt,
  type DecisionResponse,
  inspectJsonData,
  validateActor,
  validateAgainst,
} from '@agnes/protocol'
import {
  DecisionHandle as HandleSchema,
  DecisionResponse as ResponseSchema,
  DecisionSpec as SpecSchema,
} from '@agnes/protocol/gen/session-v1'

/** Minimal authority needed by the decision commands; the session supplies the writer gate. */
export interface DecisionAuthority {
  readonly key: string
  /** A profile journal uses AR1 without creating a session or granting session access. */
  readonly profileId?: string
  readonly lane: string
  readonly lastSeq: Seq
  readonly closed: boolean
  readonly cancelled: boolean
  readonly actor: Actor
  readonly ttlMs: number
  readonly timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }
  readonly log: Pick<SessionLogImpl, 'append' | 'observeCommitted'>
  readDecisions(): ReadonlyMap<string, { value: DecisionSnapshot; seq: Seq }>
  clock(): number
  id(): string
  transact<T>(work: () => Promise<T>): Promise<T>
  event(value: DecisionSnapshot): EventInput
}

export interface DecisionSource {
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
  throw new CoreError('E_RELATION', `DECISION_${message}`)
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
  private async write(
    value: DecisionSnapshot,
    recheck: () => void | Promise<void> = () => undefined,
    executionCheck: () => void = () => undefined,
  ): Promise<void> {
    const cell = this.s.readDecisions().get(value.handle.id)
    await this.s.log.append([this.event(value)], {
      expectedRegisterSeq: { register: 'decision/state', key: value.handle.id, seq: cell?.seq ?? null },
      beforeCommit: recheck,
      commitCheck: () => {
        executionCheck()
        if (
          !value.invalidation &&
          (value.result?.reason === 'answered' || value.consumption) &&
          this.due(value)
        )
          fail('DEADLINE')
        if (value.result?.reason === 'answered' && !value.invalidation && this.s.cancelled) fail('STOPPED')
      },
    })
  }
  private due(value: DecisionSnapshot): boolean {
    return value.request.expiresAt !== null && this.s.clock() >= Date.parse(value.request.expiresAt)
  }
  private async expire(value: DecisionSnapshot, source?: DecisionSource): Promise<DecisionSnapshot> {
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
    })
  }
  private request(input: DecisionSpec, source: DecisionSource): Promise<DecisionHandle> {
    const json = inspectJsonData(input, 131072)
    if (!json.ok) return Promise.reject(new CoreError('E_ENVELOPE', 'Decision spec must be bounded JSON'))
    if (!validateAgainst<DecisionSpec>(SpecSchema, json.value).ok)
      return Promise.reject(new CoreError('E_ENVELOPE', 'Invalid decision spec'))
    const spec = json.value as DecisionSpec
    if (spec.responseSchema) {
      if (!inspectJsonData(spec.responseSchema, 32768).ok) fail('SCHEMA_SIZE')
      compilePluginConfig(spec.responseSchema)
    }
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
        await this.expire(existing.value, source)
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
      await this.write(
        value,
        () => this.live(source),
        () => {
          this.live(source)
          this.execution()
        },
      )
      this.requestEpochs.set(handle.id, this.epoch)
      return detached(handle)
    })
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
  get(handle: DecisionHandle, source?: DecisionSource): Promise<DecisionSnapshot> {
    return this.s.transact(async () => {
      this.live()
      return detached(await this.expire(this.read(handle, source), source))
    })
  }
  async list(): Promise<DecisionSnapshot[]> {
    return this.s.transact(async () => {
      this.live()
      const values: DecisionSnapshot[] = []
      for (const { value } of this.s.readDecisions().values()) {
        if (this.owns(value.handle) && value.request.lane === this.s.lane)
          values.push(detached(await this.expire(value)))
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
    return this.s.transact(async () => {
      this.live()
      const original = this.read(command.handle)
      await context.authorize(detached(original))
      if (!validateActor(context.actor).ok || context.category !== 'human' || context.actor.role === 'agent')
        fail('HUMAN_REQUIRED')
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
  /** Backend-only: callers append these rows beside the original effect intent or next checkpoint. */
  consumptionEvents(
    handles: readonly DecisionHandle[],
    source: DecisionSource,
    effectId: string | null,
  ): EventInput[] {
    if (handles.length === 0) return []
    this.live(source)
    this.execution()
    if (this.s.cancelled) fail('STOPPED')
    if (new Set(handles.map((h) => h.id)).size !== handles.length) fail('DUPLICATE_REF')
    return handles.map((handle) => {
      const value = this.read(handle, source)
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
