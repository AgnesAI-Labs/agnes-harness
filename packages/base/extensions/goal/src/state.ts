import type { ProjectionDef } from '@agnes/extension-api'
import type { GoalSnapshot } from '@agnes/protocol/gen/slots'

export type GoalState = {
  goal: GoalSnapshot | null
  input: { seq: number; control: boolean; run: boolean; automatic: boolean; error: string | null } | null
  reservation: { id: string; revision: number; round: number; turn: number } | null
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const CONTINUE_PREFIX = '/goal-continue '
export const GOAL_USAGE =
  '/goal [create|edit] [--max-rounds 1..100] [--budget credits] <objective> | pause | resume | complete | clear'

function command(state: GoalState, text: string, seq: number): GoalState {
  const input = { seq, control: true, run: false, automatic: false, error: null as string | null }
  const fail = (error: string): GoalState => ({ ...state, input: { ...input, error } })
  let args = text.replace(/^\/goal(?:\s|$)/, '').trim()
  if (!args || args === 'show') return { ...state, input }
  const op = args.split(/\s/, 1)[0] ?? ''
  if (['pause', 'resume', 'complete', 'clear'].includes(op)) {
    if (args !== op) return fail(GOAL_USAGE)
    if (!state.goal) return fail('No goal exists in this session.')
    if (op === 'clear') return { goal: null, input, reservation: null }
    if ((op === 'resume' || op === 'pause') && state.goal.phase === 'complete')
      return fail('Create a new goal after completing this one.')
    const { reason: _reason, ...previous } = state.goal
    const goal: GoalSnapshot = {
      ...previous,
      revision: previous.revision + 1,
      phase: op === 'pause' ? 'paused' : op === 'complete' ? 'complete' : 'active',
      rounds: op === 'resume' ? 0 : previous.rounds,
    }
    return { goal, input: { ...input, run: op === 'resume' }, reservation: null }
  }
  const edit = op === 'edit'
  if (edit || op === 'create') args = args.slice(op.length).trim()
  if (edit && !state.goal) return fail('No goal exists in this session.')
  if (!edit && state.goal && state.goal.phase !== 'complete')
    return fail('A goal already exists. Edit or clear it first.')
  let maxRounds = edit ? (state.goal?.maxRounds ?? 10) : 10
  let budgetCredits = edit ? state.goal?.budgetCredits : undefined
  while (args.startsWith('--')) {
    const match = /^(--max-rounds|--budget)\s+(\S+)\s*/.exec(args)
    if (!match) return fail(GOAL_USAGE)
    if (match[1] === '--budget' && match[2] === 'none') {
      budgetCredits = undefined
      args = args.slice(match[0].length)
      continue
    }
    const value = Number(match[2])
    if (!Number.isFinite(value) || value <= 0) return fail(GOAL_USAGE)
    if (match[1] === '--max-rounds') {
      if (!Number.isInteger(value) || value > 100) return fail(GOAL_USAGE)
      maxRounds = value
    } else budgetCredits = value
    args = args.slice(match[0].length)
  }
  if (!args.trim() || args.length > 8192) return fail(GOAL_USAGE)
  const goal: GoalSnapshot = {
    id: edit ? (state.goal?.id ?? `goal-${seq}`) : `goal-${seq}`,
    revision: edit ? (state.goal?.revision ?? 0) + 1 : 1,
    objective: args.trim(),
    phase: edit ? (state.goal?.phase ?? 'active') : 'active',
    rounds: edit ? (state.goal?.rounds ?? 0) : 0,
    maxRounds,
    creditsUsed: edit ? (state.goal?.creditsUsed ?? 0) : 0,
    ...(budgetCredits === undefined ? {} : { budgetCredits }),
    ...(edit && state.goal?.reason ? { reason: state.goal.reason } : {}),
  }
  return { goal, input: { ...input, run: goal.phase === 'active' }, reservation: null }
}

export const goalProjection: ProjectionDef<GoalState> = {
  name: 'goal',
  stateVersion: 1,
  stateSchema: {
    type: 'object',
    required: ['goal', 'input', 'reservation'],
    properties: { goal: {}, input: {}, reservation: {} },
    additionalProperties: false,
  },
  init: () => ({ goal: null, input: null, reservation: null }),
  apply(state, event) {
    const next = state as GoalState
    const data = event.data
    if (!object(data)) return next
    // Pause, completion and clear take effect when human control enters the public inbox,
    // including the narrow race after the final checkpoint but before turn stopping.
    if (event.type === 'inbox' && Array.isArray(data.items)) {
      for (const item of data.items) {
        if (!object(item) || !object(item.actor) || item.actor.role === 'extension') continue
        if (!Array.isArray(item.content)) continue
        const text = item.content
          .map((b) => (object(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
          .join('\n')
          .trim()
        if (/^\/goal (?:pause|complete|clear)$/.test(text)) return command(next, text, event.seq)
      }
    }
    if (event.type === 'user/message' && Array.isArray(data.content) && data.kind !== 'runtime_context') {
      const text = data.content
        .map((b) => (object(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
        .join('\n')
        .trim()
      if (
        text.startsWith(CONTINUE_PREFIX) &&
        event.actor.id === 'agnes/goal' &&
        event.actor.role === 'extension'
      ) {
        let ref: unknown
        try {
          ref = JSON.parse(text.slice(CONTINUE_PREFIX.length))
        } catch {
          ref = null
        }
        const g = state.goal,
          r = state.reservation
        const valid =
          object(ref) &&
          g?.phase === 'active' &&
          r &&
          ref.id === g.id &&
          ref.revision === g.revision &&
          ref.round === g.rounds + 1 &&
          r.id === ref.id &&
          r.revision === ref.revision &&
          r.round === ref.round &&
          g.rounds < g.maxRounds
        return {
          ...next,
          goal: valid ? { ...g, rounds: g.rounds + 1 } : state.goal,
          reservation: null,
          input: {
            seq: event.seq,
            control: false,
            run: !!valid,
            automatic: true,
            error: valid ? null : 'Stale goal continuation',
          },
        }
      }
      if (/^\/goal(?:\s|$)/.test(text) && event.actor.role !== 'extension')
        return command(next, text, event.seq)
      return { ...next, input: { seq: event.seq, control: false, run: true, automatic: false, error: null } }
    }
    if (
      event.type === 'x/agnes/goal/reserved' &&
      state.goal &&
      data.id === state.goal.id &&
      data.revision === state.goal.revision &&
      typeof data.round === 'number' &&
      typeof data.turn === 'number'
    )
      return {
        ...next,
        reservation: { id: state.goal.id, revision: state.goal.revision, round: data.round, turn: data.turn },
      }
    if (
      event.type === 'x/agnes/goal/updated' &&
      state.goal &&
      data.id === state.goal.id &&
      data.revision === state.goal.revision &&
      (data.phase === 'blocked' || data.phase === 'complete') &&
      state.goal.phase === 'active' &&
      typeof data.reason === 'string' &&
      data.reason.trim()
    )
      return {
        ...next,
        goal: { ...state.goal, phase: data.phase, reason: data.reason.slice(0, 2048) },
        reservation: null,
      }
    if (event.type === 'x/agnes/goal/paused' && state.goal?.phase === 'active')
      return {
        ...next,
        goal: { ...state.goal, phase: 'paused', revision: state.goal.revision + 1 },
        reservation: null,
      }
    if (event.type === 'cost/ledger' && state.goal) {
      if (
        state.goal.phase === 'active' &&
        state.goal.budgetCredits !== undefined &&
        typeof data.credits !== 'number' &&
        !object(data.adjustment)
      )
        return {
          ...next,
          goal: { ...state.goal, phase: 'blocked', reason: 'Credit usage unavailable' },
          input: state.input ? { ...state.input, run: false, error: 'Credit usage unavailable' } : null,
          reservation: null,
        }

      const adjustment = object(data.adjustment) ? data.adjustment.delta : undefined
      const credits =
        typeof adjustment === 'number' ? adjustment : typeof data.credits === 'number' ? data.credits : 0
      const creditsUsed = Math.max(0, state.goal.creditsUsed + credits)
      return creditsUsed === state.goal.creditsUsed ? next : { ...next, goal: { ...state.goal, creditsUsed } }
    }
    if (
      event.type === 'turn/end' &&
      state.goal?.phase === 'active' &&
      !(state.input?.control && !state.input.run) &&
      ['aborted', 'error', 'budget', 'max_steps', 'blocked'].includes(String(data.reason))
    )
      return {
        ...next,
        goal: { ...state.goal, phase: 'blocked', reason: `Turn stopped: ${data.reason}` },
        reservation: null,
      }
    return next
  },
}
