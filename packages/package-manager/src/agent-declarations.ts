import { type DeclaredAgent, validateAgainst } from '@agnes/protocol'
import {
  DeclaredAgent as AgentSchema,
  ApplicationTemplate as ApplicationSchema,
} from '@agnes/protocol/gen/extension-manifest'
import { parsePackageBundleContract } from './bundle-contract.js'

/** Validate static projections from untrusted catalogue and durable snapshot data. */
export function validAgentDeclarations(value: unknown, packageId: string): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > 64) return false
  const refs = new Set<string>()
  for (const item of value) {
    const checked = validateAgainst<DeclaredAgent>(AgentSchema, item)
    if (!checked.ok || !checked.value.ref.startsWith(`${packageId}#`) || refs.has(checked.value.ref))
      return false
    try {
      parsePackageBundleContract(packageId, {
        [checked.value.ref.slice(packageId.length + 1)]: { launch: checked.value.launch },
      })
    } catch {
      return false
    }
    refs.add(checked.value.ref)
  }
  return true
}

export function validApplicationDeclaration(value: unknown): boolean {
  return value === undefined || validateAgainst(ApplicationSchema, value).ok
}
