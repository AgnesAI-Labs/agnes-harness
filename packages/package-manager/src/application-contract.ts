import { type ApplicationTemplate, type PackageContributionSummary, validateAgainst } from '@agnes/protocol'
import { ApplicationTemplate as ApplicationSchema } from '@agnes/protocol/gen/extension-manifest'
import type { PackageBundleCatalog } from './bundle-contract.js'

/** Presentation adoption is deliberately outside this static author contract. */
export function parseApplicationContract(
  input: unknown,
  packageId: string,
  bundles: PackageBundleCatalog,
  dependencies: Readonly<Record<string, string>>,
  contributions: readonly PackageContributionSummary[] = [],
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
  const pages = contributions.flatMap((c) =>
    'client' in c && c.client?.lifetime === 'profile'
      ? [...(c.client.examplePages ?? []), ...(c.client.homeEntries ?? []).map((p) => p.id)]
      : [],
  )
  for (const ref of [
    ...(application.presentation?.navigation?.entries ?? []),
    ...(application.presentation?.home ? [application.presentation.home] : []),
  ]) {
    const [owner, page] = ref.split('#')
    if (owner === packageId) {
      if (!pages.includes(page ?? '')) throw new TypeError(`unknown application page ${ref}`)
    } else if (!owner || !Object.hasOwn(dependencies, owner))
      throw new TypeError(`unknown application page ${ref}`)
    else deploymentDependent = true
  }
  if (
    application.presentation?.skin &&
    !contributions.some((c) => 'skins' in c && c.skins?.some((s) => s.id === application.presentation?.skin))
  )
    throw new TypeError('unknown application skin')
  for (const [role, target] of Object.entries(application.presentation?.roles ?? {})) {
    if (target.packageId === packageId) {
      if (
        !contributions.some(
          (c) =>
            'client' in c &&
            c.client?.lifetime === 'profile' &&
            (c.client.id ?? c.id) === target.clientId &&
            c.client.presentationRoles?.includes(role as import('@agnes/protocol').PresentationRole),
        )
      )
        throw new TypeError(`undeclared application role ${role}`)
    } else if (!Object.hasOwn(dependencies, target.packageId))
      throw new TypeError(`unknown application role package ${target.packageId}`)
    else deploymentDependent = true
  }
  return { application: structuredClone(application), deploymentDependent }
}
