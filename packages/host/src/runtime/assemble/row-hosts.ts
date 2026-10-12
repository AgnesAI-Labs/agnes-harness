import { API_VERSION } from '@agnes/extension-api'
import { ExtensionOwners } from '@agnes/host-extensions/ext-host/extension-owners'
import { createExtensionOrder } from '@agnes/host-extensions/ext-host/extension-status-book'
import { createRowExtensionHost } from '@agnes/host-extensions/ext-host/row-extension-host'
import { createRowServiceHost } from '@agnes/host-extensions/ext-host/row-services'
import { RuntimePluginCatalogue } from '@agnes/host-providers/runtime-plugin-catalogue'
import { readPluginCapabilities } from '@agnes/package-manager'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
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
) {
  const { deps, say } = ctx
  const { activeRuntimeSources } = pkgs
  const bootCatalogue = deps.runtimePluginCatalogue ?? activeRuntimeSources
  const pluginCatalogue = new RuntimePluginCatalogue(bootCatalogue)
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
    describePackage: (packageId, snapshotId) => {
      const description = pluginCatalogue.describe(packageId, snapshotId)
      const source = pluginCatalogue.get(packageId, snapshotId)
      const declaredCapabilities = source ? readPluginCapabilities(source.snapshot.directory) : undefined
      return (
        description && {
          ...description,
          ...(declaredCapabilities === undefined ? {} : { declaredCapabilities }),
        }
      )
    },
  })
  const rowServices = createRowServiceHost((packageId, snapshotId) =>
    pluginCatalogue.describe(packageId, snapshotId),
  )
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
    pluginCatalogue.replace([...sources.values()])
  }
  return {
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
