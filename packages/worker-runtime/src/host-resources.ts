import type { HostOptions, ResolvedProfile } from '@agnes/host'

/** Runtime capabilities already bootstrapped for this worker; reuse them without reconnecting. */
export type WorkerHostSkillResources = Readonly<{
  scheduling?: NonNullable<HostOptions['scheduling']>
  decisionsChanged?: NonNullable<HostOptions['decisionsChanged']>
  boundWakes?: NonNullable<HostOptions['boundWakes']>
  mcpManage?: NonNullable<HostOptions['mcpManage']>
  pluginManage?: NonNullable<HostOptions['pluginManage']>
  skillInstall?: NonNullable<HostOptions['skillInstall']>
  /** The same bounded, session-scoped artifact reader used by the executable-owned Host path. */
  requestMedia: NonNullable<HostOptions['requestMedia']>
  skillResources?: NonNullable<HostOptions['skillResources']>
  skillContribution?: NonNullable<HostOptions['skillContribution']>
  runtimePluginSnapshots?: NonNullable<HostOptions['runtimePluginSnapshots']>
  runtimePluginCatalogue?: NonNullable<HostOptions['runtimePluginCatalogue']>
  runtimePluginSources?: NonNullable<HostOptions['runtimePluginSources']>
  deferInitialGeneration?: boolean
  restoreGenerationExtension?: NonNullable<HostOptions['restoreGenerationExtension']>
  managedExtensionPackageIds?: NonNullable<HostOptions['managedExtensionPackageIds']>
  /** Trusted daemon-to-worker authority for narrowly scoped surface service calls. */
  serviceAuthority?: NonNullable<HostOptions['serviceAuthority']>
}>

/** Only a supervisor-gated, initially empty MCP deployment may omit its temporary generation. */
export function workerBootGenerationOptions(
  source: string | undefined,
  hasMcpRows: boolean,
): Pick<HostOptions, 'deferInitialGeneration'> {
  return (source === 'bootstrap' || source === 'lastGood') && !hasMcpRows
    ? { deferInitialGeneration: true }
    : {}
}

/** Explicit profile packages can supply presets only from their exact active immutable pins. */
export async function workerBootPackageSnapshots(
  profile: ResolvedProfile,
  sources: NonNullable<HostOptions['runtimePluginSources']>,
): Promise<Pick<HostOptions, 'runtimePluginSnapshots'>> {
  const packages = new Map(
    (profile.packages ?? [])
      .filter((pkg) => pkg.enabled && pkg.trust !== 'builtin')
      .map((pkg) => [pkg.id, pkg.integrity]),
  )
  return packages.size
    ? {
        runtimePluginSnapshots: (await sources()).filter(
          (source) => packages.get(source.snapshot.packageId) === source.snapshot.integrity,
        ),
      }
    : {}
}
