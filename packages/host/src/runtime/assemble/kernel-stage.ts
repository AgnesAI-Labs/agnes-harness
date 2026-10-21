import { dirname } from 'node:path'
import { type ApprovalGrantsPort, DEFAULT_LOOP, type HookPort, Kernel, type SessionImpl } from '@agnes/core'
import {
  type LeaseView,
  type MemorySession,
  memoryKind,
  type ResourceEntry,
  systemPromptKind,
  toolPolicyKind,
  toolRuntimeKind,
} from '@agnes/extension-api'
import { createProductionImageInputTokenFallback } from '@agnes/host-artifacts/request-media-runtime'
import { resolvePreset } from '@agnes/host-common/presets/resolve'
import type { HostPluginTreeBase } from '@agnes/host-extensions/assemble/seams-cordis'
import { leaseFor, ROW_BOUND_LEASE_TTL_MS } from '@agnes/host-extensions/ext-host/lease'
import { ExtensionSessions } from '@agnes/host-extensions/ext-host/session-bindings'
import { createPublicFetch } from '@agnes/host-infrastructure/adapters/public-fetch/index'
import { SystemPromptSettingsStore } from '@agnes/host-infrastructure/system-prompt-settings'
import { assembleCompaction } from '@agnes/host-providers/assemble/compaction'
import { correlatedLogger } from '@agnes/observability'
import { createNetFetch } from '../adapters/index.js'
import type { ComputerUseHost } from '../computer-use/index.js'
import { capabilityEnabled } from '../profile/session-capabilities.js'
import { createSessionHookPort, readTelemetryConsent } from '../sessions/session-hooks.js'
import { hostCommandPathScope } from './command-path-scope.js'
import type { AssemblyContext } from './context.js'
import type { PresetCatalog } from './presets.js'
import type { ProcessServices } from './process-services.js'
import type { ProviderStage } from './provider-stage.js'
import type { RuntimeTargetHost } from './runtime-target.js'
import type { SeamSet } from './seam-set.js'
import type { SkillState } from './skills.js'

/** Hook leases an extension host registers once it exists; the kernel asks them per hook source. */
export type ExtensionLeases = { current?: (source: string) => LeaseView | undefined }

/**
 * Selects what the Kernel runs on from the published tree: the compaction engine, the loop
 * (a profile choice becomes part of the profile), the tool runtime and policy, and the system prompt.
 */
async function selectCoreProviders(
  ctx: AssemblyContext,
  pluginTree: HostPluginTreeBase,
  view: ProviderStage['view'],
) {
  const { providerSelections } = ctx
  const compaction =
    ctx.profile.composition?.providers?.compaction === null
      ? undefined
      : await assembleCompaction(pluginTree.root.compactionEngines, ctx.profile.compaction)
  const selectedLoop = providerSelections.loop
  const loopFactory = selectedLoop
    ? pluginTree.root.loops.resolve({
        id: selectedLoop.provider,
        version: selectedLoop.version ?? pluginTree.root.providers.select('loop', selectedLoop).version,
      })
    : undefined
  const loop = loopFactory ? { id: loopFactory.id, version: loopFactory.version } : undefined
  if (loop) ctx.profile = { ...ctx.profile, loop }
  const effectiveLoop = loop ?? view.loop ?? DEFAULT_LOOP
  pluginTree.root.providers.select(
    'loop',
    { provider: effectiveLoop.id, version: effectiveLoop.version },
    loop ? 'profile' : 'preset',
  )
  pluginTree.root.providers.select('tool-runtime', view.tools.runtime ?? 'default', 'preset')
  if (
    view.approval.policy ||
    pluginTree.root.providers
      .catalog()
      .some((entry) => entry.kind === 'tool-policy' && entry.id === 'default')
  )
    pluginTree.root.providers.select('tool-policy', view.approval.policy ?? 'default', 'preset')
  const promptSelection = view.model.systemPrompt?.provider
    ? { provider: view.model.systemPrompt.provider.id, version: view.model.systemPrompt.provider.version }
    : { provider: 'agnes.system-prompt', version: '1.0.0' }
  const systemPromptProvider = pluginTree.root.providers
    .catalog()
    .some((entry) => entry.kind === 'system-prompt')
    ? (selection?: { id: string; version: string }) =>
        pluginTree.root.providers.resolve(
          systemPromptKind,
          selection ? { provider: selection.id, version: selection.version } : promptSelection,
        )
    : undefined
  if (
    systemPromptProvider &&
    pluginTree.root.providers
      .catalog()
      .some((entry) => entry.kind === 'system-prompt' && entry.id === promptSelection.provider)
  )
    pluginTree.root.providers.select('system-prompt', promptSelection, 'preset')
  return { compaction, loop, systemPromptProvider }
}

/** Pin memory to the selected provider while keeping its settings live per workspace. */
function sessionMemory(ctx: AssemblyContext, pluginTree: HostPluginTreeBase) {
  const { providerSelections, deps } = ctx
  return (workspaceRoot: string, sessionKey: string): MemorySession | undefined => {
    const selection = providerSelections.memory ?? { provider: 'file', version: '1.0.0' }
    if (
      !providerSelections.memory &&
      !pluginTree.root.providers.catalog().some((entry) => entry.kind === 'memory')
    )
      return undefined
    return pluginTree.root.providers.resolve(memoryKind, selection).open({
      home: dirname(dirname(deps.profileDir)),
      workspaceRoot,
      sessionKey,
    })
  }
}

/**
 * Step `kernel` - the repository's single Kernel.create call site. The seams, session
 * capabilities and extension leases are read through `ctx.live` / `extensionLeases` because the
 * kernel is created before the stages that build them.
 */
export async function createKernel(
  ctx: AssemblyContext,
  input: Readonly<{
    proc: ProcessServices
    presets: PresetCatalog
    providerStage: ProviderStage
    operations: import('@agnes/core').Operation[]
    runtimeTarget: RuntimeTargetHost
    skillState: SkillState
    computerUse: ComputerUseHost
    approvalGrants: ApprovalGrantsPort
    seamSet: SeamSet
    discoveredResources: WeakMap<SessionImpl, readonly ResourceEntry[]>
    extensionLeases: ExtensionLeases
  }>,
) {
  const { deps, rollback, clock, activationBarrier } = ctx
  const { publicationDispatch, quietState } = ctx.gates
  const { proc, presets, providerStage, operations, runtimeTarget, skillState, computerUse } = input
  const { discoveredResources, extensionLeases } = input
  const { adapters } = proc
  const { models, view } = providerStage
  const { pluginTree, bindRuntimeSession } = runtimeTarget
  const runtimeTargetPublisher = runtimeTarget.publisher
  // 8 kernel - the repository's single Kernel.create call site
  const observabilityLease = leaseFor(
    {
      id: 'agnes/observability',
      version: '1.0.0',
      apiRange: '^4.0.0',
      entry: './observability',
      capabilities: { hooks: ['session_start', 'shutdown', 'subagent_start', 'subagent_end'] },
    },
    { ttlMs: ROW_BOUND_LEASE_TTL_MS, now: Date.now() },
  )
  rollback.push('observability-lease', () => observabilityLease.revoke('host closed'))
  const compositionLease = ctx.profile.composition
    ? leaseFor(
        {
          id: 'agnes/composition',
          version: '0.1.0',
          apiRange: '^4.0.0',
          entry: './composition',
          capabilities: { hooks: ['tool_call'] },
        },
        { ttlMs: ROW_BOUND_LEASE_TTL_MS, now: Date.now() },
      )
    : undefined
  const extensionSessions = new ExtensionSessions<HookPort>()
  const { compaction, loop, systemPromptProvider } = await selectCoreProviders(ctx, pluginTree, view)
  const memory = sessionMemory(ctx, pluginTree)
  const toolProviderCatalog = (kind: 'tool-runtime' | 'tool-policy') =>
    Object.freeze(
      pluginTree.root.providers
        .catalog()
        .filter((entry) => entry.kind === kind)
        .map(({ id, version, sourcePackage }) => Object.freeze({ id, version, sourcePackage })),
    )
  const kernel = Kernel.create({
    ...(deps.childRoles ? { childRoles: deps.childRoles } : {}),
    ...(systemPromptProvider
      ? {
          systemPrompt: {
            config: async () => ({
              ...view.model.systemPrompt,
              ...(await new SystemPromptSettingsStore(ctx.profile.dataDir, ctx.profile.name).read()),
            }),
            resolve: systemPromptProvider,
          },
        }
      : {}),
    loopChildren: (parent) => {
      const generation = deps.sessionGeneration?.(parent.sessionKey)
      return pluginTree.root.childAgents.forSession({
        ...parent,
        ...(generation === undefined ? {} : { generation }),
      })
    },
    storage: adapters.storage,
    ...(loop ? { loop } : {}),
    loops: {
      resolve: (selection) => pluginTree.root.loops.resolve(selection),
      catalog: () => pluginTree.root.loops.catalog(),
    },
    toolRuntimes: {
      register: (source, provider) =>
        pluginTree.root.providers.registerHost(toolRuntimeKind, source, provider),
      resolve: (id) => pluginTree.root.providers.resolve(toolRuntimeKind, id),
      catalog: () => toolProviderCatalog('tool-runtime'),
    },
    toolPolicies: {
      register: (source, provider) =>
        pluginTree.root.providers.registerHost(toolPolicyKind, source, provider),
      resolve: (id) => pluginTree.root.providers.resolve(toolPolicyKind, id),
      catalog: () => toolProviderCatalog('tool-policy'),
    },
    loopEvents: {
      on: (event, handler) => pluginTree.root.loopEvents.on(event, handler),
      dispatch: (event, payload, context) => pluginTree.root.loopEvents.dispatch(event, payload, context),
    },
    seams: input.seamSet.seams,
    provider: models.provider,
    withModelSnapshot: (operation) => models.run(operation),
    operations,
    currentRuntime: deps.currentRuntime ?? {
      current: (sessionKey) => runtimeTargetPublisher.current().value.sessionScopes.get(sessionKey)?.runtime,
    },
    sessionOverlay: {
      apply: (sessionKey, overlay) => bindRuntimeSession(sessionKey, overlay.preset),
    },
    contract: { contract_id: null, parser_version: '1' },
    contractForModel: models.contractForModel,
    preset: view,
    fsOps: {
      ...adapters.fs,
      read: (path, opts) => adapters.fs.read(path, { ...opts, unit: 'bytes' }),
    },
    memoryFor: ({ key, workspaceRoot }) => memory(workspaceRoot, key),
    commandPathScopeFor: hostCommandPathScope,
    netFetch: deps.netFetch ?? createNetFetch(),
    publicFetch: deps.publicFetch ?? createPublicFetch(deps.env),
    approvalMode: ctx.profile.approvals.mode,
    toolPolicySettings: async (basePolicy, signal) =>
      pluginTree.root.providers.resolve(toolPolicyKind, basePolicy).settings?.(
        {
          policy: basePolicy,
          dataDir: ctx.profile.dataDir,
          profile: ctx.profile.name,
          approvalMode: ctx.profile.approvals.mode,
        },
        signal,
      ) ?? {},
    ...(computerUse.hostToolDispatch ? { hostToolDispatch: computerUse.hostToolDispatch } : {}),
    ...(ctx.profile.reconcile.point === 'immediate' ? {} : { quiet: quietState }),
    ...(deps.log ? { logger: correlatedLogger(deps.log) } : {}),
    clock,
    agnesVersion: deps.agnesVersion ?? '0.0.0',
    hookLeaseFor: (source) =>
      source === 'agnes/observability'
        ? observabilityLease.view()
        : source === 'agnes/composition'
          ? compositionLease?.view()
          : extensionLeases.current?.(source),
    retainSessionRefIdentity: (sessionRef) => extensionSessions.owns(sessionRef),
    ...(deps.requestMedia !== undefined ? { requestMedia: deps.requestMedia } : {}),
    ...(deps.requestMedia !== undefined
      ? { imageInputTokenFallback: createProductionImageInputTokenFallback() }
      : {}),
    ...(skillState.promptPreloader ? { runtimePromptPreloader: skillState.promptPreloader } : {}),
    workspacePublication: publicationDispatch,
    approvalGrants: input.approvalGrants,
    // A spawned child's run is its own turn: activation waits for it, and one started while an
    // activation holds the gate queues behind it.
    detachedChildRun: async (run) => (await activationBarrier.enqueue('turn').start()).run(run),
    hooksFactory: extensionSessions.factory(
      (session) =>
        Object.freeze({
          key: session.key,
          lane: session.lane,
          workspaceRoot: session.workspaceRoot,
          telemetryConsent: readTelemetryConsent(
            resolvePreset(session.preset.name, presets.presets, { limits: ctx.profile.limits }).doc,
          ),
          telemetryConsentPendingAudit: presets.profileConsent !== undefined,
        }),
      (session, sessionRef, engine) =>
        createSessionHookPort(
          session,
          engine,
          () => session.currentResources().snapshot(),
          sessionRef.telemetryConsent,
          sessionRef,
          publicationDispatch,
          (resources) => {
            discoveredResources.set(session, resources)
            const capabilities = ctx.live.sessionCapabilities.get()(session.key, undefined, {
              session,
              resources,
            })
            return resources.filter((entry) =>
              entry.kind === 'mcp'
                ? capabilityEnabled(capabilities.mcp, entry.id)
                : entry.kind === 'skill'
                  ? capabilityEnabled(capabilities.skills, entry.id)
                  : true,
            )
          },
        ),
    ),
    ...(compaction ? { compaction } : {}),
    ...(ctx.profile.limits['lease.ttl_ms'] !== undefined
      ? { leaseTtlMs: ctx.profile.limits['lease.ttl_ms'] }
      : {}),
    // `children` is omitted on purpose: core's default factory refuses with a message saying
    // subagents are assembled later, which is more informative than a host-side stub.
  })
  ctx.live.kernel.set(kernel)
  rollback.push('kernel', () => kernel.close())
  return { kernel, extensionSessions, compositionLease, systemPromptProvider, memory }
}
