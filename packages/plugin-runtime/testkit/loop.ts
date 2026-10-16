import { createHash } from 'node:crypto'
import type {
  LoopCheckpoint,
  LoopContext,
  LoopEffectStatus,
  LoopFactory,
  LoopInput,
  LoopRequest,
  LoopSideCallPort,
  LoopStepOutcome,
  LoopToolCallOptions,
  LoopTurnView,
} from '@agnes/extension-api'
import { type DecisionPort, loopShouldStop, unavailableDecisions } from '@agnes/extension-api'
import { type ModelReply, scriptedModel } from './model.js'

export interface LoopTestOptions {
  replies?: readonly ModelReply[]
  inputs?: readonly (Pick<LoopInput, 'content'> &
    Partial<LoopInput> & { target?: 'next-turn' | 'next-step' })[]
  checkpoint?: LoopCheckpoint
  /** The resumed checkpoint belongs to a turn that is still open, so next-step claims are legal. */
  turnOpen?: boolean
  /** Defaults to a port that refuses every request. */
  decisions?: DecisionPort
  /** Durable receipts that exist before the first step, keyed by invocation id. */
  effects?: Readonly<Record<string, LoopEffectStatus>>
  /**
   * The port behind `ctx.sideCall`. `ctx.sideCall` stays undefined unless one is supplied, so a loop
   * that guards on it sees the same context as before; a fake needs to answer only what the loop calls.
   */
  sideCall?: LoopSideCallPort
  /**
   * The fake behind the tool ports; a batch runs each of its calls through `execute`. An `announce`
   * option is honoured the way Core records it: the call or batch is first added to `events` as one
   * `assistant/message` with `stopReason: 'tool_use'`, and the option reaches `execute` with each call.
   * Replay is not simulated: an invocation that may have been sent is refused, announced or not.
   */
  tools?: Pick<LoopContext['tools'], 'execute' | 'batch'> & Partial<Pick<LoopContext['tools'], 'resume'>>
  /** Result of the approval-continuation probe; defaults to false (nothing parked). */
  resumeParked?: Awaited<ReturnType<LoopContext['input']['resumeParked']>>
  context?: LoopContext
  turnView?: LoopTurnView
  signal?: AbortSignal
  maxSteps?: number
  until?: 'turn-end' | 'idle'
}

/** Drive an actual factory/driver against scripted model replies and observable ports. */
export async function driveLoop(factory: LoopFactory, options: LoopTestOptions = {}) {
  const scripted = scriptedModel(options.replies ?? [])
  const events: { type: string; data: Parameters<LoopContext['events']['emit']>[1] }[] = []
  const steps: LoopStepOutcome[] = []
  const inputs = (options.inputs ?? []).map((input, i) => ({
    id: String(i + 1),
    turnId: i + 1,
    kind: 'prompt' as const,
    trust: 'trusted' as const,
    actor: { id: 'test', org: 'test', role: 'owner', deptPath: [], attrs: {} },
    target: 'next-turn' as 'next-turn' | 'next-step',
    ...structuredClone(input),
  }))
  let checkpoint = options.checkpoint ? structuredClone(options.checkpoint) : null
  let current: (typeof inputs)[number] | null = options.turnOpen
    ? {
        id: '0',
        turnId: options.turnView?.turnId ?? 1,
        kind: 'prompt',
        trust: 'trusted',
        actor: { id: 'test', org: 'test', role: 'owner', deptPath: [], attrs: {} },
        target: 'next-turn',
        content: [],
      }
    : null
  let finished: Parameters<LoopContext['events']['finish']> | undefined
  const signal = options.signal ?? new AbortController().signal
  const maxSteps = options.maxSteps ?? 20
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new RangeError('maxSteps must be positive')
  const statuses = new Map<string, LoopEffectStatus>(Object.entries(structuredClone(options.effects ?? {})))
  const unavailable = async (): Promise<never> => {
    throw new Error('Controlled ledger operation requires a real Core context')
  }
  const claim = async (target: 'next-turn' | 'next-step') => {
    if (target === 'next-turn' && current) return current
    const index = inputs.findIndex((input) => input.target === target)
    if (index < 0 || (target === 'next-step' && !current)) return null
    const input = inputs.splice(index, 1)[0]!
    if (target === 'next-turn') current = input
    else input.turnId = current!.turnId
    return input
  }
  const announce = (callOptions?: LoopToolCallOptions) => {
    if (!callOptions?.announce) return
    const content = callOptions.announce === true ? [] : structuredClone(callOptions.announce.content)
    events.push({ type: 'assistant/message', data: { content, stopReason: 'tool_use' } })
  }
  const runTool: LoopContext['tools']['execute'] = async (call, signal, callOptions) => {
    const id = call.invocationId ?? 'tool-' + statuses.size
    const previous = statuses.get(id)
    if (previous?.status === 'may-have-sent') throw new Error('Invocation may have been sent')
    if (previous?.status === 'responded') return previous.result as import('@agnes/extension-api').ToolResult
    statuses.set(id, { status: 'may-have-sent', invocationId: id, checkpoint })
    const result = options.tools
      ? await (callOptions === undefined
          ? options.tools.execute(call, signal)
          : options.tools.execute(call, signal, callOptions))
      : await unavailable()
    statuses.set(id, {
      status: 'responded',
      invocationId: id,
      checkpoint,
      result: structuredClone(result),
    })
    return result
  }
  const ctx: LoopContext = options.context ?? {
    decisions: options.decisions ?? unavailableDecisions,
    session: { key: 'author-loop-test', lane: 'main', workspaceRoot: '/fixture' },
    sessionKey: 'author-loop-test',
    lane: 'main',
    async prepareRequest(input = {}) {
      const view = options.turnView
      const body = {
        kind: 'inference' as const,
        sessionKey: 'author-loop-test',
        slot: input.slot ?? 'primary',
        route: 'scripted',
        model: view?.model.id ?? 'scripted',
        contractId: null,
        system: input.system ?? view?.prompt.sections.map((section) => section.text).join('\n\n') ?? '',
        messages:
          input.messages ?? (current ? [{ role: 'user' as const, content: [...current.content] }] : []),
        tools: (view?.tools ?? []).filter((tool) => !input.tools || input.tools.includes(tool.name)),
        ...(input.sampling ? { sampling: input.sampling } : {}),
      }
      return Object.freeze({
        ...body,
        derivedHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      }) as LoopRequest
    },
    async estimateRequest() {
      return {
        inputTokens: null,
        source: 'unknown',
        projectedCredits: null,
        contextWindow: options.turnView?.model.capabilities?.contextWindow ?? 128000,
        reserveTokens: 0,
        remainingTokens: null,
        shouldCompact: null,
      }
    },
    jobs: { status: unavailable, join: unavailable },
    turn: {
      view: async () => options.turnView ?? null,
      endStep: async () => {},
      continuation: () => null,
      cancelled: () => signal.aborted,
      checkpoint: unavailable,
      finishCancelled: unavailable,
      finishFailure: unavailable,
    },
    effects: { status: async (id) => statuses.get(id) ?? { status: 'not-sent', invocationId: id } },
    ...(options.sideCall ? { sideCall: options.sideCall } : {}),
    model: { ...scripted.model, respond: unavailable },
    tools: {
      drain: unavailable,
      resume: options.tools?.resume ?? unavailable,
      async execute(call, signal, callOptions) {
        announce(callOptions)
        return runTool(call, signal, callOptions)
      },
      async batch(calls, signal, callOptions) {
        announce(callOptions)
        return Promise.all(calls.map((call) => runTool(call, signal, callOptions)))
      },
    },
    input: {
      accept: () => claim('next-turn'),
      claim,
      resumeParked: async () => options.resumeParked ?? false,
      pending: () => inputs.length > 0,
    },
    events: {
      async assistant(message, saved) {
        events.push({ type: 'assistant/message', data: structuredClone(message) })
        checkpoint = structuredClone(saved)
      },
      emit: async (type, data) => {
        events.push({ type, data: structuredClone(data) })
      },
      finish: async (...args) => {
        finished = args
        current = null
        const [reason] = args
        return { outcome: reason === 'parked' ? 'parked' : 'turn-ended', phase: 'terminal', reason }
      },
    },
    checkpoints: {
      read: () => (checkpoint ? structuredClone(checkpoint) : null),
      write: async (value) => {
        checkpoint = structuredClone(value)
      },
    },
    wait: {
      poll: unavailable,
      delay: async (_ms, signal) => {
        signal.throwIfAborted()
      },
      park: async (signal) => {
        // A parked outcome is the stop boundary. Waiting itself remains interruptible.
        if (inputs.length) return
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      async wake() {},
    },
  }
  signal.throwIfAborted()
  const driver = await (options.checkpoint
    ? factory.resume(ctx, options.checkpoint, signal)
    : factory.create(ctx, signal))
  let cancellation: Promise<void> | undefined
  const abort = () => {
    cancellation = Promise.resolve().then(() => driver.cancel())
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) abort()
    signal.throwIfAborted()
    for (let i = 0; i < maxSteps; i++) {
      signal.throwIfAborted()
      const outcome = await driver.step(signal)
      signal.throwIfAborted()
      steps.push(outcome)
      if (loopShouldStop(outcome, options.until ?? 'turn-end')) {
        checkpoint = structuredClone(driver.checkpoint())
        return {
          steps,
          events,
          checkpoint,
          finished,
          requests: scripted.requests,
          remainingReplies: scripted.remaining,
        }
      }
    }
    throw new Error(`Loop exceeded ${maxSteps} steps`)
  } finally {
    signal.removeEventListener('abort', abort)
    try {
      await cancellation
    } finally {
      await driver.dispose()
    }
  }
}
