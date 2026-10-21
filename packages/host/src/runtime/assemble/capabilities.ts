import type { SessionImpl, ToolRegistry } from '@agnes/core'
import type { ResourceEntry } from '@agnes/extension-api'
import { resolvePreset } from '@agnes/host-common/presets/resolve'
import {
  type CompositionPatch,
  type ResolvedComposition,
  resolveComposition,
} from '@agnes/host-common/profile/composition'
import { sandboxProviderCatalog } from '@agnes/host-providers/adapters/sandbox-providers'
import { compactionEngineCatalog } from '@agnes/host-providers/assemble/compaction-engines'
import { modelAdapterCatalog } from '@agnes/host-providers/assemble/model-adapters'
import {
  capabilityClientCatalog,
  capabilityToolCatalog,
  resolveSessionCapabilities,
} from '../profile/session-capabilities.js'
import type { BootRows } from './boot-rows.js'
import { childAgentCatalog } from './child-agents.js'
import type { AssemblyContext } from './context.js'
import type { PackageSet } from './packages.js'
import type { PresetCatalog } from './presets.js'
import type { ProviderStage } from './provider-stage.js'
import type { RuntimeTargetHost } from './runtime-target.js'
import type { SkillState } from './skills.js'

/** A session's capability set; `call` narrows it to one tool call or resource request. */
export type SessionCapabilitiesFn = (
  sessionKey: string,
  tools?: ToolRegistry,
  call?: {
    name?: string
    readOnly?: boolean
    mcpServer?: string
    session?: SessionImpl
    resources?: readonly ResourceEntry[]
  },
) => ReturnType<typeof resolveSessionCapabilities>

/**
 * What a session may use: the composition the profile and preset resolve to, intersected with
 * what is installed and live. It is read by tool-call admission, resource discovery and the
 * runtime view, all of which run after the kernel exists.
 */
export function createCapabilities(
  ctx: AssemblyContext,
  input: Readonly<{
    pkgs: PackageSet
    presets: PresetCatalog
    bootRows: BootRows
    providerStage: ProviderStage
    runtimeTarget: RuntimeTargetHost
    skillState: SkillState
    discoveredResources: WeakMap<SessionImpl, readonly ResourceEntry[]>
  }>,
) {
  const { deps } = ctx
  const { pkgs, presets, bootRows, providerStage, runtimeTarget, skillState, discoveredResources } = input
  const compositionForPreset = (name?: string, session?: CompositionPatch): ResolvedComposition =>
    resolveComposition(ctx.profile, {
      ...(name ? { preset: resolvePreset(name, presets.presets, { limits: ctx.profile.limits }).doc } : {}),
      ...(session ? { session } : {}),
      rows: bootRows.builtOrdinary.rows.map((row) => ({
        id: row.id,
        packageId: bootRows.compositionOwners.get(row.id)!,
        enabled: !row.disabled,
      })),
      catalog: {
        loops: ctx.live.kernel.get().loops.catalog(),
        modelAdapters: modelAdapterCatalog(runtimeTarget.pluginTree.root),
        compactionEngines: compactionEngineCatalog(runtimeTarget.pluginTree.root),
        sandboxProviders: sandboxProviderCatalog(runtimeTarget.pluginTree.root),
        persistenceProviders: [
          { id: 'sqlite' },
          ...[...pkgs.modules.values()].flatMap((module) =>
            module.persistenceProvider ? [{ id: module.persistenceProvider.id }] : [],
          ),
        ],
      },
    })
  const sessionCapabilities: SessionCapabilitiesFn = (
    sessionKey,
    tools = runtimeTarget.rawSessionRuntime(sessionKey).tools,
    call,
  ) => {
    const session = call?.session ?? ctx.live.kernel.get().get(sessionKey)
    // Preview admission uses the same primary-model gate as a live session. Unknown or
    // ambiguous models expose no image tools, just as Core's session gate does.
    const primary = providerStage.routes?.primary
    const models = providerStage.provider
      .models()
      .filter((model) => model.route === primary?.route && model.id === primary?.model)
    const previewImageInput =
      models.length === 1 && models[0]!.input.includes('text') && models[0]!.input.includes('image')
    const registered = session?.currentResources().snapshot() ?? ctx.live.kernel.get().resources.snapshot()
    const resources = [
      ...new Map(
        [
          ...registered.map(({ entry }) => entry),
          ...(call?.resources ?? (session ? discoveredResources.get(session) : undefined) ?? []),
        ].map((entry) => [entry.id, entry]),
      ).values(),
    ]
    return resolveSessionCapabilities({
      profile: ctx.profile,
      ...(session?.d.roleDelegation
        ? { resourceScope: session.d.roleDelegation.resources ?? { mcp: [], skills: [] } }
        : {}),
      adapterCatalog: modelAdapterCatalog(runtimeTarget.pluginTree.root),
      composition:
        deps.compositionPin ??
        (ctx.profile.composition
          ? compositionForPreset(session?.preset.name)
          : resolveComposition(ctx.profile, {
              preset: resolvePreset(session?.preset.name ?? ctx.profile.presets.default, presets.presets, {
                limits: ctx.profile.limits,
              }).doc,
            })),
      ...(session
        ? {
            presetView: session.preset,
            routes: {
              ...Object.fromEntries(
                Object.entries(session.preset.model.route).map(([slot, route]) => [
                  slot,
                  { route, model: session.preset.model.id[slot] ?? route },
                ]),
              ),
              primary: {
                route: session.preset.model.route.primary!,
                model: session.preset.model.id.primary ?? session.preset.model.route.primary!,
              },
            },
            pin: {
              legacy: !ctx.profile.composition,
              loop: session.loop,
              generationId: deps.sessionGeneration?.(sessionKey),
            },
          }
        : { presetView: providerStage.view }),
      installed: {
        plugins: ctx.live.extensionRows
          .get()
          .current()
          .map((row) => ({
            id: row.id,
            enabled: !row.disabled,
            packageId: bootRows.compositionOwners.get(row.id),
          })),
        tools: capabilityToolCatalog(tools).map((tool) =>
          call?.name === tool.name ? { ...tool, readOnly: tool.readOnly && call.readOnly === true } : tool,
        ),
        modelAdapters: modelAdapterCatalog(runtimeTarget.pluginTree.root).map((entry) => entry.id),
        childEngines: childAgentCatalog(runtimeTarget.pluginTree.root).map((entry) => entry.id),
        uiModules: capabilityClientCatalog(pkgs.activeRuntimeSources),
      },
      computerUseAllowed: session ? session.computerUseAllowed() : previewImageInput,
      ...(runtimeTarget.pluginTree.root.childAgents.allowlist(sessionKey)
        ? { childAllowlist: runtimeTarget.pluginTree.root.childAgents.allowlist(sessionKey)! }
        : {}),
      ...(call?.mcpServer ? { resourceRequest: { kind: 'mcp', id: call.mcpServer } as const } : {}),
      live: {
        models: session?.d.provider.models() ?? [],
        mcp: resources
          .filter((entry) => entry.kind === 'mcp')
          .map((entry) => ({ id: entry.id, name: entry.name })),
        skills: [
          ...new Map(
            [
              ...(skillState.available?.list() ?? []).map((skill) => ({
                id: skill.resourceId,
                name: skill.name,
                packageId: skillState.owners.get(skill.resourceId),
              })),
              ...resources
                .filter((entry) => entry.kind === 'skill')
                .map((entry) => ({
                  id: entry.id,
                  name: entry.name,
                  packageId: skillState.owners.get(entry.id),
                })),
            ].map((entry) => [entry.id, entry]),
          ).values(),
        ],
      },
    })
  }
  ctx.live.sessionCapabilities.set(sessionCapabilities)
  return { compositionForPreset, sessionCapabilities }
}
