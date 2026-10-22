import type { Kernel } from '@agnes/core'
import {
  buildExtensionRow,
  composeExtensionRowTarget,
  type DynamicExtension,
  EXT_ROW_MOUNT_REVISION,
  type ExtRowLoader,
  MIGRATED_EXTENSION_IDS,
} from '@agnes/host-extensions/assemble/ext-rows'
import type { BuiltinRowHandle } from '@agnes/host-extensions/ext-host/builtin-row-host'
import { preflightEmbeddedExtension, preflightExtension } from '@agnes/host-extensions/ext-host/preflight'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import { skillRowRevision } from '@agnes/host-providers/assemble/skill-row'
import {
  generationRegistries,
  prepareGenerationOwnerReplacement,
} from '@agnes/host-providers/runtime-generation-view'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { RELEASE_DEFAULTS } from '@agnes/package-manager'
import { type EntryRow, pluginConfigDigest } from '@agnes/plugin-runtime/host'
import type { Assembled } from './assembled.js'
import type { BootRows } from './boot-rows.js'
import type { BundledExtensions } from './bundled-extensions.js'
import type { AssemblyContext } from './context.js'
import type { ExtensionHost } from './extension-host.js'
import type { RowHosts } from './row-hosts.js'
import type { RuntimeTargetHost } from './runtime-target.js'
import type { SkillState } from './skills.js'

export type ExtensionRowsInput = Readonly<{
  kernel: Kernel
  bootRows: BootRows
  rowHosts: RowHosts
  runtimeTarget: RuntimeTargetHost
  host: ExtensionHost
  bundled: BundledExtensions
  pkgs: import('./packages.js').PackageSet
  skillState: SkillState
  buildEcosystemContext: ReturnType<
    typeof import('./ecosystem-context.js').createEcosystemContexts
  >['buildEcosystemContext']
}>

/**
 * How an `ext:` row loads its extension: a bundled one through the shared builtin row host, or one
 * that exists only at runtime. The extension is constructed inside the row's apply, so a factory
 * that throws is a listing and an empty row, not an assembly failure.
 */
function createExtensionLoaders(input: ExtensionRowsInput) {
  const { kernel, runtimeTarget, host, bundled, skillState, buildEcosystemContext } = input
  const runtimeTargetPublisher = runtimeTarget.publisher
  const { generationViews } = runtimeTarget
  const { managed, builtinRows, makeFactorySelector, selectExtensionFactory } = host
  const { findBundledExtension, consumesSkills } = bundled
  // Copies one owner's current Kernel registrations into the published generation sessions are
  // bound to, which otherwise keeps the copy it took when it was created.
  const mirrorGenerationOwner = (id: string) => {
    const current = runtimeTargetPublisher.current().value.current
    if (!current) return
    const seed = { tools: kernel.tools, resources: kernel.resources }
    const generation = generationRegistries(generationViews, current.runtimeRegistryRevision, seed)
    const replacement = prepareGenerationOwnerReplacement(generation, id, seed)
    replacement.commit()
    replacement.finalize()
  }
  const extRowLoader: ExtRowLoader = Object.freeze({
    load: async (extensionId: string) => ({
      id: extensionId,
      loaded: false,
      error: { code: 'E_EXT_LOAD', message: 'legacy extension loader is retired' },
    }),
    revoke: (extensionId: string, reason: string) => managed.revoke(extensionId, reason),
  })
  // The extension is constructed inside the row's apply, so a factory that throws is a listing
  // and an empty row, not an assembly failure.
  const loadMigratedExtension = (
    extensionId: string,
    skillResources?: SkillRuntimeInput,
    config?: unknown,
  ): Promise<BuiltinRowHandle> => {
    const found = findBundledExtension(extensionId)
    if (!found)
      return Promise.resolve({
        loaded: false,
        error: { code: 'E_EXT_LOAD', message: 'extension not found' },
        release: async () => {},
      })
    return builtinRows.load({
      rowId: `ext:${extensionId}`,
      spec: found.spec,
      hostGrants: () =>
        input.pkgs.grants.extension(found.packageId, extensionId, input.pkgs.modules.get(found.packageId)),
      executionBinding: {
        rowId: `ext:${extensionId}`,
        exportName: found.spec.id,
        snapshotId: found.spec.integrity ?? found.spec.packageVersion,
        configDigest: pluginConfigDigest(config),
      },
      ...(found.embedded ? { embedded: found.embedded } : {}),
      factory: (token) =>
        (consumesSkills(extensionId)
          ? makeFactorySelector((owner, id) =>
              buildEcosystemContext(
                owner,
                id,
                skillResources ? { skillResources: skillState.liveInput } : {},
                ['skills'],
                input.pkgs.modules.get(owner),
              ),
            )
          : selectExtensionFactory)(
          found.packageId,
          found.spec.id,
          found.packageDirectory,
          found.embedded ? found.packageDirectory : found.extensionDirectory,
          token,
        ),
    })
  }
  const loadDynamicExtension = (
    extensionId: string,
    dynamic: DynamicExtension,
  ): Promise<BuiltinRowHandle> => {
    return builtinRows.load({
      rowId: `ext:${extensionId}`,
      spec: dynamic.spec,
      embedded: dynamic.manifest,
      factory: () =>
        dynamic.factory(
          buildEcosystemContext(
            dynamic.spec.package,
            extensionId,
            { skillResources: skillState.liveInput },
            dynamic.manifest.liveResources,
          ),
        ),
      registration: 'lifetime',
      onLateRegistration: () => mirrorGenerationOwner(extensionId),
    })
  }
  return { extRowLoader, loadMigratedExtension, loadDynamicExtension }
}

/**
 * Admits the bundled extensions that get a row on this installation, auditing each refusal.
 */
function admittedExtensionIds(ctx: AssemblyContext, input: ExtensionRowsInput): string[] {
  const { say } = ctx
  const { bundled, rowHosts } = input
  const { extensionInfo } = rowHosts
  const { findBundledExtension, declaredExtensionIds } = bundled
  // Only extensions this installation can actually admit get a row. A row whose apply throws
  // during assembly does not become RowState 'failed': assemble.ts's own step wrapper rewrites it
  // into E_SEAM_INIT and unwinds the rollback, i.e. Host does not exist. Admission is therefore
  // decided BEFORE the row is built, with the same preflight managed.load runs (identity,
  // manifest, api range, capability ceiling). A profile that narrows `policy.capabilityCeiling`
  // below what a builtin declares used to mean "that one extension fails to load, Host boots";
  // rowifying it must not turn that into "Host does not exist".
  const admitsExtensionRow = (found: NonNullable<ReturnType<typeof findBundledExtension>>) => {
    try {
      const ceiling = ctx.profile.policy.capabilityCeiling
      if (found.embedded)
        preflightEmbeddedExtension({
          id: found.spec.id,
          manifest: found.embedded,
          ceiling,
          apiVersion: extensionInfo.apiVersion,
        })
      else preflightExtension({ ...found.spec, ceiling, apiVersion: extensionInfo.apiVersion })
      return true
    } catch {
      return false
    }
  }
  const extRowIds: string[] = []
  for (const extensionId of declaredExtensionIds) {
    // The Computer Use gate is a supply condition, not a grant condition: when it is off there is
    // nothing to load, so no row is built.
    if (extensionId === RELEASE_DEFAULTS.computerUseExtension && !ctx.profile.computerUse.enabled) continue
    const found = findBundledExtension(extensionId)
    if (!found) continue
    if (admitsExtensionRow(found)) extRowIds.push(extensionId)
    else
      say('extension.failed', {
        id: extensionId,
        code: 'E_EXT_LOAD',
        message: 'builtin row admission failed',
      })
  }
  return extRowIds
}

/**
 * The `ext:` rows: one per bundled extension this installation can admit, plus the rows for
 * extensions that exist only at runtime. They are the Host's own rows, claimed as Host-private
 * so the publisher admits them, and mount through the same runtime target as every other row.
 */
export async function mountExtensionRows(ctx: AssemblyContext, input: ExtensionRowsInput) {
  const { deps, say } = ctx
  const { bootRows, runtimeTarget, bundled } = input
  const { builtin, bootTreeRows } = bootRows
  const { enqueueRuntimeTarget } = runtimeTarget
  const runtimeTargetPublisher = runtimeTarget.publisher
  const { findBundledExtension, authorManifestOf, consumesSkills } = bundled
  // ==== ext: rows ====
  // This is the earliest point where an ext: row can exist: `managed`, `selectExtensionFactory`
  // and `findBundledExtension` (just above) are all consts declared after the boot tree's own
  // applyRuntimeTarget, and the row's loader needs all three.
  const extRowOwners = new Map<string, symbol>()
  // Extensions that exist only at runtime (one per resource), keyed by extension id. Registered by
  // `prepare`, dropped again once an apply no longer carries their row.
  const dynamicExtensionIds = new Set<string>()
  const { extRowLoader, loadMigratedExtension, loadDynamicExtension } = createExtensionLoaders(input)
  const preparedExtensionInputs = new Map<string, Parameters<Assembled['extensionRows']['prepare']>[0]>()
  const prepareExtensionRow = (
    input: Readonly<{
      extensionId: string
      entryRevision?: string
      liveResourceRevision?: string
      config?: unknown
      disabled?: boolean
      dynamic?: DynamicExtension
      skillResources?: SkillRuntimeInput | undefined
    }>,
  ) => {
    if (input.dynamic) dynamicExtensionIds.add(input.extensionId)
    const found = input.dynamic ? undefined : findBundledExtension(input.extensionId)
    const manifest = input.dynamic?.manifest ?? authorManifestOf(input.extensionId)
    const liveResources = manifest && manifest !== 'unreadable' ? manifest.liveResources : undefined
    preparedExtensionInputs.set(input.extensionId, input)
    const onDisposeError = (error: unknown) =>
      say('extension.revoke_failed', {
        id: input.extensionId,
        row: `ext:${input.extensionId}`,
        ...(typeof (error as { code?: unknown }).code === 'string'
          ? { code: (error as { code: string }).code }
          : {}),
        message: error instanceof Error ? error.message : String(error),
      })
    const built = buildExtensionRow({
      extensionId: input.extensionId,
      liveResource: input.dynamic?.generation?.kind === 'mcp-server',
      packageId: input.dynamic?.spec.package ?? found?.packageId ?? RELEASE_DEFAULTS.extensionOwner,
      entryRevision:
        input.entryRevision ?? input.dynamic?.spec.revision ?? found?.spec.revision ?? EXT_ROW_MOUNT_REVISION,
      ...(liveResources === undefined ? {} : { liveResources }),
      ...(input.liveResourceRevision === undefined
        ? {}
        : { liveResourceRevision: input.liveResourceRevision }),
      loader: extRowLoader,
      owners: extRowOwners,
      onDisposeError,
      ...(input.dynamic
        ? {
            facade: {
              load: () => loadDynamicExtension(input.extensionId, input.dynamic as DynamicExtension),
            },
          }
        : MIGRATED_EXTENSION_IDS.has(input.extensionId) || liveResources?.length
          ? {
              facade: {
                load: (config) =>
                  loadMigratedExtension(
                    input.extensionId,
                    Object.hasOwn(input, 'skillResources') ? input.skillResources : deps.skillResources,
                    config,
                  ),
              },
            }
          : {}),
      ...(input.config === undefined ? {} : { config: input.config }),
      ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
    })
    // Without a Host-private claim the publisher refuses the row outright:
    // E_RUNTIME_TARGET_STATIC_CLAIM (runtime-target-static-authority.ts), and Host never boots.
    builtin.claims = Object.freeze([
      ...builtin.claims.filter((claim) => claim.row.id !== built.row.id),
      built.claim,
    ])
    return built.row
  }
  // Composed inside the apply queue (see enqueueRuntimeTarget): a daemon target still in flight
  // when this is called is part of the live tree by the time these rows are merged onto it.
  const applyExtensionRows = (rows: readonly Readonly<EntryRow>[]) =>
    enqueueRuntimeTarget(
      () =>
        buildCompleteRuntimeTarget(
          composeExtensionRowTarget({
            live: runtimeTargetPublisher.current().value.current?.target,
            fallbackRows: bootTreeRows,
            rows,
            extraOwnedRowIds: new Set([...dynamicExtensionIds].map((id) => `ext:${id}`)),
          }),
        ).target,
    )
  const extRowIds = admittedExtensionIds(ctx, input)
  builtin.hostExtensionRows = Object.freeze([
    ...extRowIds.map((extensionId) => {
      const pinned = deps.generationBuiltinRows?.find((row) => row.id === `ext:${extensionId}`)
      return prepareExtensionRow({
        extensionId,
        ...(consumesSkills(extensionId)
          ? {
              liveResourceRevision: skillRowRevision(deps.skillResources),
              skillResources: deps.skillResources,
            }
          : {}),
        ...(pinned
          ? {
              entryRevision: pinned.entryRevision,
              ...(pinned.config === undefined ? {} : { config: pinned.config }),
              ...(pinned.disabled === undefined ? {} : { disabled: pinned.disabled }),
            }
          : {}),
      })
    }),
  ])
  if (builtin.hostExtensionRows.length) await applyExtensionRows(builtin.hostExtensionRows)
  const extensionRows = Object.freeze({
    current: () => builtin.hostExtensionRows,
    prepare: prepareExtensionRow,
    apply: async (rows: readonly Readonly<EntryRow>[]) => {
      // Set before applying: the merge must not put back a row this call is removing.
      const previous = builtin.hostExtensionRows
      builtin.hostExtensionRows = Object.freeze([...rows])
      try {
        const report = await applyExtensionRows(rows)
        // A dynamic extension whose row is gone is forgotten, so a later apply cannot bring it back.
        const wanted = new Set(rows.map((row) => row.id))
        for (const id of preparedExtensionInputs.keys())
          if (!wanted.has(`ext:${id}`)) preparedExtensionInputs.delete(id)
        for (const id of [...dynamicExtensionIds]) {
          if (wanted.has(`ext:${id}`)) continue
          dynamicExtensionIds.delete(id)
          builtin.claims = Object.freeze(builtin.claims.filter((claim) => claim.row.id !== `ext:${id}`))
        }
        return report
      } catch (error) {
        builtin.hostExtensionRows = previous
        const retained = new Set(previous.map((row) => row.id))
        for (const id of dynamicExtensionIds) if (!retained.has(`ext:${id}`)) dynamicExtensionIds.delete(id)
        throw error
      }
    },
  })
  ctx.live.extensionRows.set(extensionRows)
  return { extensionRows, prepareExtensionRow, preparedExtensionInputs }
}
