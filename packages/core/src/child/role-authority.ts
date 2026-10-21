import type { PresetView } from '@agnes/core-common/step/preset'
import type { ToolPolicy } from '@agnes/extension-api'
import { mcpStablePrefix } from '@agnes/extension-api/mcp-naming'
import type { RoleDelegation } from './roles.js'

/** Composition absence (including its wire-level []) retains defaults. */
export type DefaultSelection = { readonly kind: 'selection'; readonly ids: readonly string[] | undefined }
/** A captured upper bound is always literal: [] grants nothing. */
export type LiteralCeiling = { readonly kind: 'ceiling'; readonly ids: readonly string[] }
export const defaultSelection = (ids?: readonly string[]): DefaultSelection => ({
  kind: 'selection',
  ids: ids?.length ? ids : undefined,
})
export const literalCeiling = (ids: readonly string[] | LiteralCeiling): LiteralCeiling =>
  'kind' in ids ? ids : { kind: 'ceiling', ids }
export const selectionAllows = (selection: DefaultSelection, ids: readonly string[]): boolean =>
  selection.ids === undefined || ids.some((id) => selection.ids?.includes(id))
export const ceilingAllows = (ceiling: LiteralCeiling, id: string): boolean => ceiling.ids.includes(id)

export type ResourceCeilings = { readonly mcp: LiteralCeiling; readonly skills: LiteralCeiling }
export const resourceCeilings = (
  resources?: Record<'mcp' | 'skills', readonly string[] | LiteralCeiling>,
): ResourceCeilings => ({
  mcp: literalCeiling(resources?.mcp ?? []),
  skills: literalCeiling(resources?.skills ?? []),
})
export type RoleAuthority = ReturnType<typeof captureAuthority>
const authorities = new WeakMap<RoleDelegation, RoleAuthority>()

/** One normalized view of the backend snapshot, shared by capture, reads, execution and restore. */
export function roleAuthority(snapshot: RoleDelegation): RoleAuthority {
  const authority = authorities.get(snapshot) ?? captureAuthority(snapshot)
  authorities.set(snapshot, authority)
  return authority
}

/** Keep each ancestor's floor independent so a nearer allow cannot mask it. */
export function rolePolicyCeiling(
  authority: RoleAuthority,
  resolve: (policy: string, rules: PresetView['approval']['commandTable']) => ToolPolicy,
): ToolPolicy {
  let parent = resolve(authority.parentPolicy, authority.commandTable)
  for (const ceiling of authority.policyCeilings ?? [])
    parent = authority.toolPolicy(parent, resolve(ceiling.policy, ceiling.commandTable))
  return parent
}

function captureAuthority(snapshot: RoleDelegation) {
  snapshot = structuredClone(snapshot)
  const ownPolicies = new WeakMap<ToolPolicy, WeakMap<ToolPolicy, ToolPolicy>>()
  return {
    ...snapshot,
    tools: literalCeiling(snapshot.tools),
    resources: resourceCeilings(snapshot.resources),
    commandRules: (rules: PresetView['approval']['commandTable']) =>
      snapshot.commandTable?.length ? [...(rules ?? []), ...snapshot.commandTable] : rules,
    preset: (view: PresetView): PresetView => ({
      ...view,
      permission: snapshot.permission,
      generationLimit: snapshot.generationLimit,
      maxFanOut: snapshot.maxFanOut,
      approval: {
        ...view.approval,
        ...(view.approval.policy === 'full-access' ? { policy: 'default' } : {}),
      },
      tools: { ...view.tools, allow: snapshot.tools },
    }),
    toolPolicy: (own: ToolPolicy, parent: ToolPolicy): ToolPolicy => {
      const policies = ownPolicies.get(own) ?? new WeakMap<ToolPolicy, ToolPolicy>()
      ownPolicies.set(own, policies)
      const existing = policies.get(parent)
      if (existing) return existing
      const policy: ToolPolicy = {
        ...own,
        decide: async (...args) => {
          if (snapshot.permission === 'read-only' && !args[0].policy.isReadOnly)
            return {
              effect: 'deny',
              reason: 'Captured parent authority is read-only; hand the action back to the main assistant',
            }
          // Policies decide whether an effect is already admitted. A role may execute an
          // automatic allowance; an actual tool gate waits for a human without granting the role approval authority.
          const [input, signal, ports] = args
          const scoped = { ...input, tainted: input.tainted || snapshot.parentTainted !== false }
          const a = await own.decide(scoped, signal, ports)
          if (a.effect === 'deny') return a
          const b = await parent.decide(scoped, signal, ports)
          return b.effect === 'deny' || (b.effect === 'ask' && a.effect === 'allow') ? b : a
        },
      }
      policies.set(parent, policy)
      return policy
    },
  }
}

export function mcpToolAllowed(
  scope: DefaultSelection | LiteralCeiling,
  name: string,
  packageId = '',
): boolean {
  return (
    !name.startsWith('mcp_') ||
    (scope.kind === 'selection' && (scope.ids === undefined || scope.ids.includes(packageId))) ||
    (scope.ids ?? []).some((id) => name.startsWith(mcpStablePrefix(id.replace(/^mcp\//, ''))))
  )
}

/** Resource IDs are exact instance identities from the effective workspace read facade. */
export const intersectCapabilities = (
  parent: readonly { id: string; enabled: boolean }[],
  role: readonly { id: string; enabled: boolean }[],
): string[] =>
  parent
    .filter((item) => item.enabled && role.some((other) => other.enabled && other.id === item.id))
    .map((item) => item.id)
