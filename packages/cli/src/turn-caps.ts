import type { Client } from '@agnes/sdk'
import { UsageError } from './errors.js'
import type { ParsedArgs } from './types.js'

/** Per-run caps for `agh -p`; they only ever lower what the preset allows. */
export const TURN_CAP_FLAGS = { '--max-budget': 'maxBudget', '--max-turns': 'maxTurns' } as const

export type TurnCaps = { creditLimit?: number; maxSteps?: number }

/** Largest limit the SDK accepts (`prompt-budget.ts`); refused here so the message names the flag. */
const MAX_CREDITS = Number.MAX_SAFE_INTEGER / 1_000_000

export function parseTurnCaps(p: ParsedArgs): TurnCaps {
  const caps: TurnCaps = {}
  if (p.maxBudget !== undefined) {
    const n = /^\d+(\.\d+)?$/.test(p.maxBudget) ? Number(p.maxBudget) : Number.NaN
    if (!(n > 0 && n <= MAX_CREDITS))
      throw new UsageError('--max-budget must be a number of credits greater than 0')
    caps.creditLimit = n
  }
  if (p.maxTurns !== undefined) {
    const n = /^\d+$/.test(p.maxTurns) ? Number(p.maxTurns) : Number.NaN
    if (!(n >= 1 && n <= 1000)) throw new UsageError('--max-turns must be an integer from 1 to 1000')
    caps.maxSteps = n
  }
  return caps
}

export function refuseTurnCapsOutsidePrint(p: ParsedArgs, mode: string): void {
  const flag =
    p.maxBudget !== undefined ? '--max-budget' : p.maxTurns !== undefined ? '--max-turns' : undefined
  if (flag && mode !== 'print') throw new UsageError(`${flag} is supported only with -p`)
}

/** An older daemon would silently ignore a cap, so ask before anything is sent. */
export async function requireTurnCaps(client: Client, caps: TurnCaps): Promise<void> {
  if (caps.creditLimit === undefined && caps.maxSteps === undefined) return
  const info = await client.initialize()
  const meta = (info.capabilities._meta as Record<string, unknown> | undefined)?.['ai.agnes.harness'] as
    | { hardTurnBudget?: boolean; turnMaxSteps?: boolean }
    | undefined
  if (caps.creditLimit !== undefined && meta?.hardTurnBudget !== true)
    throw new UsageError('this daemon does not support --max-budget; upgrade it')
  if (caps.maxSteps !== undefined && meta?.turnMaxSteps !== true)
    throw new UsageError('this daemon does not support --max-turns; upgrade it')
}
