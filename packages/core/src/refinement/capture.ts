import type { ScanQuery } from '@agnes/core-ledger/log/storage'
import type { SessionDeps, SessionImpl } from '../step/session.js'
import type { RefinementSettingsView } from './scheduler.js'

/**
 * Task experience is decided per session, once, as the session opens: the tool list and the
 * experience notes are part of its request prefix, so a session keeps what it opened with for its
 * life. Turning the switch on reaches the sessions opened after it; the sessions already open go on
 * as they were, with no refinement tools, no triggers and no notes. Turning it off still stops every
 * session at once, because a session that runs task experience also reads the switch itself.
 */

/** The refine plugin's tools. A session that does not run task experience is never offered them. */
export const REFINEMENT_TOOLS: readonly string[] = Object.freeze([
  'harness_inspect',
  'harness_propose',
  'harness_refine',
])

/** Written only while a session runs task experience: with each experience snapshot, and when its notes change. */
const EXPERIENCE_ROW = 'x/core/refinement-prefix-change'
const OFF: RefinementSettingsView = Object.freeze({ enabled: false, mode: 'manual', revision: '' })

type Refinement = Pick<SessionDeps, 'refinementEnabled' | 'refinementTriggers' | 'refinement'>
const decided = new WeakMap<SessionImpl, boolean>()

const switchedOn = (enabled: () => boolean): boolean => {
  try {
    return enabled() === true
  } catch {
    return false
  }
}

/**
 * Whether a session opening now runs task experience. A child opened under its parent follows the
 * parent. Any other session follows the switch as it is now, except a reopened one that has sent
 * requests but never with task experience: it stays without it, so its prefix keeps describing the
 * requests it already sent. A reopened session that never sent a request decides like a new one. A
 * ledger that cannot be read here is read as no.
 */
async function runsRefinement(
  enabled: () => boolean,
  at: {
    parent: SessionImpl | undefined
    child: boolean
    reopened: boolean
    scan: (q: ScanQuery) => Promise<readonly unknown[]>
  },
): Promise<boolean> {
  const inherited = at.parent && decided.get(at.parent)
  if (inherited !== undefined) return inherited
  if (!switchedOn(enabled)) return false
  // A child's ledger never carries experience notes: there is nothing to keep consistent with.
  if (!at.reopened || at.child) return true
  try {
    if ((await at.scan({ type: EXPERIENCE_ROW, limit: 1 })).length > 0) return true
    return (await at.scan({ type: 'request/header', limit: 1 })).length === 0
  } catch {
    return false
  }
}

/**
 * What one opening session gets of the kernel's refinement. A session that runs it gets the kernel's
 * as it is: the live switch. One that does not gets refinement that always reads as off (a session
 * of a host assembled with the switch off), and the refinement tools are left out of its catalog.
 * A kernel without refinement changes nothing.
 */
export async function captureRefinement(
  kernel: Refinement,
  at: Parameters<typeof runsRefinement>[1],
): Promise<{ on: boolean; deps: Refinement; hiddenTools: readonly string[] }> {
  const { refinementEnabled, refinementTriggers, refinement } = kernel
  const forward: Refinement = {
    ...(refinementEnabled ? { refinementEnabled } : {}),
    ...(refinementTriggers ? { refinementTriggers } : {}),
    ...(refinement ? { refinement } : {}),
  }
  if (!refinementEnabled) return { on: false, deps: forward, hiddenTools: [] }
  if (await runsRefinement(refinementEnabled, at)) return { on: true, deps: forward, hiddenTools: [] }
  return {
    on: false,
    deps: {
      refinementEnabled: () => false,
      ...(refinementTriggers ? { refinementTriggers } : {}),
      ...(refinement ? { refinement: { ...refinement, settings: () => OFF } } : {}),
    },
    hiddenTools: REFINEMENT_TOOLS,
  }
}

/** Records the decision for the session, so the children it opens follow it. */
export function bindRefinement(s: SessionImpl, on: boolean): void {
  decided.set(s, on)
}
