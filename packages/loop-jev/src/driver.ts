import type {
  GenericLoopPorts,
  LoopCheckpointCodec,
  LoopDriver,
  LoopEndReason,
  LoopStepOutcome,
} from '@agnes/extension-api'
import type { AnnouncedContent, InferenceEvent, JsonValue } from './types.js'
import { errorCode } from './util.js'

/** Pass-through driver state: one model request per round, its calls run as they were asked for. */
export type SkeletonState = { turn: number | null; stage: 'model' | 'finish'; round: number }

const isState = (value: JsonValue): value is SkeletonState => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const { turn, stage, round } = value as { [key: string]: JsonValue | undefined }
  return (
    (turn === null || (typeof turn === 'number' && Number.isSafeInteger(turn))) &&
    (stage === 'model' || stage === 'finish') &&
    typeof round === 'number' &&
    Number.isSafeInteger(round) &&
    round >= 0
  )
}

export const skeletonCodec: LoopCheckpointCodec<SkeletonState> = {
  version: 1,
  encode: (state) => ({
    codecVersion: 1,
    state: { turn: state.turn, stage: state.stage, round: state.round },
  }),
  decode(checkpoint) {
    if (checkpoint.codecVersion !== 1)
      throw new Error(
        `Jev loop checkpoint codec version ${checkpoint.codecVersion} is unsupported; expected 1`,
      )
    if (!isState(checkpoint.state)) throw new Error('Invalid Jev loop checkpoint')
    return { ...checkpoint.state }
  },
}

/** Adjacent deltas of the same kind form one block. */
function contentOf(events: readonly InferenceEvent[]): AnnouncedContent {
  const content: AnnouncedContent = []
  for (const event of events) {
    if (event.type !== 'text_delta' && event.type !== 'thinking_delta') continue
    const type = event.type === 'text_delta' ? 'text' : 'thinking'
    const last = content.at(-1)
    if (last?.type === type) last.text += event.delta
    else content.push({ type, text: event.delta })
  }
  return content
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function createSkeletonDriver(ctx: GenericLoopPorts, saved?: SkeletonState): LoopDriver {
  let state: SkeletonState = saved ? { ...saved } : { turn: null, stage: 'model', round: 0 }
  let disposed = false
  const save = () => ctx.checkpoints.write(skeletonCodec.encode(state))
  const running = (): LoopStepOutcome => ({ outcome: 'running', phase: state.stage })
  const finish = (reason: LoopEndReason, error?: { code: string; message: string }) =>
    ctx.events.finish(reason, error)
  // A stop gate that keeps the turn open recorded why in history; the next round answers it.
  const close = async (): Promise<LoopStepOutcome> => {
    const out = await ctx.events.finish('completed')
    if (out.outcome !== 'running') return out
    state = { ...state, stage: 'model', round: state.round + 1 }
    await save()
    return running()
  }
  return {
    checkpoint: () => skeletonCodec.encode(state),
    cancel() {},
    dispose() {
      disposed = true
    },
    async step(signal) {
      if (disposed) throw new Error('Jev loop driver is disposed')
      try {
        const input = await ctx.input.claim('next-turn')
        if (!input) return { outcome: 'idle' }
        if (state.stage === 'finish' && state.turn === input.turnId) return await close()
        if (state.turn !== input.turnId) state = { turn: input.turnId, stage: 'model', round: 0 }
        if (signal.aborted || ctx.turn.cancelled()) return await finish('aborted')
        const prefix = `jev:${state.turn}:${state.round}`
        const request = await ctx.prepareRequest({ invocationId: `${prefix}:m0` })
        const events = await ctx.model.complete(request, signal)
        // A cancelled request settles with an error event rather than a throw.
        if (signal.aborted || ctx.turn.cancelled()) return await finish('aborted')
        const failure = events.find((event) => event.type === 'error')
        if (failure) return await finish('error', { code: 'JEV_LOOP_MODEL_FAILED', message: failure.message })
        const content = contentOf(events)
        const calls = events.flatMap((event) => (event.type === 'toolcall_end' ? [event.call] : []))
        if (calls.length) {
          await ctx.tools.batch(
            calls.map((call, i) => ({ invocationId: `${prefix}:t${i}`, name: call.name, args: call.args })),
            signal,
            { announce: { content } },
          )
          state = { ...state, round: state.round + 1 }
          await save()
          return running()
        }
        state = { ...state, stage: 'finish' }
        await ctx.events.assistant({ content, stopReason: 'end_turn' }, skeletonCodec.encode(state))
        return await close()
      } catch (error) {
        const code = errorCode(error)
        if (code === 'PARKED') {
          await save()
          return { outcome: 'parked', reason: 'parked' }
        }
        if (signal.aborted) return await finish('aborted')
        // Core already ended the turn when it refused admission; do not finish it again.
        if (code === 'E_BUDGET') {
          const detail = (error as { detail?: { reason?: LoopEndReason } }).detail
          return { outcome: 'turn-ended', reason: detail?.reason ?? 'budget' }
        }
        // A revoked generation must not write; let Core see the refusal.
        if (code === 'E_CLOSED') throw error
        return await finish('error', { code: 'JEV_LOOP_FAILED', message: messageOf(error) })
      }
    },
  }
}
