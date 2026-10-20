import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { satisfiesApiRange } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import type { AgentSource } from '@agnes/host-common/profile/agent'
import { agentSelection, validateAgentBundles } from '@agnes/host-common/profile/agent'
import { canonicalJson, sha256hex } from '@agnes/host-common/profile/canonical'
import { expandBundles, loopPatch, resolveComposition } from '@agnes/host-common/profile/composition'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { materializeRoutes, pinPresetModelDefaults } from '@agnes/host-providers/assemble/routes'
import { readRuntimeBundles } from '@agnes/host-providers/profile/bundles-reader'
import type { CompositionBinding } from '@agnes/host-providers/profile/composition-state'
import { pluginSnapshotIdentity } from '@agnes/host-providers/runtime-plugin-catalogue'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import type { AgentPlan, LoopSelection, SessionCapabilitySet } from '@agnes/protocol'
import type { Host, HostOptions } from '../lifecycle/host.js'
import { profileForComposition } from './composition-selection.js'
import { admitSessionBundlePresets, sessionBundleCatalog } from './session-bundle-presets.js'

function admittedPermission(capabilities: SessionCapabilitySet | undefined, plan: AgentPlan['permission']) {
  if (!capabilities) throw new HostError('E_PRESET_UNSUPPORTED', 'agent capabilities unavailable')
  return {
    ...plan,
    readOnly: capabilities.permissions.readOnly,
    tools: capabilities.tools
      .filter((tool) => tool.enabled)
      .map((tool) => tool.id)
      .sort(),
  }
}

/** Snapshots have already passed tree-integrity validation; builtin roots were admitted at boot. */
export function agentSources(
  profile: ResolvedProfile,
  snapshots: readonly RuntimePluginSnapshot[],
  dirs: ReadonlyMap<string, string>,
): AgentSource[] {
  const sources: AgentSource[] = snapshots.map(({ snapshot, trusted, enabled }) => ({
    id: snapshot.packageId,
    version: snapshot.version,
    integrity: snapshot.integrity,
    source: 'runtime-snapshot',
    snapshotId: snapshot.snapshotId,
    capabilityHash: snapshot.capabilityHash,
    treeIntegrity: snapshot.treeIntegrity,
    enabled: trusted && enabled !== false,
    dependencies:
      JSON.parse(readFileSync(join(snapshot.directory, 'package.json'), 'utf8')).dependencies ?? {},
  }))
  for (const pkg of profile.packages.filter((pkg) => pkg.trust === 'builtin')) {
    const directory = dirs.get(pkg.id)
    // Packaged builtin code is embedded at the verified release root, without a package.json.
    // Unknown dependency edges remain absent; ordinary snapshots still require their manifest.
    const manifest = directory ? join(directory, 'package.json') : undefined
    sources.push({
      id: pkg.id,
      version: pkg.version,
      integrity: pkg.integrity,
      source: pkg.source,
      enabled: pkg.enabled,
      dependencies:
        manifest && existsSync(manifest)
          ? (JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {})
          : {},
    })
  }
  return sources
}

/** Verify the actual persisted session selection, after Host admission and before returning it. */
export function assertAgentPin(
  plan: AgentPlan,
  session: Awaited<ReturnType<Host['createSession']>>,
  compositionHash: string,
): void {
  const model = session.preset.model
  if (
    `sha256-${sha256hex(canonicalJson(session.preset))}` !== plan.effectivePresetHash ||
    compositionHash !== plan.compositionHash ||
    session.preset.name !== plan.preset ||
    session.loop.id !== plan.loop.id ||
    session.loop.version !== plan.loop.version ||
    Object.entries(plan.models).some(
      ([slot, wanted]) => model.route[slot] !== wanted.route || model.id[slot] !== wanted.model,
    )
  )
    throw new HostError('E_PRESET_UNSUPPORTED', 'agent final pin differs from reviewed selection')
}

export async function sessionAdmission(
  profile: ResolvedProfile,
  modelProfile: ResolvedProfile,
  options: HostOptions,
  activePackages: ReadonlyMap<string, string> | undefined,
) {
  const available =
    (await options.runtimePluginSources?.()) ??
    options.runtimePluginCatalogue ??
    options.runtimePluginSnapshots ??
    []
  const sources = available.filter(
    (source) =>
      source.trusted &&
      source.enabled !== false &&
      (!activePackages ||
        activePackages.get(source.snapshot.packageId) === source.snapshot.snapshotId ||
        (!activePackages.has(source.snapshot.packageId) && source.enabled === true)),
  )
  const sourceIds = new Set(sources.map((source) => source.snapshot.packageId))
  if (sourceIds.size !== sources.length)
    throw new HostError('E_PRESET_UNSUPPORTED', 'ambiguous active package sources')
  const current = {
    ...modelProfile,
    // Empty admin selection has the same authority before and after configuration is persisted.
    adminBundles: modelProfile.adminBundles ?? [],
    packages: [
      ...profile.packages
        .filter((pkg) => !sourceIds.has(pkg.id))
        .map((pkg) => ({ ...pkg, enabled: (pkg.trust === 'builtin' || !activePackages) && pkg.enabled })),
      ...sources.map(({ snapshot }) => ({
        id: snapshot.packageId,
        version: snapshot.version,
        integrity: snapshot.integrity,
        source: 'runtime-snapshot',
        trust: 'trusted' as const,
        enabled: true,
      })),
    ],
    bundleCatalog: sessionBundleCatalog(
      profile,
      sources.length || activePackages || options.runtimePluginSources
        ? await readRuntimeBundles(sources)
        : undefined,
      new Set(
        [
          ...available,
          ...(options.runtimePluginSnapshots ?? []),
          ...(options.runtimePluginCatalogue ?? []),
        ].map((source) => source.snapshot.packageId),
      ),
    ),
  }
  return { current, sources }
}

export function createAgentResolver(deps: {
  admission(): ReturnType<typeof sessionAdmission>
  host: Host
  packageDirs: ReadonlyMap<string, string>
  adminLoop(): Promise<LoopSelection | undefined>
  open(binding: CompositionBinding): Promise<{ host: Host }>
}) {
  const { admission, host, packageDirs, open } = deps
  return async (ref: string) => {
    const { current, sources } = await admission()
    const identities = agentSources(current, sources, packageDirs)
    const selected = agentSelection(ref, current.bundleCatalog, identities)
    const admitted = admitSessionBundlePresets(current, host, { ...selected, strict: true })
    const adminLoop = await deps.adminLoop()
    // A live install can outgrow the boot catalogue; compile against current admission.
    const tree = resolveComposition(
      { ...current, ...admitted.scope },
      {
        preset: admitted.preset,
        packageCatalog: current.packages,
        sessionBundles: selected.bundles,
        ...(adminLoop ? { admin: { composition: loopPatch(adminLoop) } } : {}),
      },
    )
    validateAgentBundles(tree.bundles, current.bundleCatalog, identities)
    const loop = tree.selection.loop
    const loopEntry = host.kernel.loops
      .catalog()
      .find((entry) => entry.id === loop?.id && entry.version === loop.version)
    if (!loop || !loopEntry) throw new HostError('E_PRESET_UNSUPPORTED', 'agent loop is unavailable')
    // Resolve provenance from the actual winning author layer, including inherited presets.
    const loopSource = identities.find((source) => source.enabled && source.id === loopEntry.sourcePackage)
    if (!loopSource) throw new HostError('E_PRESET_UNSUPPORTED', 'agent loop source is unavailable')
    const declaring =
      current.bundleCatalog[tree.sources.loop?.name ?? ''] ??
      (tree.sources.loop?.layer === 'preset'
        ? [...expandBundles(selected.bundles, current.bundleCatalog)].reverse().find((entry) =>
            Object.values(entry.document.presets ?? {}).some((preset) => {
              const provider = (
                preset.providers as { loop?: { provider: string; version: string } } | undefined
              )?.loop
              return provider?.provider === loop.id && provider.version === loop.version
            }),
          )
        : undefined)
    if (declaring && declaring.sourcePackage !== loopSource.id) {
      const owner = identities.find((source) => source.id === declaring.sourcePackage)
      const range = owner?.dependencies[loopSource.id]
      if (!range || !satisfiesApiRange(range, loopSource.version))
        throw new HostError('E_PRESET_UNSUPPORTED', 'agent loop requires a compatible declared dependency')
    }
    const sessionProfile = profileForComposition(admitted.profile, tree)
    const container = await open({ sessionKey: '', tree, profile: sessionProfile })
    const resolved = container.host.validatePresetSwitch(selected.preset)
    const models = materializeRoutes(
      resolved.view,
      container.host.profile,
      container.host.modelAdapterCatalog(),
    )
    for (const [slot, target] of Object.entries(models))
      container.host.validateModelSwitch({ slot, ...target })
    const effective = pinPresetModelDefaults(resolved.view, models, container.host.provider.models())
    const permission = admittedPermission(container.host.sessionCapabilities?.(''), {
      readOnly: tree.selection.toolPolicy?.readOnly === true,
      tools: [...(tree.selection.tools ?? [])],
      allow: [...(tree.selection.toolPolicy?.allow ?? [])],
      deny: [...(tree.selection.toolPolicy?.deny ?? [])],
    })
    const executionIdentity = container.host.executionIdentity?.()
    if (!executionIdentity)
      throw new HostError('E_PRESET_UNSUPPORTED', 'agent execution identity unavailable')
    // Bind every admitted source, including provider packages and metadata-only bundles. No credentials leave Host.
    const sourceIdentities = identities
      .filter((source) => source.enabled)
      .map(({ enabled: _enabled, dependencies: _dependencies, ...identity }) => identity)
      .sort((a, b) => a.id.localeCompare(b.id))
    const content = {
      ref,
      launch: selected.launch,
      loop,
      bundles: selected.bundles,
      preset: selected.preset,
      pages: selected.launch.pages ?? [],
      compositionHash: tree.hash,
      presetHash: resolved.hash,
      effectivePresetHash: `sha256-${sha256hex(canonicalJson(effective))}`,
      model: models.primary,
      models,
      permission,
      sources: sourceIdentities,
    }
    const digest = `sha256-${sha256hex(canonicalJson({ ...content, tree, effective, executionIdentity, profile: sessionProfile.hash, provider: container.host.providerFingerprint }))}`
    const plan: AgentPlan = { ...content, digest }
    return { plan, tree, profile: sessionProfile, executionIdentity }
  }
}

/** Validate the exact reviewed choice before writing or reopening a composition binding. */
export function assertAgentRequest(
  input: import('../sessions/session.js').CreateSessionOptions,
  agent: Awaited<ReturnType<ReturnType<typeof createAgentResolver>>> | undefined,
  binding: CompositionBinding | undefined,
): void {
  if (input.agentDigest !== undefined && (!agent || input.agentDigest !== agent.plan.digest))
    throw new HostError('E_PRESET_UNSUPPORTED', 'agent review drift')
  if (agent && (input.loop || input.bundles !== undefined || input.preset || input.parent))
    throw new HostError('E_PRESET_UNSUPPORTED', 'agent cannot be combined with execution overrides')
  if (
    binding &&
    agent &&
    (binding.tree.hash !== agent.tree.hash || binding.profile.hash !== agent.profile.hash)
  )
    throw new HostError('E_PRESET_UNSUPPORTED', 'agent selection differs from session pin')
}

/** Finish strict admission against current sources and the actual session pin; clean up a refusal. */
export async function verifyAgentPin(
  reviewed: Awaited<ReturnType<ReturnType<typeof createAgentResolver>>>,
  session: Awaited<ReturnType<Host['createSession']>>,
  compositionHash: string,
  resolve: (ref: string) => Promise<{ plan: AgentPlan }>,
  host: Host,
): Promise<void> {
  const { plan } = reviewed
  try {
    if ((await resolve(plan.ref)).plan.digest !== plan.digest)
      throw new HostError('E_PRESET_UNSUPPORTED', 'agent source or policy drift during admission')
    if (
      host.executionIdentity?.(session.key) !== reviewed.executionIdentity ||
      canonicalJson(admittedPermission(host.sessionCapabilities?.(session.key), plan.permission)) !==
        canonicalJson(plan.permission)
    )
      throw new HostError('E_PRESET_UNSUPPORTED', 'agent runtime configuration or capabilities drift')
    assertAgentPin(plan, session, compositionHash)
  } catch (error) {
    await session.close()
    throw error
  }
}

/** The publisher owns row enablement; data admission consumes only its active package identities. */
export function activeAgentPackages(
  rows: readonly { plugin: string; disabled?: boolean }[],
): ReadonlyMap<string, string> {
  const selected = new Map<string, string>()
  for (const row of rows) {
    const identity = !row.disabled && pluginSnapshotIdentity(row.plugin)
    if (!identity) continue
    const previous = selected.get(identity.packageId)
    if (previous && previous !== identity.snapshotId)
      throw new HostError('E_PRESET_UNSUPPORTED', 'ambiguous active package sources')
    selected.set(identity.packageId, identity.snapshotId)
  }
  return selected
}
