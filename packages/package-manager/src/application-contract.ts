import { type ApplicationTemplate, validateAgainst } from '@agnes/protocol'
import { ApplicationTemplate as ApplicationSchema } from '@agnes/protocol/gen/extension-manifest'
import type { PackageBundleCatalog } from './bundle-contract.js'

/** Presentation adoption is deliberately outside this static author contract. */
export function parseApplicationContract(
  input: unknown,
  packageId: string,
  bundles: PackageBundleCatalog,
  dependencies: Readonly<Record<string, string>>,
): { application?: ApplicationTemplate; deploymentDependent: boolean } {
  if (input === undefined) return { deploymentDependent: false }
  const checked = validateAgainst<ApplicationTemplate>(ApplicationSchema, input)
  if (!checked.ok) throw new TypeError('invalid agnes.application')
  const application = checked.value
  if (
    application.defaultAgent &&
    application.agents &&
    !application.agents.includes(application.defaultAgent)
  )
    throw new TypeError('application defaultAgent must be in agents')
  let deploymentDependent = false
  for (const ref of new Set([
    ...(application.agents ?? []),
    ...(application.defaultAgent ? [application.defaultAgent] : []),
  ])) {
    if (Object.hasOwn(bundles, ref)) {
      if (!bundles[ref]?.document.launch) throw new TypeError(`application target is not an agent: ${ref}`)
    } else {
      const owner = ref.slice(0, ref.indexOf('#'))
      if (owner === packageId || !Object.hasOwn(dependencies, owner))
        throw new TypeError(`unknown application agent ${ref}`)
      deploymentDependent = true
    }
  }
  return { application: structuredClone(application), deploymentDependent }
}
