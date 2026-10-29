import type { EventInput } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { ToolDef } from '@agnes/extension-api'
import type { SessionImpl, TurnMemory } from './session.js'

const EVENT = 'x/core/tool-argument-recovery'
type State = { name: string; failures: number; limit: number; disabled: boolean }
const states = new WeakMap<TurnMemory, Map<string, State>>()
const restoring = new WeakMap<TurnMemory, Promise<void>>()
export const argumentFallback =
  'Disabled for the rest of this turn after repeated invalid arguments. Do not call this tool again, including through code or another tool. Continue with other available tools and answer in text/markdown. Keep tool names, error codes and schema details in diagnostics, not the reply.'

/** Trusted turn-local audit survives compaction and reopening. It grants no execution permission. */
export async function restoreToolArgumentRecovery(s: SessionImpl): Promise<void> {
  const t = s.turn,
    op = s.op()
  if (!t || !op) return
  let pending = restoring.get(t)
  if (!pending) {
    pending = (async () => {
      const state = new Map<string, State>()
      for (const e of await scanAll((q) => s.d.log.scan(q), {
        fromSeq: op.meta.triggerSeq,
        toSeq: s.lastSeq,
        lane: s.lane,
        type: EVENT,
      })) {
        if (e.origin !== 'system' || e.trust !== 'trusted') continue
        const row = e.data as State
        if (
          typeof row.name === 'string' &&
          Number.isInteger(row.failures) &&
          row.failures >= 0 &&
          Number.isInteger(row.limit) &&
          row.limit >= 1 &&
          row.limit <= 5 &&
          typeof row.disabled === 'boolean'
        )
          state.set(row.name, {
            name: row.name,
            failures: row.failures,
            limit: row.limit,
            disabled: row.disabled,
          })
      }
      states.set(t, state)
    })()
    restoring.set(t, pending)
  }
  await pending
}
export function toolArgumentsDisabled(s: SessionImpl, name: string): boolean {
  return !!(s.turn && states.get(s.turn)?.get(name)?.disabled)
}

/** Record validation, before any hook/policy/effect. Exhaustion is sticky for this turn. */
export function recordToolArgumentCheck(
  s: SessionImpl,
  def: ToolDef,
  error: string | undefined,
  toolUseId?: string,
): { error?: string; events: EventInput[] } {
  const state = s.turn && states.get(s.turn)
  if (!state) throw new Error('tool argument recovery was not restored')
  const previous = state.get(def.name)
  if (previous?.disabled)
    return {
      error: argumentFallback,
      events: [
        s.ev(
          EVENT,
          {
            ...previous,
            ...(toolUseId ? { toolUseId } : {}),
            presentational: def.meta.isPresentational === true,
            hint: argumentFallback,
          },
          { ignorable: true },
        ),
      ],
    }
  if (!error && !previous?.failures) return { events: [] }
  const limit = def.meta.invalidArgumentLimit ?? 2
  const failures = error ? (previous?.failures ?? 0) + 1 : 0
  const row = { name: def.name, failures, limit, disabled: failures >= limit }
  state.set(def.name, row)
  const events = [
    s.ev(
      EVENT,
      {
        ...row,
        ...(toolUseId ? { toolUseId } : {}),
        presentational: def.meta.isPresentational === true,
        ...(error ? { hint: error.slice(0, 2000) } : {}),
      },
      { ignorable: true },
    ),
  ]
  return {
    ...(error
      ? {
          error: row.disabled
            ? `${error.replace(' Retry with complete arguments matching the tool schema.', '')}\n${argumentFallback}`
            : `${error} ${limit - failures} corrective attempt(s) remaining.`,
        }
      : {}),
    events,
  }
}
