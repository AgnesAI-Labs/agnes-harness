import {
  childAgentRefusal,
  DEFAULT_LOOP,
  modelAllowsTool,
  type PresetView,
  type ToolRegistry,
} from '@agnes/core'
import { type ChildAgentAllowlist, mcpLocalToolPrefix, mcpStablePrefix } from '@agnes/extension-api'
import { clientModuleRowIdForContribution, type RuntimePluginSnapshot } from '@agnes/package-manager'
import type { LoopSelection, RouteTable, SessionCapability, SessionCapabilitySet } from '@agnes/protocol'
import { materializeRoutes } from '../assemble/routes.js'
import type { PresetDoc } from '../presets/types.js'
import { toPresetView } from '../presets/view.js'
import {
  type CompositionPatch,
  type CompositionSource,
  type ResolvedComposition,
  resolveComposition,
} from './composition.js'
import type { ResolvedProfile } from './types.js'

export type { CapabilityReason, SessionCapability, SessionCapabilitySet } from '@agnes/protocol'
export type CapabilityTool = Readonly<{
  name: string
  packageId?: string | undefined
  readOnly: boolean
}>
export type CapabilityResource = Readonly<{ id: string; name?: string; packageId?: string | undefined }>
export type CapabilityModule = Readonly<{
  id: string
  aliases?: readonly string[]
  slots?: readonly string[]
  packageId?: string
}>
export type SessionCapabilityInput = {
  profile?: ResolvedProfile
  /** A durable binding bypasses compilation: never re-apply today's defaults to pinned code. */
  composition?: ResolvedComposition
  selection?: CompositionPatch | undefined
  scope?: ResolvedComposition['toolScope']
  preset?: PresetDoc
  presetView?: PresetView
  admin?: NonNullable<NonNullable<Parameters<typeof resolveComposition>[1]>['admin']>
  session?: CompositionPatch
  sessionBundles?: readonly string[]
  pin?: Readonly<{ generationId?: string | undefined; loop?: LoopSelection; legacy?: boolean }>
  routes?: RouteTable
  computerUseAllowed?: boolean
  childAllowlist?: ChildAgentAllowlist
  childRequest?: { providerId?: string; model?: string }
  resourceRequest?: { kind: 'mcp' | 'skills'; id: string }
  installed?: {
    plugins?: readonly { id: string; enabled: boolean; packageId?: string | undefined }[]
    tools?: readonly CapabilityTool[]
    childEngines?: readonly string[]
    modelAdapters?: readonly string[]
    uiModules?: readonly CapabilityModule[]
  }
  live?: {
    models?: readonly { route: string; api: string }[]
    mcp?: readonly CapabilityResource[]
    skills?: readonly CapabilityResource[]
  }
}
type CapabilityResolution = SessionCapabilitySet &
  Readonly<{
    childRefusal?: ReturnType<typeof childAgentRefusal>
    resourceRequest?: SessionCapability
  }>

const builtin: CompositionSource = { layer: 'default', name: 'builtin' }
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') for (const child of Object.values(value)) immutable(child)
  return Object.freeze(value)
}

/** One pure decision path for admission, runtime reads, invocation policy and inspection.
 * Empty tools/MCP/Skills lists retain defaults; policy.allow and shell lists are literal allowlists.
 * Only safe identities and posture leave this boundary, never factories, credentials or config.
 */
export function resolveSessionCapabilities(input: SessionCapabilityInput): CapabilityResolution {
  const tree = input.composition ?? (input.profile ? resolveComposition(input.profile, input) : undefined)
  const declared = tree?.selection ?? input.selection ?? {}
  // Legacy Hosts never applied composition tool/resource filters. A durable legacy pin retains that catalog.
  const selection: CompositionPatch = input.pin?.legacy
    ? {
        ...declared,
        packages: input.profile?.packages.map(({ id, source, enabled }) => ({ id, source, enabled })) ?? [],
        tools: [],
        mcp: [],
        skills: [],
        toolPolicy: {},
      }
    : declared
  const scope = input.pin?.legacy ? undefined : (tree?.toolScope ?? input.scope)
  const sources = tree?.sources ?? {}
  const source = (field: string): CompositionSource =>
    (input.pin?.legacy && ['tools', 'mcp', 'skills', 'toolPolicy'].includes(field.split('.')[0]!)
      ? { layer: 'session' as const, name: 'legacy-binding' }
      : undefined) ??
    sources[field] ??
    (input.selection?.[field.split('.')[0] as keyof CompositionPatch] !== undefined
      ? { layer: 'profile', name: 'composition' }
      : builtin)
  const preset = input.presetView ?? (input.preset ? toPresetView(input.preset) : undefined)
  const presetSource: CompositionSource = {
    layer: 'preset',
    name: preset?.name ?? tree?.preset ?? 'standard',
  }
  const decision = (
    id: string,
    checks: readonly [boolean, string, CompositionSource][],
  ): SessionCapability => {
    const failed = checks.filter(([ok]) => !ok)
    return {
      id,
      enabled: failed.length === 0,
      reasons: (failed.length ? failed : checks).map(([, rule, from]) => ({ source: from, rule })),
    }
  }
  const packageEnabled = (id?: string) =>
    !selection.packages?.some((pkg) => pkg.id === id && pkg.enabled === false)
  const listAllows = (list: readonly string[] | undefined, ids: readonly string[]) =>
    !list?.length || ids.some((id) => list.includes(id))
  const resource = (kind: 'mcp' | 'skills', item: CapabilityResource) =>
    decision(item.id, [
      [packageEnabled(item.packageId), 'package-enabled', source('packages')],
      [
        listAllows(selection[kind], [
          item.id,
          item.name ?? '',
          item.packageId ?? '',
          ...(kind === 'mcp' ? [item.id.replace(/^mcp\//, ''), 'mcp/' + item.id.replace(/^mcp\//, '')] : []),
        ]),
        `${kind}-selection`,
        source(kind),
      ],
    ])
  const resources = (kind: 'mcp' | 'skills') => {
    const live = input.live?.[kind] ?? []
    const actual = live.map((item) => resource(kind, item))
    if (input.live?.[kind] !== undefined)
      for (const id of selection[kind] ?? []) {
        if (
          !live.some((item) =>
            [item.id, item.name, item.packageId, item.id.replace(/^mcp\//, '')].includes(id),
          )
        )
          actual.push(
            decision(id, [[false, 'resource-unavailable', { layer: 'session', name: 'live-resources' }]]),
          )
      }
    return actual
  }
  const mcpPrefixes = (selection.mcp ?? []).flatMap((id) => {
    const server = id.replace(/^mcp\//, '')
    return [mcpLocalToolPrefix(server), mcpStablePrefix(server)]
  })
  const tools = (input.installed?.tools ?? []).map((tool) =>
    decision(tool.name, [
      [packageEnabled(tool.packageId), 'package-enabled', source('packages')],
      [
        modelAllowsTool(tool.name, input.computerUseAllowed !== false),
        'model-input',
        { layer: 'session', name: 'primary-model' },
      ],
      [
        !scope?.bundlePackages.includes(tool.packageId ?? '') ||
          scope.activePackages.includes(tool.packageId ?? ''),
        'bundle-ownership',
        { layer: 'profile', name: 'bundle-scope' },
      ],
      [!selection.toolPolicy?.readOnly || tool.readOnly, 'read-only', source('toolPolicy.readOnly')],
      [listAllows(selection.tools, [tool.name]), 'tool-selection', source('tools')],
      [
        selection.toolPolicy?.allow === undefined || selection.toolPolicy.allow.includes(tool.name),
        'policy-allow',
        source('toolPolicy.allow'),
      ],
      [!selection.toolPolicy?.deny?.includes(tool.name), 'policy-deny', source('toolPolicy.deny')],
      [
        !tool.name.startsWith('mcp_') ||
          !selection.mcp?.length ||
          selection.mcp.includes(tool.packageId ?? '') ||
          mcpPrefixes.some((prefix) => tool.name.startsWith(prefix)),
        'mcp-selection',
        source('mcp'),
      ],
    ]),
  )
  for (const id of new Set([...(selection.tools ?? []), ...(selection.toolPolicy?.allow ?? [])]))
    if (input.installed?.tools !== undefined && !tools.some((tool) => tool.id === id))
      tools.push(decision(id, [[false, 'tool-unavailable', { layer: 'session', name: 'code-catalog' }]]))
  const surfaces = (['web', 'acp', 'http'] as const).map((id) =>
    decision(id, [
      [
        selection.surfaces === undefined || selection.surfaces.includes(id),
        'surface-selection',
        source('surfaces'),
      ],
    ]),
  )
  const modules = (input.installed?.uiModules ?? []).map((module) => {
    const ids = [module.id, ...(module.aliases ?? [])]
    return decision(module.id, [
      [packageEnabled(module.packageId), 'package-enabled', source('packages')],
      [surfaces[0]!.enabled, 'web-surface', source('surfaces')],
      [listAllows(selection.uiModules, ids), 'ui-selection', source('uiModules')],
      [
        selection.shell?.modules === undefined || ids.some((id) => selection.shell!.modules!.includes(id)),
        'shell-modules',
        source('shell'),
      ],
      [
        selection.shell?.slots === undefined ||
          (!!module.slots?.length && module.slots.every((slot) => selection.shell!.slots!.includes(slot))),
        'shell-slots',
        source('shell'),
      ],
    ])
  })
  const allow = input.childAllowlist
  const childSource: CompositionSource = { layer: 'session', name: 'child-allowlist' }
  const loop =
    input.pin?.loop ??
    (tree ? selection.loop : (input.session?.loop ?? input.admin?.composition?.loop ?? selection.loop)) ??
    preset?.loop ??
    DEFAULT_LOOP
  const routes =
    input.routes ?? (input.profile && preset ? materializeRoutes(preset, input.profile) : undefined)
  return immutable(
    structuredClone({
      ...(tree ? { compositionHash: tree.hash } : {}),
      preset: presetSource.name,
      bundles: tree?.bundles ?? [],
      codePin: {
        ...(input.pin?.generationId ? { generationId: input.pin.generationId } : {}),
        legacy: input.pin?.legacy === true,
        packages: (input.profile?.packages ?? [])
          .filter((pkg) => pkg.enabled)
          .map(({ id, version, integrity }) => ({
            id,
            ...(version ? { version } : {}),
            ...(integrity ? { integrity } : {}),
          })),
      },
      loop: {
        value: loop,
        source: input.pin?.loop
          ? { layer: 'session' as const, name: 'code-pin' }
          : !tree && input.session?.loop
            ? { layer: 'session' as const, name: 'request' }
            : !tree && input.admin?.composition?.loop
              ? { layer: 'admin' as const, name: 'selection' }
              : selection.loop
                ? source('loop')
                : preset?.loop
                  ? presetSource
                  : builtin,
      },
      modelRoutes: { value: routes ?? null, source: presetSource },
      permissions: {
        preset: presetSource.name,
        policy: preset?.approval.policy ?? 'default',
        toolRuntime: preset?.tools.runtime ?? 'default',
        readOnly: selection.toolPolicy?.readOnly === true,
        ...(input.profile ? { approvalMode: input.profile.approvals.mode } : {}),
        source: presetSource,
      },
      sandbox: {
        provider: selection.sandbox?.provider ?? input.profile?.sandbox?.provider ?? 'local',
        onUnavailable: preset?.sandbox.onUnavailable ?? 'deny',
        source: source('sandbox'),
      },
      compaction: {
        engine:
          selection.compaction === null
            ? null
            : (selection.compaction?.engine ?? input.profile?.compaction?.engine ?? null),
        source: source('compaction'),
      },
      persistence: {
        provider: selection.persistence?.provider ?? input.profile?.persistence?.provider ?? 'sqlite',
        source: source('persistence'),
      },
      modelAdapters: (input.installed?.modelAdapters ?? []).map((id) =>
        decision(id, [
          [listAllows(selection.modelAdapters, [id]), 'model-adapter-selection', source('modelAdapters')],
        ]),
      ),
      tools,
      mcp: resources('mcp'),
      skills: resources('skills'),
      uiModules: modules,
      surfaces,
      selectedModelAdapters: [
        ...new Set(
          (input.live?.models ?? [])
            .filter((model) => Object.values(routes ?? {}).some((target) => target?.route === model.route))
            .map((model) => model.api),
        ),
      ],
      ...(input.resourceRequest
        ? {
            resourceRequest: resource(
              input.resourceRequest.kind,
              input.live?.[input.resourceRequest.kind]?.find((item) =>
                [item.id, item.name, item.id.replace(/^mcp\//, '')].includes(input.resourceRequest!.id),
              ) ?? { id: input.resourceRequest.id },
            ),
          }
        : {}),
      packages: (selection.packages ?? []).map((pkg) =>
        decision(pkg.id, [[pkg.enabled !== false, 'package-enabled', source(`packages.${pkg.id}.enabled`)]]),
      ),
      plugins: (input.installed?.plugins ?? tree?.rows ?? []).map((row) =>
        decision(row.id, [
          [packageEnabled(row.packageId), 'package-enabled', source('packages')],
          [
            input.installed?.plugins ? (selection.plugins?.[row.id]?.enabled ?? row.enabled) : row.enabled,
            'plugin-enabled',
            source(`plugins.${row.id}.enabled`),
          ],
        ]),
      ),
      childEngines: (input.installed?.childEngines ?? []).map((id) =>
        decision(id, [
          [
            !childAgentRefusal(allow?.providers ? { providers: allow.providers } : undefined, {
              providerId: id,
            }),
            'child-provider-allowlist',
            childSource,
          ],
        ]),
      ),
      ...(input.childRequest ? { childRefusal: childAgentRefusal(allow, input.childRequest) } : {}),
      childModels: (allow?.models ?? []).map((id) =>
        decision(id, [[true, 'explicit-child-model', childSource]]),
      ),
    }),
  )
}

/** Registry ownership stays with its generation; the resolver receives metadata only. */
export function capabilityToolCatalog(tools: ToolRegistry): readonly CapabilityTool[] {
  return tools.list().map((tool) => ({
    name: tool.name,
    readOnly: tool.meta.isReadOnly,
    packageId: tools.resolve(tool.name)?.packageIdentity,
  }))
}

export function capabilityEnabled(items: readonly SessionCapability[], id: string): boolean {
  return items.some((item) => item.id === id && item.enabled)
}

/** Use the same durable browser row identity as daemon asset routing. */
export function capabilityClientCatalog(
  sources: readonly RuntimePluginSnapshot[],
): readonly CapabilityModule[] {
  return sources.flatMap(({ snapshot }) => {
    const clients = snapshot.contributions.flatMap((entry) =>
      (entry.kind === 'client' || entry.kind === 'extension') && 'client' in entry && entry.client
        ? [{ id: entry.id, client: entry.client }]
        : [],
    )
    return clients.map((entry) => ({
      id: clientModuleRowIdForContribution(
        snapshot.packageId,
        entry.id,
        clients.length,
        entry.client.id ?? entry.id,
      ),
      aliases: [entry.id, snapshot.packageId],
      slots: entry.client.slots ?? [],
      packageId: snapshot.packageId,
    }))
  })
}
