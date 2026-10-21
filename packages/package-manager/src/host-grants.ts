import { freezeData } from './integrity.js'

/** Release assembly policy. These are Host-private inputs, never author manifest permissions. */
export type HostCapabilityGrant = Readonly<{
  sessionTasks?: true
  searchProvider?: true
  trustedHookCommands?: true
  skillDiscovery?: true
  privacyTrajectory?: true
  computerUse?: true
  privateArtifactStore?: true
  contextBlocking?: true
  isolatedHooks?: true
  governanceHooks?: true
  hookRank?: number
}>

export type HostGrantDeclaration = Readonly<{
  packageId: string
  extensions: Readonly<Record<string, HostCapabilityGrant>>
  package: HostCapabilityGrant
  seams: Readonly<Record<string, HostCapabilityGrant>>
}>

/** The distribution selects capabilities; Host must verify the installed identity before using them. */
export const HOST_CAPABILITY_GRANTS: readonly HostGrantDeclaration[] = freezeData([
  {
    packageId: '@agnes/base',
    package: { sessionTasks: true },
    extensions: {
      'agnes/tools-web': { searchProvider: true },
      'agnes/hooks-runner': {
        trustedHookCommands: true,
        contextBlocking: true,
        isolatedHooks: true,
        governanceHooks: true,
      },
      'agnes/mcp-search': { skillDiscovery: true },
      'agnes/privacy': { privacyTrajectory: true, governanceHooks: true },
      'agnes/computer-use': { computerUse: true },
    },
    seams: { artifacts: { privateArtifactStore: true } },
  },
])
