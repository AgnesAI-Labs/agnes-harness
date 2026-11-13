import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { API_VERSION, type SideModelEntry } from '@agnes/extension-api'
import { pinOptionalBundledRowGrants } from '@agnes/host-extensions/assemble/host-grants'
import { ExtensionOwners } from '@agnes/host-extensions/ext-host/extension-owners'
import { createExtensionOrder } from '@agnes/host-extensions/ext-host/extension-status-book'
import { createRowExtensionHost } from '@agnes/host-extensions/ext-host/row-extension-host'
import { createRowServiceHost } from '@agnes/host-extensions/ext-host/row-services'
import { ownedStore } from '@agnes/host-extensions/profile/owned-store'
import { RuntimePluginCatalogue } from '@agnes/host-providers/runtime-plugin-catalogue'
import { parseAgnesPluginEntries, readPluginCapabilities } from '@agnes/package-manager'
import { channelState } from './channel-state.js'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
import type { ProcessServices } from './process-services.js'
import type { WorkspaceRuntimeFactory } from './workspace-runtime.js'

/**
 * The hosts for what third-party plugin rows register (`ctx.extension()`, row services) and the
 * catalogue of immutable plugin snapshots those rows come from. They exist before the first tree
 * so that tree can hand rows the services; they stay dormant until the kernel is up.
 */
export function createRowHosts(
  ctx: AssemblyContext,
  pkgs: PackageSet,
  workspaceRuntime: WorkspaceRuntimeFactory,
  proc: ProcessServices,
) {
  const { deps, say } = ctx
  const { activeRuntimeSources } = pkgs
  const bootCatalogue = deps.runtimePluginCatalogue ?? activeRuntimeSources
  const channels = channelState(proc.adapters.storage.metadata, ctx.profile.name)
  channels.rememberSources(bootCatalogue)
  const pluginCatalogue = new RuntimePluginCatalogue(bootCatalogue)
  let sideModels: () => readonly SideModelEntry[] = () => []
  const hostGrants = pinOptionalBundledRowGrants(ctx.profile.packages, (packageId, snapshotId) =>
    pluginCatalogue.get(packageId, snapshotId),
  )
  const extensionInfo = {
    agnesVersion: deps.agnesVersion ?? '0.0.0',
    apiVersion: API_VERSION,
    profileName: ctx.profile.name,
  }
  const extensionOrder = createExtensionOrder()
  // Which supplier holds an `ext:` row id: shared by builtin rows and plugin rows that replace them.
  const extensionOwners = new ExtensionOwners()
  // Registrations made by third-party plugin rows through ctx.extension(). It exists before the
  // first tree so that tree can hand rows the service; it stays dormant until the kernel is up.
  const requestSkillInstall = deps.skillInstall
  const rowExtensions = createRowExtensionHost({
    hostGrants,
    sideModels: () => sideModels(),
    projectionNames: (origin) => rowServices.projectionNames(origin),
    store: ({ owner, integrity, revision, alive }) =>
      ownedStore(
        proc.adapters.storage.metadata.namespace(owner, `profile:${ctx.profile.name}`),
        () => {
          alive()
          proc.profileActivations.require(owner, integrity, undefined, revision)
        },
        true,
      ),
    bindWake: async ({ owner, packageId, version, integrity, revision, session: ref }) => {
      const session = ctx.live.kernel.get().get(ref.key)
      if (!session || session.closingOrClosed || session.lane !== ref.lane)
        throw new Error('Wake target unavailable')
      proc.profileActivations.require(owner, integrity, undefined, revision)
      return proc.profileWakes.bind(
        {
          ...(packageId ? { producerPackageId: packageId } : {}),
          ...(version ? { producerVersion: version } : {}),
          actorOrg: session.d.actor.org,
          producerOwner: owner,
          producerIntegrity: integrity,
          profileId: ctx.profile.name,
          sessionId: session.key,
          laneId: session.lane,
          generationId: deps.sessionGeneration?.(session.key) ?? ctx.profile.hash,
          actorId: session.d.actor.id,
        },
        ref.toolUseId,
      )
    },
    ...(deps.mcpManage ? { mcpManage: deps.mcpManage } : {}),
    ...(deps.pluginManage ? { pluginManage: deps.pluginManage } : {}),
    ...(requestSkillInstall
      ? {
          skillInstall: async (invocation, signal) => {
            const session = ctx.live.kernel.get().get(invocation.sessionKey)
            if (!session) throw new Error('Skill installation session unavailable')
            const digest = deps.workspacePolicyDigestFor?.(invocation.sessionKey)
            const plan = [...workspaceRuntime.workspacePlans.values()].find(
              (plan) => plan.policy.digest === digest,
            )
            if (!plan) throw new Error('Skill installation workspace policy unavailable')
            return requestSkillInstall(
              {
                ...invocation,
                pathPolicy: { policy: plan.policy, caseSensitive: plan.semantics.caseSensitive },
                deniedPaths: plan.policy.rules
                  .filter((rule) => rule.effect === 'deny')
                  .map((rule) => rule.path),
              },
              signal,
            )
          },
        }
      : {}),
    info: extensionInfo,
    log: deps.log,
    audit: say,
    order: extensionOrder,
    owners: extensionOwners,
    describePackage: (packageId, snapshotId, exportName, rowId) => {
      const description = pluginCatalogue.describe(packageId, snapshotId)
      const source = pluginCatalogue.get(packageId, snapshotId)
      const declaredCapabilities = source
        ? readPluginCapabilities(source.snapshot.directory, exportName)
        : undefined
      const row = source
        ? parseAgnesPluginEntries(
            packageId,
            JSON.parse(readFileSync(join(source.snapshot.directory, 'package.json'), 'utf8')).agnes?.plugins,
          ).find((entry) => entry.id === rowId && entry.export === exportName)
        : undefined
      return (
        description && {
          ...description,
          ...(row?.inject?.includes('sideCall') && row.runtime === 'in-process'
            ? { sideCallDeclared: true }
            : {}),
          ...(declaredCapabilities === undefined ? {} : { declaredCapabilities }),
        }
      )
    },
  })
  const describeServices = (packageId: string, snapshotId: string, exportName?: string) => {
    const description = pluginCatalogue.describe(packageId, snapshotId)
    const source = pluginCatalogue.get(packageId, snapshotId)
    const declaredCapabilities = source
      ? readPluginCapabilities(source.snapshot.directory, exportName)
      : undefined
    return description && { ...description, ...(declaredCapabilities ? { declaredCapabilities } : {}) }
  }
  const rowServices = createRowServiceHost(describeServices, {
    ...(deps.channelInteractions ? { channelInteractions: deps.channelInteractions } : {}),
    ...(deps.channelRuntime ? { channelRuntime: deps.channelRuntime } : {}),
    channelStateDirectory: join(deps.dataDir, 'channels'),
    channelScope: {
      home: dirname(dirname(deps.profileDir)),
      profile: ctx.profile.name,
      dataDir: deps.dataDir,
      workspace: deps.workspaceRoot,
    },
    resolveSecret: proc.secrets,
    channelLog: deps.log,
    channelDirectory: proc.channelDirectory,
    channelRemember: channels.remember,
    channelTargets: proc.channelTargets,
    channelCurrent: (owner, integrity, revision) =>
      proc.profileActivations.require(owner, integrity, undefined, revision),
    managed: proc.profileManaged,
    streams: proc.profileStreams,
    namespace: (owner, name) =>
      proc.adapters.storage.metadata.namespace(owner, `profile:${ctx.profile.name}:${name}`),
    describe: describeServices,
  })
  // Like a loader importing by name at update time: each target sees what is installed now.
  const refreshPluginCatalogue = async () => {
    if (!deps.runtimePluginSources) return
    const sources = new Map(
      bootCatalogue.map((source) => [`${source.snapshot.packageId}\0${source.snapshot.snapshotId}`, source]),
    )
    // The refreshed record wins: it carries the current trust decision for that snapshot.
    for (const source of await deps.runtimePluginSources()) {
      sources.set(`${source.snapshot.packageId}\0${source.snapshot.snapshotId}`, source)
    }
    const refreshed = [...sources.values()]
    channels.rememberSources(refreshed)
    pluginCatalogue.replace(refreshed)
  }
  return {
    sideModels: () => sideModels(),
    setSideModels(read: () => readonly SideModelEntry[]) {
      sideModels = read
    },
    bootCatalogue,
    pluginCatalogue,
    extensionInfo,
    extensionOrder,
    extensionOwners,
    rowExtensions,
    rowServices,
    refreshPluginCatalogue,
  }
}

export type RowHosts = ReturnType<typeof createRowHosts>
