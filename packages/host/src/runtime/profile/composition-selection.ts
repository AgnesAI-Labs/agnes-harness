import { canonicalJson, sha256hex } from '@agnes/host-common/profile/canonical'
import type {
  CompositionPatch,
  CompositionProviders,
  ResolvedComposition,
} from '@agnes/host-common/profile/composition'
import { freezeTree } from '@agnes/host-common/profile/composition-freeze'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { pluginSnapshotIdentity } from '@agnes/host-providers/runtime-plugin-catalogue'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'
import type { PluginRow } from '@agnes/plugin-runtime/host'
import { targetRows } from '../generation/target-code.js'
import type { Host } from '../lifecycle/host.js'
import { capabilityEnabled, resolveSessionCapabilities } from './session-capabilities.js'

export type CompositionContainer = {
  host: Host
  tree: ResolvedComposition
  draining?: boolean
  /** What the last runtime target applied here makes it run; unset once anything else changed it. */
  applied?: Readonly<{ target: string; sources: readonly RuntimePluginSnapshot[] }>
}

/** Only enabled rows and live resources determine whether a projected publication changes a container. */
export const effectiveCompositionTarget = (target: Parameters<typeof targetRows>[0]): string =>
  JSON.stringify({
    rows: targetRows(target)
      .filter((row) => !row.disabled)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    resources: target.resource.resources,
  })

/** Compile a preset tree into a separate Host profile, without changing an existing session. */
export function profileForComposition(profile: ResolvedProfile, tree: ResolvedComposition): ResolvedProfile {
  const patch = tree.selection
  const { hash: _hash, compaction: _compaction, ...rest } = profile
  const capabilities = resolveSessionCapabilities({
    composition: tree,
    installed: { modelAdapters: [...new Set((profile.provider.routes ?? []).map((route) => route.api))] },
  })
  const providers: CompositionProviders = {
    ...(patch.modelAdapters ? { 'model-adapter': { provider: patch.modelAdapters } } : {}),
    ...(patch.loop ? { loop: { provider: patch.loop.id, version: patch.loop.version } } : {}),
    ...(patch.compaction === undefined
      ? {}
      : { compaction: patch.compaction === null ? null : { provider: patch.compaction.engine } }),
    ...(patch.persistence ? { persistence: patch.persistence } : {}),
    ...(patch.sandbox ? { sandbox: patch.sandbox } : {}),
  }
  const overrides = new Map((patch.packages ?? []).map((pkg) => [pkg.id, pkg]))
  const next = {
    ...rest,
    ...(patch.loop ? { loop: patch.loop } : {}),
    ...(patch.compaction ? { compaction: patch.compaction } : {}),
    ...(patch.persistence ? { persistence: patch.persistence } : {}),
    ...(patch.sandbox ? { sandbox: patch.sandbox } : {}),
    presets: { ...profile.presets, default: tree.preset },
    ...(patch.modelAdapters?.length
      ? {
          provider: {
            ...profile.provider,
            routes: (profile.provider.routes ?? []).filter((route) =>
              capabilityEnabled(capabilities.modelAdapters, route.api),
            ),
          },
        }
      : {}),
    packages: profile.packages.map((pkg) => {
      const requested = overrides.get(pkg.id)
      return {
        ...pkg,
        ...(requested?.config ? { config: requested.config } : {}),
        enabled: pkg.enabled && (!requested || capabilityEnabled(capabilities.packages, pkg.id)),
      }
    }),
    composition: {
      ...Object.fromEntries(
        Object.entries(patch).filter(
          ([key]) => !['modelAdapters', 'loop', 'compaction', 'persistence', 'sandbox'].includes(key),
        ),
      ),
      ...(Object.keys(providers).length ? { providers } : {}),
    } as CompositionPatch,
    compositionToolScope: tree.toolScope ?? { bundlePackages: [], activePackages: [] },
    compositionSources: tree.sources,
    ...(tree.sessionBundles !== undefined || tree.sources.loop?.layer === 'session'
      ? {
          sessionComposition: {
            ...(tree.sessionBundles === undefined ? {} : { bundles: [...tree.sessionBundles] }),
            ...(tree.sources.loop?.layer === 'session' && tree.sources.loop.name === 'request' && patch.loop
              ? { loop: patch.loop }
              : {}),
          },
        }
      : {}),
  }
  return freezeTree({ ...next, hash: `sha256-${sha256hex(canonicalJson(next))}` })
}

/** Policy is enforced at invocation, including tools scheduled outside the model tool list. */
export function compositionAllowsTool(
  selection: Pick<CompositionPatch, 'packages' | 'toolPolicy' | 'tools' | 'mcp'>,
  name: string,
  isReadOnly: boolean,
): boolean {
  return capabilityEnabled(
    resolveSessionCapabilities({
      selection,
      installed: { tools: [{ name, readOnly: isReadOnly }] },
    }).tools,
    name,
  )
}

/** Rebind only identities attested by a live Host. Unknown builtin claims reach the normal refusal. */
export function projectCompositionRows<T extends PluginRow>(
  rows: readonly T[],
  tree: ResolvedComposition,
  host: Host | undefined,
  localRows: readonly PluginRow[],
  authority: readonly PluginRow[],
): T[] {
  // Skills are live resources. A replayed target can carry a row from an earlier worker boot.
  // Use this container's prepared row so its mount identity matches its current importer.
  const consumers = new Map(
    host?.extensionRows
      .current()
      .filter((row) => row.liveResources?.length)
      .map((row) => [row.id, row]),
  )
  const own = new Map(localRows.map((row) => [row.id, row]))
  const known = new Set(authority.map((row) => `${row.id}\0${row.mountIdentity}`))
  const scoped = rows.flatMap((row) => {
    if (!row.plugin.startsWith('builtin:') || !known.has(`${row.id}\0${row.mountIdentity}`)) return [row]
    const local = own.get(row.id)
    if (local?.mountIdentity === row.mountIdentity) return [row]
    // Each composition owns its seam/preset policy; its publisher merges its own private rows.
    if (!local || row.id.startsWith('seam:') || row.id.startsWith('preset:')) return []
    return [{ ...local, ...(row.disabled === undefined ? {} : { disabled: row.disabled }) } as T]
  })
  const candidates = scoped.map((row) => {
    const live = consumers.get(row.id)
    return live && live.plugin === row.plugin && live.entryRevision === row.entryRevision ? (live as T) : row
  })
  const plugins = resolveSessionCapabilities({
    composition: tree,
    installed: {
      plugins: candidates.map((row) => ({
        id: row.id,
        enabled: !row.disabled,
        packageId:
          pluginSnapshotIdentity(row.plugin)?.packageId ??
          (row.plugin.startsWith('builtin:')
            ? row.plugin.slice('builtin:'.length, row.plugin.lastIndexOf('/'))
            : undefined),
      })),
    },
  }).plugins
  return candidates.map((row) => {
    const override = tree.selection.plugins?.[row.id]
    return Object.freeze({
      ...row,
      ...(override?.config === undefined ? {} : { config: override.config }),
      disabled: !capabilityEnabled(plugins, row.id),
    })
  })
}
