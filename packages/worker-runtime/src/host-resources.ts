import type { HostOptions } from '@agnes/host'

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
  restoreGenerationExtension?: NonNullable<HostOptions['restoreGenerationExtension']>
  managedExtensionPackageIds?: NonNullable<HostOptions['managedExtensionPackageIds']>
  /** Trusted daemon-to-worker authority for narrowly scoped surface service calls. */
  serviceAuthority?: NonNullable<HostOptions['serviceAuthority']>
}>
