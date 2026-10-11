import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { CoreError, type EventInput } from '@agnes/core-common/types'
import { decisionSubjectDigest } from '@agnes/core-ledger'
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
import type { SessionImpl } from './session.js'

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
      this.s.d.timers ?? {
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      }
    )
  }
  private readonly waiters = new Set<() => void>()
  constructor(private readonly s: SessionImpl) {}
  detach(): void {
    for (const end of this.waiters) end()
  }
  private live(source?: DecisionSource): void {
    if (this.s.closingOrClosed || this.s.d.log.isClosed) throw new CoreError('E_CLOSED', 'Session closed')
    source?.alive()
  }
  private read(handle: DecisionHandle, source?: DecisionSource): DecisionSnapshot {
    const checked = inspectJsonData(handle, 4096)
    if (!checked.ok || !validateAgainst(HandleSchema, checked.value).ok) fail('HANDLE')
    if (handle.sessionId !== this.s.key) fail('SCOPE')
    const value = this.s.state.registers.decisionStates.get(handle.id)?.value
    if (!value || value.handle.sessionId !== this.s.key || value.request.lane !== this.s.lane)
      fail('NOT_FOUND')
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
    return this.s.ev('decision/state', value, { register: 'decision/state' })
  }
  private async write(
    value: DecisionSnapshot,
    recheck: () => void | Promise<void> = () => undefined,
  ): Promise<void> {
    const cell = this.s.state.registers.decisionStates.get(value.handle.id)
    await this.s.d.log.append([this.event(value)], {
      expectedRegisterSeq: { register: 'decision/state', key: value.handle.id, seq: cell?.seq ?? null },
      beforeCommit: async () => {
        await recheck()
        if (
          !value.invalidation &&
          (value.result?.reason === 'answered' || value.consumption) &&
          this.due(value)
        )
          fail('DEADLINE')
        if (
          value.result?.reason === 'answered' &&
          !value.invalidation &&
          this.s.op()?.control.status === 'cancel_requested'
        )
          fail('STOPPED')
      },
    })
  }
  private due(value: DecisionSnapshot): boolean {
    return value.request.expiresAt !== null && this.s.d.clock() >= Date.parse(value.request.expiresAt)
  }
  private async expire(value: DecisionSnapshot): Promise<DecisionSnapshot> {
    if (
      !this.due(value) ||
      value.consumption ||
      value.invalidation ||
      (value.result && value.result.reason !== 'answered')
    )
      return value
    const at = new Date(this.s.d.clock()).toISOString()
    const next: DecisionSnapshot = {
      ...value,
      revision: value.revision + 1,
      ...(value.result
        ? { invalidation: { at, code: 'deadline' } }
        : { result: { reason: 'expired', at, code: 'deadline' } }),
    }
    await this.write(next)
    return next
  }
  port(source: DecisionSource): DecisionPort {
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
    return this.s.locked(async () => {
      this.live(source)
      if (this.s.op()?.control.status === 'cancel_requested') fail('STOPPED')
      const existing = [...this.s.state.registers.decisionStates.values()].find(
        ({ value }) =>
          value.handle.sessionId === this.s.key &&
          value.request.owner === source.owner &&
          value.request.spec.key === spec.key,
      )
      if (existing) {
        if (canonicalJson(existing.value.request.spec) !== canonicalJson(spec)) fail('KEY_CONFLICT')
        this.read(existing.value.handle, source)
        await this.expire(existing.value)
        return detached(existing.value.handle)
      }
      const now = this.s.d.clock()
      const handle = { id: this.s.d.ids.ulid(), sessionId: this.s.key }
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
          requestedBy: detached(this.s.d.actor),
          lane: this.s.lane,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + this.s.preset.approval.pendingTtlMs).toISOString(),
        },
        result: null,
        answerCommand: null,
        consumption: null,
        invalidation: null,
      }
      await this.write(value, () => this.live(source))
      return detached(handle)
    })
  }
  get(handle: DecisionHandle, source?: DecisionSource): Promise<DecisionSnapshot> {
    return this.s.locked(async () => {
      this.live(source)
      return detached(await this.expire(this.read(handle, source)))
    })
  }
  async list(): Promise<DecisionSnapshot[]> {
    return this.s.locked(async () => {
      this.live()
      const values: DecisionSnapshot[] = []
      for (const { value } of this.s.state.registers.decisionStates.values()) {
        if (value.handle.sessionId === this.s.key && value.request.lane === this.s.lane)
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
    return this.s.locked(async () => {
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
      if (
        this.s.op()?.control.status === 'cancel_requested' ||
        value.result ||
        value.invalidation ||
        value.consumption
      )
        fail('NOT_PENDING')
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
            at: new Date(this.s.d.clock()).toISOString(),
            response: command.response,
            answeredBy: detached(context.actor),
          },
        },
        async () => {
          this.live()
          await context.authorize(detached(this.read(command.handle)))
          this.live()
        },
      )
      return detached(receipt)
    })
  }
  stop(): Promise<void> {
    return this.s.locked(async () => {
      const events = this.stoppedEvents()
      if (events.length) await this.s.d.log.append(events)
    })
  }
  /** Called inside the same writer lock as the operation's cancellation transition. */
  stoppedEvents(): EventInput[] {
    const at = new Date(this.s.d.clock()).toISOString()
    return [...this.s.state.registers.decisionStates.values()].flatMap(({ value }) => {
      if (
        value.handle.sessionId !== this.s.key ||
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
    if (this.s.op()?.control.status === 'cancel_requested') fail('STOPPED')
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
          at: new Date(this.s.d.clock()).toISOString(),
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
    const off = this.s.d.log.observeCommitted(['decision/state'], () => wake())
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
            Math.min(2147483647, Math.max(0, Date.parse(value.request.expiresAt) - this.s.d.clock())),
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
