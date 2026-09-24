import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUNDLED_HELPERS,
  bundledPluginSourceRoot,
  hashDirectory,
  type InstalledInventory,
  isRuntimePackageEligible,
  lockPath,
  type PackageManager,
  parseSource,
} from '@agnes/package-manager'

import type { RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { rebuildDesiredFromInventory } from '../composite-desired.js'
import { withDefaultHelperState } from './default-helper-state.js'

/** Provision missing release-owned defaults once; preserve installed packages and later user choices. */
export async function initializeDefaultHelpers(options: {
  profileDir: string
  manager: PackageManager
  initializePolicy(): Promise<void>
}): Promise<void> {
  await withDefaultHelperState(options.profileDir, async (state, save) => {
    if (!state || state.phase === 'existing' || state.version === 1) {
      const inventory = existsSync(lockPath(options.profileDir))
        ? await options.manager.inventory(options.profileDir)
        : undefined
      const integrity: Record<string, string> =
        state && ['pending', 'installed'].includes(state.phase) ? { ...state.integrity } : {}
      for (const helper of BUNDLED_HELPERS) {
        if (state?.version === 1 && state.phase !== 'existing' && helper.name !== 'plugin-helper') continue
        if (inventory?.packages.some((pkg) => pkg.id === helper.id)) continue
        const root = bundledPluginSourceRoot(helper.ref)
        if (!root) throw new Error('Bundled helper source unavailable')
        integrity[helper.id] = hashDirectory(join(root, 'bundled-plugins', helper.name))
      }
      state = { version: 2, phase: 'pending', integrity }
      // This intent precedes policy creation, so a failed first startup can resume safely.
      save(state)
    }
    await options.initializePolicy()
    if (state.phase !== 'pending') return
    await options.manager.recover(options.profileDir)
    for (const helper of BUNDLED_HELPERS) {
      if (!Object.hasOwn(state.integrity, helper.id)) continue
      const source = parseSource(helper.ref)
      const preview = await options.manager.inspect(options.profileDir, source)
      if (
        preview.id !== helper.id ||
        preview.version !== helper.version ||
        preview.integrity !== state.integrity[helper.id] ||
        preview.blockers.length ||
        !preview.capabilityHash
      )
        throw new Error('Bundled helper verification failed')
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
    for (const helper of BUNDLED_HELPERS) {
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
