import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HostError } from '@agnes/host-common/errors'
import type { AgentSource } from '@agnes/host-common/profile/agent'
import { agentSelection, validateAgentBundles } from '@agnes/host-common/profile/agent'
import { canonicalJson, sha256hex } from '@agnes/host-common/profile/canonical'
import { loopPatch, resolveComposition } from '@agnes/host-common/profile/composition'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { materializeRoutes, pinPresetRoutes } from '@agnes/host-providers/assemble/routes'
import { readRuntimeBundles } from '@agnes/host-providers/profile/bundles-reader'
import type { CompositionBinding } from '@agnes/host-providers/profile/composition-state'
import { pluginSnapshotIdentity } from '@agnes/host-providers/runtime-plugin-catalogue'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import type { RuntimeTarget } from '@agnes/plugin-runtime/host'
import type { AgentPlan, LoopSelection } from '@agnes/protocol'
import type { Host, HostOptions } from '../lifecycle/host.js'
import { profileForComposition } from './composition-selection.js'
import { admitSessionBundlePresets, sessionBundleCatalog } from './session-bundle-presets.js'

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
    enabled: trusted && enabled !== false,
    dependencies:
      JSON.parse(readFileSync(join(snapshot.directory, 'package.json'), 'utf8')).dependencies ?? {},
  }))
  for (const pkg of profile.packages.filter((pkg) => pkg.trust === 'builtin')) {
    const directory = dirs.get(pkg.id)
    sources.push({
      id: pkg.id,
      version: pkg.version,
      integrity: pkg.integrity,
      source: pkg.source,
      enabled: pkg.enabled,
      dependencies: directory
        ? (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).dependencies ?? {})
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
  latestTarget: RuntimeTarget | undefined,
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
      (source.enabled === true ||
        !latestTarget ||
        latestTarget.tree.rows.some(
          (row) =>
            !row.disabled && pluginSnapshotIdentity(row.plugin)?.packageId === source.snapshot.packageId,
        )),
  )
  const sourceIds = new Set(sources.map((source) => source.snapshot.packageId))
  if (sourceIds.size !== sources.length)
    throw new HostError('E_PRESET_UNSUPPORTED', 'ambiguous active package sources')
  const current = {
    ...modelProfile,
    packages: [
      ...profile.packages
        .filter((pkg) => !sourceIds.has(pkg.id))
        .map((pkg) => ({ ...pkg, enabled: (pkg.trust === 'builtin' || !latestTarget) && pkg.enabled })),
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
      sources.length || latestTarget || options.runtimePluginSources
        ? readRuntimeBundles(sources)
        : undefined,
    ),
  }
  return { current, sources }
}

export function createAgentResolver(deps: {
  profile: ResolvedProfile
  admission(): ReturnType<typeof sessionAdmission>
  host: Host
  packageDirs: ReadonlyMap<string, string>
  adminLoop(): Promise<LoopSelection | undefined>
  open(binding: CompositionBinding): Promise<{ host: Host }>
}) {
  const { profile, admission, host, packageDirs, open } = deps
  return async (ref: string) => {
    const { current, sources } = await admission()
    const identities = agentSources(current, sources, packageDirs)
    const selected = agentSelection(ref, current.bundleCatalog, identities)
    const admitted = admitSessionBundlePresets(current, host, { ...selected, strict: true })
    const adminLoop = await deps.adminLoop()
    const tree = resolveComposition(
      { ...profile, ...admitted.scope },
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
    // Cross-package loop providers need the same explicit dependency as bundle inheritance.
    const declaring = current.bundleCatalog[tree.sources.loop?.name ?? ref] ?? current.bundleCatalog[ref]!
    const owner = identities.find((source) => source.id === declaring.sourcePackage)!
    if (
      tree.sources.loop?.layer !== 'default' &&
      current.bundleCatalog[tree.sources.loop?.name ?? ''] &&
      loopEntry.sourcePackage !== owner.id &&
      !Object.hasOwn(owner.dependencies, loopEntry.sourcePackage)
    )
      throw new HostError('E_PRESET_UNSUPPORTED', 'agent loop requires a declared dependency')
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
    const effective = pinPresetRoutes(resolved.view, models)
    const permission = {
      readOnly: tree.selection.toolPolicy?.readOnly === true,
      tools: [...(tree.selection.tools ?? [])],
      allow: [...(tree.selection.toolPolicy?.allow ?? [])],
      deny: [...(tree.selection.toolPolicy?.deny ?? [])],
    }
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
    const digest = `sha256-${sha256hex(canonicalJson({ ...content, tree, effective, profile: sessionProfile.hash, provider: container.host.providerFingerprint }))}`
    const plan: AgentPlan = { ...content, digest }
    return { plan, tree, profile: sessionProfile }
  }
}
