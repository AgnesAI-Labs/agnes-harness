import type {
  GenericLoopPorts,
  LoopDriver,
  LoopEndReason,
  LoopInput,
  LoopStepOutcome,
  LoopTurnView,
} from '@agnes/extension-api'
import { codeDisclosure, turnToolNames } from './profile.js'
import { recoverStep, resumeParkedStage } from './recover.js'
import { emitMetrics, finishTurn, type Scope, save, snapshot } from './scope.js'
import { emptyCounters, initialState } from './state.js'
import { decideStep } from './step.js'
import type { JevLoopConfig, JevState } from './types.js'
import { clip, errorCode } from './util.js'
import { addNote, goalText, newTurn } from './workspace.js'

const FAILURE_MESSAGE_CHARS = 500

const UNSUPPORTED_DISCLOSURE = {
  code: 'JEV_UNSUPPORTED_DISCLOSURE',
  message:
    "The Jev loop does not support the code or hybrid tool disclosure of this session's preset: it chooses among the standard tools and never offers run_code. Start the session with the default loop (agnes.default), or with a preset whose disclosure is standard.",
}

/** A new user turn: a fresh goal, step 0 and counters, and the tool names for the whole turn. Returns the view it read. */
async function beginTurn(s: Scope, input: LoopInput): Promise<LoopTurnView> {
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
  st.toolNamesChanges = 0
  delete st.endReason
  delete st.endError
  const view = await s.ctx.turn.view()
  if (!view) throw new Error('The claimed Jev loop turn has no public view')
  st.toolNames = turnToolNames(view)
  return view
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
  if (same && interrupted(st)) {
    // A restart may find the session on a preset that no longer fits; a closed turn has no view to check.
    const open = await ctx.turn.view()
    if (open && codeDisclosure(open)) return finishTurn(s, 'error', UNSUPPORTED_DISCLOSURE)
    return recoverStep(s, signal)
  }
  if (!same) {
    const began = await beginTurn(s, input)
    // The preset fixes the disclosure for the whole session: refuse before any Jev, model or tool call.
    if (codeDisclosure(began)) return finishTurn(s, 'error', UNSUPPORTED_DISCLOSURE)
  }
  const steer = await ctx.input.claim('next-step')
  if (steer) addNote(st.workspace, { kind: 'steer', text: goalText(steer.content) })
  const view = await ctx.turn.view()
  if (!view) throw new Error('The claimed Jev loop turn has no public view')
  if (codeDisclosure(view)) return finishTurn(s, 'error', UNSUPPORTED_DISCLOSURE)
  if (signal.aborted || view.cancelled || ctx.turn.cancelled()) return finishTurn(s, 'aborted')
  if (st.step >= s.cfg.stepCap) return finishTurn(s, 'max_steps')
  // A tool the model loaded earlier in the turn joins the names once; none is ever taken away.
  const merged = [...new Set([...st.toolNames, ...turnToolNames(view)])].sort()
  if (merged.join('\n') !== st.toolNames.join('\n')) {
    st.toolNamesChanges++
    st.toolNames = merged
  }
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
