import { createHash } from 'node:crypto'
import { clientReleaseEvidence, type InstalledPackage, type VerifiedClientTree } from '@agnes/package-manager'
import {
  type ClientContribution,
  type ClientModuleRosterRow,
  jcs,
  type PresentationRole,
} from '@agnes/protocol'
import { validUiComponentDeclaration } from '@agnes/protocol/intelligent-ui'

export type PresentationGrant = Readonly<{
  packageId: string
  clientId: string
  rowId: string
  declarationDigest: string
  consent: string
  roles: readonly PresentationRole[]
  roleChoice?: true
  pages: readonly string[]
}>

export type PresentationObservation = Readonly<{
  revision: number
  grants: readonly PresentationGrant[]
  current(): Promise<boolean>
}>

export type ReleaseEvidence = typeof clientReleaseEvidence
export type DocumentAdmission = NonNullable<ClientModuleRosterRow['documentAdmission']>
export type ClientAdmission =
  | { kind: 'native'; evidence: string; source: 'release' }
  | {
      kind: 'native'
      evidence: string
      source: 'approved-presentation'
      grants: readonly PresentationGrant[]
      presentationRevision: number
    }
  | { kind: 'isolated-component' }
  | { kind: 'denied' }

export const admissionDigest = (value: unknown) => createHash('sha256').update(jcs(value)).digest('hex')

export function installedClientTree(row: InstalledPackage): VerifiedClientTree | undefined {
  if (!row.directory || !row.entry.treeIntegrity || !row.entry.source) return undefined
  return {
    packageId: row.id,
    directory: row.directory,
    source: row.entry.source,
    version: row.entry.version,
    integrity: row.entry.integrity,
    treeIntegrity: row.entry.treeIntegrity,
    capabilityHash: row.capabilityHash,
    contributions: row.contributions,
  }
}

export function admitClient(input: {
  release?: string | undefined
  installed: boolean
  profile: string
  tree: VerifiedClientTree
  rowId: string
  clientId: string
  client: ClientContribution
  presentation?: PresentationObservation | undefined
}): ClientAdmission {
  const { client, tree, presentation } = input
  if (client.intelligentComponents?.length) {
    const components = client.intelligentComponents
    if (
      client.slots?.length ||
      client.styles?.length ||
      client.services?.length ||
      client.streams?.length ||
      client.assets?.length ||
      client.homeEntries?.length ||
      client.examplePages?.length ||
      client.presentationRoles?.length ||
      components.length > 16 ||
      new Set(components.map(({ kind }) => kind)).size !== components.length ||
      components.some(
        (item) => !item.kind.startsWith(`${tree.packageId}/`) || !validUiComponentDeclaration(item),
      )
    )
      return { kind: 'denied' }
    return { kind: 'isolated-component' }
  }
  if (input.release) return { kind: 'native', evidence: input.release, source: 'release' }
  if (
    !input.installed ||
    client.lifetime !== 'profile' ||
    !presentation ||
    !Number.isSafeInteger(presentation.revision) ||
    presentation.revision < 0
  )
    return { kind: 'denied' }
  const declarationDigest = admissionDigest(client)
  const grants = presentation.grants.filter(
    (grant) =>
      grant.packageId === tree.packageId &&
      grant.rowId === input.rowId &&
      grant.clientId === input.clientId &&
      grant.declarationDigest === declarationDigest,
  )
  if (!grants.length || !tree.source) return { kind: 'denied' }
  return {
    kind: 'native',
    source: 'approved-presentation',
    grants,
    presentationRevision: presentation.revision,
    evidence: admissionDigest([
      input.profile,
      presentation.revision,
      input.rowId,
      input.clientId,
      tree.packageId,
      tree.version,
      tree.source,
      tree.integrity,
      tree.treeIntegrity,
      tree.capabilityHash,
      declarationDigest,
      grants,
    ]),
  }
}
