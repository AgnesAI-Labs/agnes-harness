import type { EventInput } from '@agnes/core-common/types'
import type { ScanQuery } from '@agnes/core-ledger/log/storage'
import { sessionToolView } from '../child/tool-filter.js'
import { sessionIdentity } from '../loop/scope.js'
import type { ToolRegistry } from '../registry/tools.js'
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

/**
 * The decision, recorded once: an ignorable row a session that runs task experience writes with the
 * first request it sends, so a reopened session knows its requests carried the refinement tools. A
 * session that does not run it never writes one, nor does a child (it follows its parent).
 */
export const REFINEMENT_SESSION = 'x/core/refinement-session'
/**
 * Written only while a session runs task experience, with each experience snapshot and when its
 * notes change. A ledger from before the marker existed has this row and no marker: it ran with it.
 */
const EXPERIENCE_ROW = 'x/core/refinement-prefix-change'
const OFF: RefinementSettingsView = Object.freeze({ enabled: false, mode: 'manual', revision: '' })

type Refinement = Pick<SessionDeps, 'refinementEnabled' | 'refinementTriggers' | 'refinement'>
type Decision = { on: boolean; owesMarker: boolean }
// Keyed by the session's stable identity: a loop sees the session through a scoped proxy.
const decided = new WeakMap<object, boolean>()
const visible = new WeakMap<object, (tools: ToolRegistry) => ToolRegistry>()
const owed = new WeakSet<object>()

const switchedOn = (enabled: () => boolean): boolean => {
  try {
    return enabled() === true
  } catch {
    return false
  }
}

/**
 * Whether a session opening now runs task experience, and whether it still has to record that. A
 * child opened under its parent follows the parent. Any other session follows the switch as it is
 * now, except a reopened one that has sent requests but none while running task experience (no
 * marker, no experience row): it stays without it, so its prefix keeps describing the requests it
 * already sent. A reopened session that never sent a request decides like a new one. A ledger that
 * cannot be read here is read as no.
 */
async function decide(
  enabled: () => boolean,
  at: {
    parent: SessionImpl | undefined
    child: boolean
    reopened: boolean
    scan: (q: ScanQuery) => Promise<readonly unknown[]>
  },
): Promise<Decision> {
  const inherited = at.parent && decided.get(sessionIdentity(at.parent))
  if (inherited !== undefined) return { on: inherited, owesMarker: false }
  if (!switchedOn(enabled)) return { on: false, owesMarker: false }
  // A child's ledger never carries experience notes: there is nothing to keep consistent with.
  if (at.child) return { on: true, owesMarker: false }
  if (!at.reopened) return { on: true, owesMarker: true }
  const found = async (type: string) => (await at.scan({ type, limit: 1 })).length > 0
  try {
    if (await found(REFINEMENT_SESSION)) return { on: true, owesMarker: false }
    if (await found(EXPERIENCE_ROW)) return { on: true, owesMarker: true }
    return (await found('request/header')) ? { on: false, owesMarker: false } : { on: true, owesMarker: true }
  } catch {
    return { on: false, owesMarker: false }
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
  at: Parameters<typeof decide>[1],
): Promise<Decision & { deps: Refinement; hiddenTools: readonly string[] }> {
  const { refinementEnabled, refinementTriggers, refinement } = kernel
  const forward: Refinement = {
    ...(refinementEnabled ? { refinementEnabled } : {}),
    ...(refinementTriggers ? { refinementTriggers } : {}),
    ...(refinement ? { refinement } : {}),
  }
  if (!refinementEnabled) return { on: false, owesMarker: false, deps: forward, hiddenTools: [] }
  const decision = await decide(refinementEnabled, at)
  if (decision.on) return { ...decision, deps: forward, hiddenTools: [] }
  return {
    ...decision,
    deps: {
      refinementEnabled: () => false,
      ...(refinementTriggers ? { refinementTriggers } : {}),
      ...(refinement ? { refinement: { ...refinement, settings: () => OFF } } : {}),
    },
    hiddenTools: REFINEMENT_TOOLS,
  }
}

/**
 * Records the decision for the session, so the children it opens and the Host's listings follow it.
 * A session that owes the marker owes it until a batch carrying it is committed.
 */
export function bindRefinement(
  s: SessionImpl,
  decision: Decision & { hiddenTools: readonly string[] },
): void {
  const id = sessionIdentity(s)
  decided.set(id, decision.on)
  const view = sessionToolView(undefined, decision.hiddenTools)
  if (view) visible.set(id, view)
  if (!decision.owesMarker) return
  owed.add(id)
  const stop = s.d.log.observeCommitted([REFINEMENT_SESSION], () => {
    owed.delete(id)
    stop()
  })
}

/**
 * `tools` without the tools Core never offers this session (the refinement tools of a session that
 * does not run task experience), for a Host listing built from a registry other than the session's
 * own, such as its capability set.
 */
export function sessionVisibleTools(s: SessionImpl, tools: ToolRegistry): ToolRegistry {
  return visible.get(sessionIdentity(s))?.(tools) ?? tools
}

let withoutRefinement: ((tools: ToolRegistry) => ToolRegistry) | undefined
/**
 * `tools` as a session opening now would be offered them, for a Host listing made while no session
 * is open (an agent launch review): a new session runs task experience only while the switch is on.
 */
export function newSessionVisibleTools(
  kernel: { refinementEnabled?: () => boolean },
  tools: ToolRegistry,
): ToolRegistry {
  if (!kernel.refinementEnabled || switchedOn(kernel.refinementEnabled)) return tools
  withoutRefinement ??= sessionToolView(undefined, REFINEMENT_TOOLS)!
  return withoutRefinement(tools)
}

/**
 * The marker row the next request of `s` carries, while the session owes it (see `bindRefinement`).
 * It rides in the request's dispatch transaction, so a request prepared and never sent records
 * nothing and the next one carries it again.
 */
export function refinementMarker(s: SessionImpl): EventInput | undefined {
  return owed.has(sessionIdentity(s))
    ? s.ev(REFINEMENT_SESSION, { on: true }, { ignorable: true })
    : undefined
}
