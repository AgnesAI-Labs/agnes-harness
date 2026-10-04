import { randomUUID } from 'node:crypto'
import {
  managedHumanWaitSignal,
  type SessionImpl,
  type ToolQuestionsInvocation,
  withManagedHumanWait,
} from '@agnes/core'
import {
  type Actor,
  inspectJsonData,
  jcs,
  type QuestionAnswer,
  type QuestionAnswerPolicy,
  type QuestionInteraction,
  type QuestionRequestedData,
  type QuestionResolution,
  type QuestionSettledData,
  type QuestionValidationError,
  validateQuestionAnswer,
  validateQuestionRequest,
} from '@agnes/protocol'

export type QuestionProviderIdentity = {
  sessionKey: string
  writerRunId: string
  generation: number
  toolUseId: string
  turn: number
  callSeq: number
}
export type QuestionProvider = (
  identity: QuestionProviderIdentity,
  signal: AbortSignal,
) => Promise<QuestionAnswerPolicy>
export type QuestionServiceErrorCode =
  | 'NO_PROVIDER'
  | 'CALLER_NOT_LIVE'
  | 'DELEGATED_CALLER'
  | 'INVALID_QUESTION_REQUEST'
  | 'INVALID_QUESTION_ANSWER'
  | 'QUESTION_NOT_LIVE'
  | 'QUESTION_CONFLICT'
  | 'ASK_ABORTED'
  | 'ASK_CANCELLED'
  | 'E_STORAGE_FAULT'

/** Fixed diagnostic codes; no question, answer or transport error content is exposed. */
export class QuestionServiceError extends Error {
  constructor(
    readonly code: QuestionServiceErrorCode,
    readonly validation?: readonly QuestionValidationError[],
  ) {
    super(code)
    this.name = 'QuestionServiceError'
  }
}

type Entry = {
  interaction: QuestionInteraction
  wait: Promise<QuestionAnswer>
  resolve: (answer: QuestionAnswer) => void
  reject: (error: unknown) => void
  claim?: { status: QuestionResolution['status']; answer?: QuestionAnswer }
  settlement?: Promise<QuestionResolution>
}
type Owner = {
  session: SessionImpl
  abort: AbortController
  flows: Set<Promise<unknown>>
  entries: Map<string, Entry>
  faults: unknown[]
}

type QuestionCancellationReceipt = {
  session: SessionImpl
  writerRunId: string
  lane: string
  toolUseId: string
  turn: number
  interactionId: string
  callSeq: number
  requestedSeq: number
  settledSeq: number
}
// Public errors and error codes are not evidence. Only the exact error rejected after a successful
// owner append carries this private receipt, and it cannot transfer to another live session/call.
const cancellations = new WeakMap<object, QuestionCancellationReceipt>()
export function readQuestionCancellation(
  error: unknown,
  session: SessionImpl,
  toolUseId: string,
): Omit<QuestionCancellationReceipt, 'session'> | undefined {
  if (!(error instanceof QuestionServiceError)) return undefined
  const receipt = cancellations.get(error)
  if (
    !receipt ||
    receipt.session !== session ||
    receipt.writerRunId !== session.writerRunId ||
    receipt.lane !== session.lane ||
    receipt.toolUseId !== toolUseId ||
    session.state.toolCalls.get(toolUseId)?.seq !== receipt.callSeq ||
    session.state.toolCalls.get(toolUseId)?.turn !== receipt.turn
  )
    return undefined
  const { session: _session, ...evidence } = receipt
  return { ...evidence }
}

function aborted(): QuestionServiceError {
  return new QuestionServiceError('ASK_ABORTED')
}

/** Await external preparation without allowing a provider that ignores abort to block owner close. */
function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(aborted())
    if (signal.aborted) reject(aborted())
    else signal.addEventListener('abort', abort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => undefined)
  })
}

/** Session-bound owner service. Daemon and clients route requests; only this writer adopts answers. */
export class HostQuestions {
  private readonly owners = new WeakMap<SessionImpl, Owner>()

  constructor(
    private readonly current: (sessionKey: string) => SessionImpl | undefined,
    private readonly provider?: QuestionProvider,
  ) {}

  ask(session: SessionImpl, invocation: ToolQuestionsInvocation): Promise<QuestionAnswer> {
    this.assertLive(session)
    if (session.d.runtimeOwnerSessionKey) throw new QuestionServiceError('DELEGATED_CALLER')
    let owner = this.owners.get(session)
    if (!owner) {
      owner = { session, abort: new AbortController(), flows: new Set(), entries: new Map(), faults: [] }
      this.owners.set(session, owner)
    }
    if (owner.abort.signal.aborted) throw aborted()
    const flow = this.prepare(owner, invocation)
    owner.flows.add(flow)
    void flow.finally(() => owner.flows.delete(flow)).catch(() => undefined)
    return flow
  }

  pending(sessionKey: string): QuestionInteraction[] {
    const session = this.current(sessionKey)
    if (!session || session.closingOrClosed) return []
    const owner = this.owners.get(session)
    return owner
      ? [...owner.entries.values()]
          .filter((entry) => !entry.claim)
          .map((entry) => structuredClone(entry.interaction))
      : []
  }

  async answer(
    sessionKey: string,
    interactionId: string,
    value: unknown,
    actor: Actor,
  ): Promise<QuestionResolution> {
    const { owner, entry } = this.entry(sessionKey, interactionId)
    const checked = validateQuestionAnswer(entry.interaction.request, value, entry.interaction.policy)
    if (!checked.ok) throw new QuestionServiceError('INVALID_QUESTION_ANSWER', checked.errors)
    return this.settle(owner, entry, 'answered', actor, structuredClone(checked.value))
  }

  async cancel(sessionKey: string, interactionId: string, actor: Actor): Promise<QuestionResolution> {
    const { owner, entry } = this.entry(sessionKey, interactionId)
    return this.settle(owner, entry, 'cancelled', actor)
  }

  /** Called before log.close; covers preparation, requested admission and every terminal append. */
  async drain(session: SessionImpl): Promise<void> {
    const owner = this.owners.get(session)
    if (!owner) return
    owner.abort.abort()
    for (const entry of owner.entries.values())
      if (!entry.claim) void this.settle(owner, entry, 'aborted', session.d.actor).catch(() => undefined)
    await Promise.allSettled([...owner.flows])
    await Promise.allSettled(
      [...owner.entries.values()].flatMap((entry) => (entry.settlement ? [entry.settlement] : [])),
    )
    if (owner.faults.length) throw new QuestionServiceError('E_STORAGE_FAULT')
  }

  private assertLive(session: SessionImpl): void {
    if (this.current(session.key) !== session || session.closingOrClosed || session.d.log.isClosed)
      throw new QuestionServiceError('CALLER_NOT_LIVE')
  }

  private entry(sessionKey: string, interactionId: string): { owner: Owner; entry: Entry } {
    const session = this.current(sessionKey)
    if (!session) throw new QuestionServiceError('QUESTION_NOT_LIVE')
    this.assertLive(session)
    const owner = this.owners.get(session)
    const entry = owner?.entries.get(interactionId)
    if (!owner || !entry || entry.interaction.writerRunId !== session.writerRunId)
      throw new QuestionServiceError('QUESTION_NOT_LIVE')
    return { owner, entry }
  }

  private async prepare(owner: Owner, invocation: ToolQuestionsInvocation): Promise<QuestionAnswer> {
    const { session } = owner
    const json = inspectJsonData(invocation.request)
    if (!json.ok) throw new QuestionServiceError('INVALID_QUESTION_REQUEST')
    const checked = validateQuestionRequest(json.value)
    if (!checked.ok) throw new QuestionServiceError('INVALID_QUESTION_REQUEST', checked.errors)
    const request = structuredClone(checked.value)
    const call = session.state.toolCalls.get(invocation.toolUseId)
    if (!call || !this.invocationLive(session, invocation, call.seq))
      throw new QuestionServiceError('CALLER_NOT_LIVE')
    const managedSignal = managedHumanWaitSignal(invocation.context)
    if (!managedSignal) throw new QuestionServiceError('CALLER_NOT_LIVE')
    const signal = AbortSignal.any([invocation.signal, managedSignal, session.ac.signal, owner.abort.signal])
    if (signal.aborted) throw aborted()
    if (!this.provider) throw new QuestionServiceError('NO_PROVIDER')
    const identity: QuestionProviderIdentity = {
      sessionKey: session.key,
      writerRunId: session.writerRunId,
      // Local and shared-worker SessionOpenResult currently use session generation 1;
      // workerGeneration and writerRunId carry process/wake ownership changes separately.
      generation: 1,
      toolUseId: invocation.toolUseId,
      turn: invocation.turn,
      callSeq: call.seq,
    }
    let policy: QuestionAnswerPolicy
    try {
      policy = await cancellable(this.provider(identity, signal), signal)
    } catch {
      throw signal.aborted ? aborted() : new QuestionServiceError('NO_PROVIDER')
    }
    this.assertLive(session)
    if (signal.aborted) throw aborted()
    if (!this.invocationLive(session, invocation, call.seq)) throw new QuestionServiceError('CALLER_NOT_LIVE')
    if (
      !policy ||
      typeof policy.allowSkip !== 'boolean' ||
      Object.keys(policy).some((key) => key !== 'allowSkip')
    )
      throw new QuestionServiceError('NO_PROVIDER')
    const requested: QuestionRequestedData = {
      writerRunId: identity.writerRunId,
      generation: identity.generation,
      toolUseId: identity.toolUseId,
      turn: identity.turn,
      callSeq: identity.callSeq,
      interactionId: randomUUID(),
      request,
      policy: { allowSkip: policy.allowSkip },
    }
    let entry: Entry | undefined
    try {
      const receipt = await session.append([
        session.ev('question/requested', requested, { sourceEventSeqs: [call.seq] }),
      ])
      let resolve!: Entry['resolve']
      let reject!: Entry['reject']
      const wait = new Promise<QuestionAnswer>((yes, no) => {
        resolve = yes
        reject = no
      })
      void wait.catch(() => undefined)
      entry = {
        interaction: { ...requested, sessionId: session.key, requestedSeq: receipt.firstSeq },
        wait,
        resolve,
        reject,
      }
      owner.entries.set(requested.interactionId, entry)
      const live = entry
      const abort = () => {
        void this.settle(owner, live, 'aborted', session.d.actor).catch(() => undefined)
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (signal.aborted) abort()
        return await withManagedHumanWait(invocation.context, async (waitSignal) => {
          waitSignal.addEventListener('abort', abort, { once: true })
          try {
            if (waitSignal.aborted) abort()
            return await wait
          } finally {
            waitSignal.removeEventListener('abort', abort)
          }
        })
      } finally {
        signal.removeEventListener('abort', abort)
      }
    } catch (error) {
      if (error instanceof QuestionServiceError) throw error
      if (signal.aborted) throw aborted()
      if (!entry) {
        owner.faults.push(error)
        throw new QuestionServiceError('E_STORAGE_FAULT')
      }
      throw error
    } finally {
      if (entry && !entry.claim) await this.settle(owner, entry, 'aborted', session.d.actor)
      if (entry?.settlement) await entry.settlement
    }
  }

  private invocationLive(
    session: SessionImpl,
    invocation: ToolQuestionsInvocation,
    callSeq: number,
  ): boolean {
    const call = session.state.toolCalls.get(invocation.toolUseId)
    const step = session.state.openStep.get(session.lane)
    return (
      call?.seq === callSeq &&
      call.lane === session.lane &&
      call.turn === invocation.turn &&
      call.step === invocation.step &&
      step?.turn === invocation.turn &&
      step.step === invocation.step &&
      invocation.context.session.key === session.key &&
      invocation.context.session.lane === session.lane &&
      invocation.context.session.toolUseId === invocation.toolUseId &&
      invocation.context.session.turn === invocation.turn &&
      invocation.context.session.step === invocation.step
    )
  }

  private settle(
    owner: Owner,
    entry: Entry,
    status: QuestionResolution['status'],
    actor: Actor,
    answer?: QuestionAnswer,
  ): Promise<QuestionResolution> {
    if (entry.claim) {
      if (entry.claim.status !== status || jcs(entry.claim.answer ?? null) !== jcs(answer ?? null))
        return Promise.reject(new QuestionServiceError('QUESTION_CONFLICT'))
      return entry.settlement ?? Promise.reject(new QuestionServiceError('QUESTION_CONFLICT'))
    }
    if (status === 'answered' && answer === undefined)
      return Promise.reject(new QuestionServiceError('INVALID_QUESTION_ANSWER'))
    entry.claim = { status, ...(answer ? { answer } : {}) }
    const { interactionId, requestedSeq, callSeq, toolUseId } = entry.interaction
    const data: QuestionSettledData =
      status === 'answered' && answer
        ? { interactionId, requestedSeq, callSeq, toolUseId, status, answer }
        : {
            interactionId,
            requestedSeq,
            callSeq,
            toolUseId,
            status: status === 'cancelled' ? 'cancelled' : 'aborted',
          }
    entry.settlement = owner.session
      .append([
        owner.session.ev('question/settled', data, { actor, sourceEventSeqs: [callSeq, requestedSeq] }),
      ])
      .then((receipt) => {
        const resolution: QuestionResolution = {
          sessionId: owner.session.key,
          interactionId,
          status,
          settledSeq: receipt.firstSeq,
        }
        if (status === 'answered' && answer) entry.resolve(structuredClone(answer))
        else {
          const error = new QuestionServiceError(status === 'cancelled' ? 'ASK_CANCELLED' : 'ASK_ABORTED')
          if (status === 'cancelled')
            cancellations.set(error, {
              session: owner.session,
              writerRunId: entry.interaction.writerRunId,
              lane: owner.session.lane,
              toolUseId,
              turn: entry.interaction.turn,
              interactionId,
              callSeq,
              requestedSeq,
              settledSeq: receipt.firstSeq,
            })
          entry.reject(error)
        }
        return resolution
      })
      .catch((error: unknown) => {
        owner.faults.push(error)
        const fault = new QuestionServiceError('E_STORAGE_FAULT')
        entry.reject(fault)
        throw fault
      })
    return entry.settlement
  }
}
