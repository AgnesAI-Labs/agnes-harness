import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { rebuildDesiredFromInventory } from '@agnes/daemon-foundation/composite-desired'
import {
  bundledPluginSource,
  DEFAULT_ENABLED_BUNDLED_PACKAGES,
  hashDirectory,
  type InstalledInventory,
  isRuntimePackageEligible,
  lockPath,
  PackageError,
  type PackageManager,
  parseSource,
} from '@agnes/package-manager'
import type { RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { withDefaultHelperState } from './default-helper-state.js'

/** Provision missing release-owned defaults once; preserve installed packages and later user choices. */
export async function initializeDefaultHelpers(options: {
  profileDir: string
  manager: PackageManager
  initializePolicy(): Promise<void>
}): Promise<void> {
  await withDefaultHelperState(options.profileDir, async (state, save) => {
    if (!state || state.phase === 'existing' || state.version < 3) {
      const inventory = existsSync(lockPath(options.profileDir))
        ? await options.manager.inventory(options.profileDir)
        : undefined
      const integrity: Record<string, string> =
        state && ['pending', 'installed'].includes(state.phase) ? { ...state.integrity } : {}
      for (const helper of DEFAULT_ENABLED_BUNDLED_PACKAGES) {
        if (helper.freshOnly && (state || inventory)) continue
        if (
          state?.version === 1 &&
          state.phase !== 'existing' &&
          !['plugin-helper', 'document-reader'].includes(helper.name)
        )
          continue
        if (state?.version === 2 && helper.name !== 'document-reader') continue
        if (inventory?.packages.some((pkg) => pkg.id === helper.id)) continue
        const source = bundledPluginSource(helper.ref)
        if (!source) throw new Error('Bundled helper source unavailable')
        integrity[helper.id] = hashDirectory(join(source.root, source.path))
      }
      state = { version: 3, phase: 'pending', integrity }
      // This intent precedes policy creation, so a failed first startup can resume safely.
      save(state)
    }
    await options.initializePolicy()
    if (state.phase !== 'pending') return
    await options.manager.recover(options.profileDir)
    for (const helper of DEFAULT_ENABLED_BUNDLED_PACKAGES) {
      if (!Object.hasOwn(state.integrity, helper.id)) continue
      const source = parseSource(helper.ref)
      const preview = await options.manager.inspect(options.profileDir, source)
      if (
        preview.id !== helper.id ||
        preview.version === '0.0.0' ||
        preview.integrity !== state.integrity[helper.id] ||
        !preview.capabilityHash
      )
        throw new Error('Bundled helper verification failed')
      if (preview.blockers.length) {
        // Optional defaults may be omitted under the profile's ceiling. Never bypass policy or
        // mistake another verification failure for a policy choice; bind identity and bytes first.
        if (
          !(helper.freshOnly || helper.optionalUnderCeiling) ||
          preview.blockers.some(
            (blocker) => blocker.code !== 'policy' || blocker.references[0] !== 'capability-ceiling',
          )
        )
          throw new Error('Bundled helper verification failed')
        const integrity: Record<string, string> = { ...state.integrity }
        delete integrity[helper.id]
        state = { ...state, integrity }
        save(state)
        continue
      }
      const installed = (await options.manager.inventory(options.profileDir)).packages.find(
        (p) => p.id === helper.id,
      )
      if (
        installed &&
        (installed.entry.integrity !== preview.integrity || installed.entry.source.ref !== helper.ref)
      )
        throw new Error('Existing helper differs from initialization intent')
      if (!installed)
        await options.manager.install(options.profileDir, source, { expectedIntegrity: preview.integrity })
      await options.manager.trust(options.profileDir, helper.id, {
        integrity: preview.integrity,
        capabilityHash: preview.capabilityHash,
      })
      await options.manager.setEnabled(options.profileDir, helper.id, true, {
        expectedInstalledIntegrity: preview.integrity,
      })
    }
    state = { ...state, phase: Object.keys(state.integrity).length ? 'installed' : 'complete' }
    save(state)
  })
}

/** Finish first boot through the same pinned/probed target publication as ordinary plugins. */
export async function activateDefaultHelpers(options: {
  profileDir: string
  inventory: InstalledInventory
  previous: RuntimeTargetArtifact | undefined
  publish(target: RuntimeTargetArtifact): Promise<void>
}): Promise<void> {
  await withDefaultHelperState(options.profileDir, async (state, save) => {
    if (state?.phase !== 'installed') return
    let target = options.previous
    for (const helper of DEFAULT_ENABLED_BUNDLED_PACKAGES) {
      if (!Object.hasOwn(state.integrity, helper.id)) continue
      const pkg = options.inventory.packages.find((p) => p.id === helper.id)
      if (!pkg || !isRuntimePackageEligible(pkg) || pkg.entry.integrity !== state.integrity[helper.id])
        throw new Error('Bundled helper activation verification failed')
      target = rebuildDesiredFromInventory({
        previous: target,
        inventory: options.inventory,
        packageId: helper.id,
        operation: 'enable',
      })
    }
    if (!target) throw new Error('Bundled helper target unavailable')
    await options.publish(target)
    save({ ...state, phase: 'complete' })
  })
}

/** Refresh only the release source under its existing capability grant. Publication is retried on
 * every boot, including after a crash between the package commit and target publication. */
export async function refreshDefaultHelpers(options: {
  profileDir: string
  manager: PackageManager
  previous(): RuntimeTargetArtifact | undefined
  publish(target: RuntimeTargetArtifact): Promise<void>
}): Promise<void> {
  for (const helper of DEFAULT_ENABLED_BUNDLED_PACKAGES) {
    const current = (await options.manager.inventory(options.profileDir, { fresh: true })).packages.find(
      (pkg) => pkg.id === helper.id,
    )
    if (
      !current ||
      !isRuntimePackageEligible(current) ||
      current.entry.source.type !== 'file' ||
      current.entry.source.ref !== helper.ref
    )
      continue
    const source = parseSource(helper.ref)
    const preview = await options.manager.inspect(options.profileDir, source)
    if (
      preview.id !== helper.id ||
      preview.version === '0.0.0' ||
      preview.blockers.length ||
      preview.capabilityHash !== current.capabilityHash
    )
      continue
    if (current.entry.integrity !== preview.integrity || current.entry.version !== preview.version) {
      try {
        await options.manager.update(options.profileDir, helper.id, source, {
          expectedIntegrity: preview.integrity,
          expectedInstalledIntegrity: current.entry.integrity,
          activation: {
            expectedInstalledIntegrity: current.entry.integrity,
            trust: { integrity: preview.integrity, capabilityHash: preview.capabilityHash },
          },
        })
      } catch (error) {
        // Dependencies, deployment references and pins retain their ordinary refusal semantics.
        // The catalog still offers the candidate for a reviewed update.
        if (error instanceof PackageError && error.legacyCode === 'E_API_RANGE') continue
        throw error
      }
    }
    const previous = options.previous()
    const target = rebuildDesiredFromInventory({
      previous,
      inventory: await options.manager.inventory(options.profileDir, { fresh: true }),
      packageId: helper.id,
      operation: 'update',
    })
    if (target && target.digest !== previous?.digest) await options.publish(target)
  }
}
