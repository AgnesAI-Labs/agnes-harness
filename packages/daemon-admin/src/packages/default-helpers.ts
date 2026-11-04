import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { rebuildDesiredFromInventory } from '@agnes/daemon-foundation/composite-desired'
import {
  bundledPluginDigest,
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
import { nativeRealpathSync } from '@agnes/system-node/realpath'
import { withDefaultHelperState } from './default-helper-state.js'

/** Provision missing release-owned defaults once; preserve installed packages and later user choices. */
export async function initializeDefaultHelpers(options: {
  profileDir: string
  manager: PackageManager
  initializePolicy(): Promise<void>
}): Promise<void> {
  await withDefaultHelperState(options.profileDir, async (state, save) => {
    const inventory = existsSync(lockPath(options.profileDir))
      ? await options.manager.inventory(options.profileDir)
      : undefined
    // Old receipts only prove offers through their hashes and the current inventory. Never infer
    // past offers from a version number: that would hide newly shipped defaults again.
    const offered = new Set(state?.version === 4 ? state.offered : Object.keys(state?.integrity ?? {}))
    for (const helper of DEFAULT_ENABLED_BUNDLED_PACKAGES)
      if (inventory?.packages.some((pkg) => pkg.id === helper.id)) offered.add(helper.id)
    const unfinished = state?.phase === 'pending' || state?.phase === 'installed' ? state : undefined
    const integrity: Record<string, string> = unfinished ? { ...unfinished.integrity } : {}
    let planned = false
    for (const helper of DEFAULT_ENABLED_BUNDLED_PACKAGES) {
      if (helper.freshOnly && (state || inventory)) continue
      if (offered.has(helper.id)) continue
      const source = bundledPluginSource(helper.ref)
      if (!source) throw new Error('Bundled helper source unavailable')
      integrity[helper.id] = hashDirectory(join(source.root, source.path))
      offered.add(helper.id)
      planned = true
    }
    if (state?.version !== 4 || planned || offered.size !== state.offered.length) {
      state = {
        version: 4,
        phase: unfinished && !planned ? unfinished.phase : 'pending',
        integrity,
        offered: [...offered],
      }
      // This intent precedes policy creation, so a failed startup can resume safely. Completed
      // batches are excluded from the new intent to preserve earlier disable/remove decisions.
      save(state)
    }
    await options.initializePolicy()
    if (state.phase !== 'pending') return
    await options.manager.recover(options.profileDir)
    // One verified read: helper ids are distinct, so installs in this loop never answer a later lookup.
    const existing = (await options.manager.inventory(options.profileDir)).packages
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
      const installed = existing.find((p) => p.id === helper.id)
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

/** Finish default provisioning through the same pinned/probed target publication as ordinary plugins. */
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
  // An ordinary read joins the boot verification boundary; only a committed update re-reads fresh.
  let inventory = await options.manager.inventory(options.profileDir)
  // Unchanged helpers stay listed so a target lost after an earlier commit is still republished.
  const refreshed: string[] = []
  for (const helper of DEFAULT_ENABLED_BUNDLED_PACKAGES) {
    const current = inventory.packages.find((pkg) => pkg.id === helper.id)
    // A release that moved the plugin API leaves the installed copy blocked as incompatible; that
    // is exactly when it needs the refresh, so only that blocker is let through.
    const outdated =
      !!current?.enabled &&
      current.trusted &&
      current.blockers.length > 0 &&
      current.blockers.every((blocker) => blocker.references[0] === 'plugin-api-range-incompatible')
    if (
      !current ||
      !(isRuntimePackageEligible(current) || outdated) ||
      current.entry.source.type !== 'file' ||
      current.entry.source.ref !== helper.ref
    )
      continue
    const bundled = bundledPluginSource(helper.ref)
    if (!bundled) throw new Error('Bundled helper source unavailable')
    // An unchanged release at the same source needs no staging copy or candidate inspection. This is a byte hash,
    // not a version/mtime shortcut; installed trust and policy came from the verified inventory.
    // The build-time digest stands in for hashing the shipped source; update still verifies it.
    const release = bundledPluginDigest(bundled) ?? hashDirectory(join(bundled.root, bundled.path))
    if (outdated && release === current.entry.integrity) continue
    if (
      release !== current.entry.integrity ||
      current.entry.provenance?.resolvedLocation !== nativeRealpathSync(join(bundled.root, bundled.path))
    ) {
      const source = parseSource(helper.ref)
      const preview = await options.manager.inspect(options.profileDir, source)
      if (
        preview.id !== helper.id ||
        preview.version === '0.0.0' ||
        preview.blockers.length ||
        preview.capabilityHash !== current.capabilityHash
      )
        continue
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
      // A committed update can change other packages' dependency eligibility. Never carry the
      // pre-update inventory into the next decision; update itself retains all admission checks.
      inventory = await options.manager.inventory(options.profileDir, { fresh: true })
    }
    refreshed.push(helper.id)
  }
  if (!refreshed.length) return
  // Publish the complete release once. Failed publication leaves the installed versions available
  // for the next boot to retry, including unchanged packages whose target was never published.
  // `inventory` is the read after the last committed update, or the first read when none ran.
  const previous = options.previous()
  let target = previous
  for (const packageId of refreshed)
    target = rebuildDesiredFromInventory({
      previous: target,
      inventory,
      packageId,
      operation: 'update',
    })
  if (target && target.digest !== previous?.digest) await options.publish(target)
}
