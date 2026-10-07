import type { LoopCheckpoint, LoopContext, LoopFactory, LoopStepOutcome } from '@agnes/extension-api'
import { type ModelReply, scriptedModel } from './model.js'

export interface LoopTestOptions {
  replies?: readonly ModelReply[]
  inputs?: readonly NonNullable<Awaited<ReturnType<LoopContext['input']['accept']>>>[]
  checkpoint?: LoopCheckpoint
  tools?: LoopContext['tools']
  signal?: AbortSignal
  maxSteps?: number
}

/** Drive an actual factory/driver against scripted model replies and observable ports. */
export async function driveLoop(factory: LoopFactory, options: LoopTestOptions = {}) {
  const scripted = scriptedModel(options.replies ?? [])
  const events: { type: string; data: Parameters<LoopContext['events']['emit']>[1] }[] = []
  const steps: LoopStepOutcome[] = []
  const inputs = [...(options.inputs ?? [])]
  let checkpoint = options.checkpoint ? structuredClone(options.checkpoint) : null
  let finished: Parameters<LoopContext['events']['finish']> | undefined
  const signal = options.signal ?? new AbortController().signal
  const maxSteps = options.maxSteps ?? 20
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) throw new RangeError('maxSteps must be positive')
  const ctx: LoopContext = {
    sessionKey: 'author-loop-test',
    lane: 'main',
    model: scripted.model,
    tools: options.tools ?? {
      execute: async () => {
        throw new Error('Loop test tools not configured')
      },
      batch: async () => {
        throw new Error('Loop test tools not configured')
      },
    },
    input: { accept: async () => inputs.shift() ?? null, pending: () => inputs.length > 0 },
    events: {
      emit: async (type, data) => {
        events.push({ type, data: structuredClone(data) })
      },
      finish: async (...args) => {
        finished = args
      },
    },
    checkpoints: {
      read: () => (checkpoint ? structuredClone(checkpoint) : null),
      write: async (value) => {
        checkpoint = structuredClone(value)
      },
    },
    wait: {
      park: async () => {
        throw new Error('Loop parked; test must stop or supply input')
      },
      wake() {},
    },
  }
  signal.throwIfAborted()
  const driver = options.checkpoint ? factory.resume(ctx, options.checkpoint) : factory.create(ctx)
  let cancellation: Promise<void> | undefined
  const abort = () => {
    cancellation = Promise.resolve().then(() => driver.cancel())
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (let i = 0; i < maxSteps; i++) {
      signal.throwIfAborted()
      const outcome = await driver.step(signal)
      signal.throwIfAborted()
      steps.push(outcome)
      if (outcome.reason || finished) {
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
