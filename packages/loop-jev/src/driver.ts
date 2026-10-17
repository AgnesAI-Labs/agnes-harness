import type {
  GenericLoopPorts,
  LoopDriver,
  LoopEndReason,
  LoopInput,
  LoopStepOutcome,
} from '@agnes/extension-api'
import { turnToolNames } from './profile.js'
import { recoverStep, resumeParkedStage } from './recover.js'
import { emitMetrics, finishTurn, type Scope, save, snapshot } from './scope.js'
import { emptyCounters, initialState } from './state.js'
import { decideStep } from './step.js'
import type { JevLoopConfig, JevState } from './types.js'
import { clip, errorCode } from './util.js'
import { addNote, goalText, newTurn } from './workspace.js'

const FAILURE_MESSAGE_CHARS = 500

/** A new user turn: a fresh goal, step 0 and counters, and the tool names for the whole turn. */
async function beginTurn(s: Scope, input: LoopInput): Promise<void> {
  const st = s.state
  newTurn(st.workspace, goalText(input.content))
  st.idTurn = input.turnId
  st.coreTurn = input.turnId
  st.step = 0
  st.stage = 'decide'
  st.cur = { jevAttempts: [], level: 0 }
  st.pendingNotes = []
  st.counters = emptyCounters()
  st.internalErrors = 0
  delete st.endReason
  delete st.endError
  const view = await s.ctx.turn.view()
  if (!view) throw new Error('The claimed Jev loop turn has no public view')
  st.toolNames = turnToolNames(view)
}

const ended = (st: JevState) => st.stage === 'finish' || st.stage === 'done'

/** A step of the current turn that a restart interrupted after its first effect was recorded. */
const interrupted = (st: JevState) =>
  st.stage === 'llm' || st.stage === 'dispatch' || (st.stage === 'decide' && st.cur.jevAttempts.length > 0)

async function step(s: Scope, signal: AbortSignal): Promise<LoopStepOutcome> {
  const { ctx, state: st } = s
  if (st.stage === 'parked' || (st.stage === 'dispatch' && (await ctx.turn.view()) === null))
    return resumeParkedStage(s, signal)
  const input = await ctx.input.claim('next-turn')
  if (!input) {
    if (ended(st)) {
      st.stage = 'idle'
      await save(s)
    }
    return { outcome: 'idle' }
  }
  const same = st.coreTurn === input.turnId
  // The answer was committed before a restart: end the turn without asking the model again.
  if (same && ended(st)) return finishTurn(s, st.endReason ?? 'completed', st.endError)
  if (same && interrupted(st)) return recoverStep(s, signal)
  if (!same) await beginTurn(s, input)
  const steer = await ctx.input.claim('next-step')
  if (steer) addNote(st.workspace, { kind: 'steer', text: goalText(steer.content) })
  const view = await ctx.turn.view()
  if (!view) throw new Error('The claimed Jev loop turn has no public view')
  if (signal.aborted || view.cancelled || ctx.turn.cancelled()) return finishTurn(s, 'aborted')
  if (st.step >= s.cfg.stepCap) return finishTurn(s, 'max_steps')
  return decideStep(s, view, signal)
}

/** The Jev loop driver: one decision per step, and the fallback policy for errors no stage handled. */
export function createDriver(ctx: GenericLoopPorts, cfg: JevLoopConfig, saved?: JevState): LoopDriver {
  const s: Scope = {
    ctx,
    cfg,
    state: saved ? structuredClone(saved) : initialState(),
    cwd: ctx.session.workspaceRoot,
  }
  let disposed = false
  return {
    checkpoint: () => snapshot(s),
    // Core supplies the abort signal; cancelling must not poison the next turn.
    cancel() {},
    dispose() {
      disposed = true
    },
    async step(signal) {
      if (disposed) throw new Error('Jev loop driver is disposed')
      try {
        return await step(s, signal)
      } catch (error) {
        const code = errorCode(error)
        if (code === 'PARKED') {
          s.state.stage = 'parked'
          await save(
            s,
            (s.state.cur.calls ?? []).map((call) => call.invocationId),
          )
          return { outcome: 'parked', reason: 'parked' }
        }
        if (signal.aborted || ctx.turn.cancelled()) return finishTurn(s, 'aborted')
        // Core already ended the turn when it refused admission; do not finish it again.
        if (code === 'E_BUDGET') {
          // The turn is over: no call of it may be replayed, and the next input starts a new turn.
          s.state.stage = 'done'
          delete s.state.cur.calls
          const reason = (error as { detail?: { reason?: LoopEndReason } }).detail?.reason ?? 'budget'
          await emitMetrics(s, reason)
          await save(s)
          return { outcome: 'turn-ended', reason }
        }
        // A revoked generation must not write; let Core see the refusal.
        if (code === 'E_CLOSED') throw error
        return finishTurn(s, 'error', {
          code: 'JEV_LOOP_FAILED',
          message: clip(String(error), FAILURE_MESSAGE_CHARS),
        })
      }
    },
  }
}
