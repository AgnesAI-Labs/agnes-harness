import type { RegisteredTool } from '@agnes/core'
import { HostError } from '@agnes/host-common/errors'
import type { Host, HostSession } from '../lifecycle/host.js'
import { roleToolBindingIdentity } from './role-tool-bindings.js'

export type RoleToolExclusion = { tool: string; reason: string }

/** Explain every declared tool removed by the intersection, including tools absent in the parent. */
export function intersectRoleTools(input: {
  declared: readonly string[]
  parent: readonly RegisteredTool[]
  parentIdentities: ReadonlyMap<string, string | undefined>
  candidate: Host
  enabled: readonly string[]
  allow: readonly string[] | undefined
}): { tools: string[]; excluded: RoleToolExclusion[] } {
  const tools: string[] = []
  const excluded: RoleToolExclusion[] = []
  for (const name of new Set(input.declared)) {
    const parent = input.parent.find((tool) => tool.name === name)
    const role = input.candidate.kernel.tools.resolve(name)
    const parentIdentity = input.parentIdentities.get(name)
    const roleIdentity = role && roleToolBindingIdentity(input.candidate, role)
    const reason = !parent
      ? 'parent-tool-unavailable'
      : !role
        ? 'role-tool-unavailable'
        : !parentIdentity
          ? 'parent-binding-unverified'
          : !roleIdentity
            ? 'role-binding-unverified'
            : parentIdentity !== roleIdentity
              ? 'execution-binding-mismatch'
              : parent.definitionFingerprint !== role.definitionFingerprint
                ? 'definition-mismatch'
                : !input.enabled.includes(name)
                  ? 'role-tool-disabled'
                  : input.allow !== undefined && !input.allow.includes(name)
                    ? 'role-preset-denied'
                    : undefined
    if (reason) excluded.push({ tool: name, reason })
    else tools.push(name)
  }
  return { tools, excluded }
}

/** Diagnostic evidence belongs to the admitting parent even when no child ledger can be opened. */
export async function recordRoleToolIntersection(
  parent: Pick<HostSession, 'd' | 'ev'>,
  role: string,
  declared: readonly string[],
  tools: string[],
  excluded: RoleToolExclusion[],
): Promise<void> {
  if (excluded.length) {
    await parent.d.log.append([
      parent.ev('x/host/role-tool-intersection', { role, declared, tools, excluded }, { ignorable: true }),
    ])
  }
  if (declared.length && !tools.length)
    throw new HostError(
      'E_PRESET_UNSUPPORTED',
      `Role ${role} has no tools after authority intersection; spawn refused. ${excluded.map(({ tool, reason }) => `${tool}: ${reason}`).join('; ')}`,
    )
}
