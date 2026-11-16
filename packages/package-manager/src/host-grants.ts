import { freezeData } from './integrity.js'

/** Release assembly policy. These are Host-private inputs, never author manifest permissions. */
export type HostCapabilityGrant = Readonly<{
  sessionTasks?: true
  childControl?: true
  searchProvider?: true
  trustedHookCommands?: true
  skillDiscovery?: true
  privacyTrajectory?: true
  refinementSettings?: true
  taskScope?: true
  workflowRuns?: true
  computerUse?: true
  privateArtifactStore?: true
  contextBlocking?: true
  isolatedHooks?: true
  governanceHooks?: true
  hookRank?: number
  sessionWork?: true
  autoTitle?: true
  sideCall?: true
  hookTimeoutMs?: number
  /** Bundled application runtime: state directory, owner-level local client and channel access. */
  bundledApp?: true
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
    package: { sessionTasks: true, childControl: true },
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
      'agnes/refine': { refinementSettings: true },
      'agnes/goal': { taskScope: true },
      'agnes/workflow': { workflowRuns: true },
    },
    seams: { artifacts: { privateArtifactStore: true } },
  },
  {
    packageId: '@agnes/judgment',
    package: {},
    extensions: {
      'ext:agnes.judgment/main': { sideCall: true, sessionWork: true, autoTitle: true, hookTimeoutMs: 15000 },
    },
    seams: {},
  },
  {
    packageId: '@agnes/superagent',
    package: {},
    extensions: { 'ext:agnes.superagent/main': { bundledApp: true } },
    seams: {},
  },
])

/** The release grant one row of an optional bundled package receives once its package is proven: only
 * an in-process row the declaration names gets the package grant merged with its own. */
export function optionalRowGrant(
  declaration: HostGrantDeclaration,
  row: Readonly<{ id: string; runtime: string }>,
): HostCapabilityGrant | undefined {
  const extension = row.runtime === 'in-process' ? declaration.extensions[row.id] : undefined
  return extension ? { ...declaration.package, ...extension } : undefined
}
