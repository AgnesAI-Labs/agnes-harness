import {
  type ApplicationPreview,
  type ApplicationSelection,
  type ApplicationTemplate,
  jcs,
  type PackageContributionSummary,
  sha256Hex,
  validateAgainst,
} from '@agnes/protocol'
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
  for (const ref of application.delegableAgents ?? [])
    if (!application.agents?.includes(ref))
      throw new TypeError('application delegableAgents must be in agents')
  if (application.delegatedFullAccess && !application.delegableAgents?.length)
    throw new TypeError('application delegatedFullAccess requires delegableAgents')
  const workbench = application.workbench
  for (const rows of [workbench?.tabs ?? [], workbench?.actions ?? []])
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new TypeError('duplicate application workbench id')
  for (const tab of workbench?.tabs ?? [])
    if ((tab.view === 'page') !== (tab.page !== undefined))
      throw new TypeError('application page tab requires exactly one page')
  for (const action of workbench?.actions ?? []) {
    const agent = action.agent ?? application.defaultAgent
    if (!agent || (application.agents && !application.agents.includes(agent)))
      throw new TypeError('application action requires a visible agent')
    if (action.focusTab && !workbench?.tabs?.some((tab) => tab.id === action.focusTab))
      throw new TypeError('unknown application action tab')
  }
  let deploymentDependent = false
  for (const ref of new Set([
    ...(application.agents ?? []),
    ...(application.defaultAgent ? [application.defaultAgent] : []),
    ...(application.workbench?.actions ?? []).flatMap((action) => (action.agent ? [action.agent] : [])),
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
  for (const tab of application.workbench?.tabs ?? []) {
    if (
      tab.page?.startsWith(`${packageId}#`) &&
      !contributions.some(
        (contribution) =>
          'client' in contribution &&
          contribution.client?.lifetime === 'profile' &&
          contribution.client.homeEntries?.some((entry) => `${packageId}#${entry.id}` === tab.page),
      )
    )
      throw new TypeError(`unknown application tab page ${tab.page}`)
  }
  for (const ref of [
    ...(application.presentation?.navigation?.entries ?? []),
    ...(application.presentation?.home ? [application.presentation.home] : []),
    ...(application.workbench?.tabs ?? []).flatMap((tab) => (tab.page ? [tab.page] : [])),
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

/** Validates only the persisted consent envelope; callers own current admission and plan coverage. */
export function applicationConsentSnapshot(
  selection: ApplicationSelection | null | undefined,
): ApplicationPreview | undefined {
  const snapshot = selection?.consentSnapshot
  if (!selection || !snapshot) return undefined
  const { consentDigest, ...body } = snapshot
  if (
    snapshot.packageId !== selection.packageId ||
    snapshot.integrity !== selection.integrity ||
    snapshot.declaration.id !== selection.applicationId ||
    snapshot.declarationDigest !== selection.declarationDigest ||
    sha256Hex(jcs(snapshot.declaration)) !== selection.declarationDigest ||
    consentDigest !== selection.consentDigest ||
    sha256Hex(jcs(body)) !== consentDigest
  )
    return undefined
  return snapshot
}
