import type { ToolPolicyRegistry } from '@agnes/core-effects/effects/tool-providers'
import { rolePolicyCeiling } from '../child/role-authority.js'
import { carriesFloor, sessionCommandFloor } from '../command-table/floor.js'
import type { SessionImpl } from './session.js'

/** One session's floor, reading what the current turn's tools declared and the session's switches. */
export function sessionFloor(session: Pick<SessionImpl, 'turn' | 'd'>) {
  return sessionCommandFloor(
    (tool) => session.turn?.snapshot.byName.get(tool)?.meta.commandArg,
    (input, signal) => session.d.commandPathScope?.(input, signal) ?? Promise.resolve(undefined),
    (tool) => session.turn?.snapshot.byName.get(tool)?.meta,
    () => session.d.outwardCommandRules === true,
  )
}

/** Resolve the live session policy under its command table and captured role ceilings. */
export function effectiveToolPolicy(
  session: Pick<SessionImpl, 'roleAuthority' | 'preset'>,
  policies: Pick<ToolPolicyRegistry, 'resolve'>,
  floor: ReturnType<typeof sessionCommandFloor>,
  selection?: string,
) {
  const captured = session.roleAuthority
  const own = floor(
    policies.resolve(selection ?? session.preset.approval.policy ?? 'default'),
    // Inherit the captured table so the role's default policy admits the same automatic effects.
    captured?.commandRules(session.preset.approval.commandTable) ?? session.preset.approval.commandTable,
  )
  if (!captured) return own
  return carriesFloor(
    captured.toolPolicy(
      own,
      rolePolicyCeiling(captured, (policy, rules) => floor(policies.resolve(policy), rules)),
    ),
    own,
  )
}
