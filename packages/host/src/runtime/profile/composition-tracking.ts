import { resolvePreset } from '@agnes/host-common/presets/resolve'
import { type ResolvedComposition, resolveComposition } from '@agnes/host-common/profile/composition'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import {
  CompositionSessionStore,
  createLiveCompositionWriter,
} from '@agnes/host-providers/profile/composition-state'
import type { Host, HostOptions } from '../lifecycle/host.js'
import { createHostFacade } from '../lifecycle/host-facade.js'
import type { HostFacadeOverrides } from '../lifecycle/host-routing.js'
import { sessionHostRoutes } from '../lifecycle/session-host-routes.js'
import { createCompositionLiveStatus } from './composition-live-status.js'

/** Keep legacy Hosts' behavior unchanged while exposing the same safe live inspection surface. */
export async function trackHostComposition(
  host: Host,
  profile: ResolvedProfile,
  profileDir: string,
  log?: HostOptions['log'],
): Promise<Host> {
  const writer = await createLiveCompositionWriter(profileDir)
  const store = new CompositionSessionStore(profileDir)
  // Resolving a composition is pure in the preset catalog (one `host.presets` object per assembly)
  // and the preset name, so a rebuilt catalog is never served a composition resolved from the old one.
  const trees = new WeakMap<object, Map<string, ResolvedComposition>>()
  const treeFor = (presetName: string): ResolvedComposition => {
    const catalog = host.presets
    let byName = trees.get(catalog)
    if (!byName) {
      byName = new Map()
      trees.set(catalog, byName)
    }
    let tree = byName.get(presetName)
    if (!tree) {
      tree = resolveComposition(profile, {
        preset: resolvePreset(presetName, catalog, { limits: profile.limits }).doc,
      })
      byName.set(presetName, tree)
    }
    return tree
  }
  // A legacy Host is its own single container; its kernel lists the sessions of every generation.
  const self = { host }
  const liveStatus = createCompositionLiveStatus({
    containers: () => [self],
    tree: (_, session) => treeFor(session.preset.name),
    bundles: profile.bundleCatalog,
    writer,
    log,
  })
  liveStatus.watch(self)
  // Sessions opened before tracking started.
  liveStatus.markAll()
  /**
   * A publication that changes a registry revision gives every bound session new registry objects,
   * with no per-session event. Whatever the outcome, every session is marked afterwards.
   */
  const afterPublication = async <T>(publish: () => Promise<T>): Promise<T> => {
    try {
      return await publish()
    } finally {
      liveStatus.markAll()
    }
  }
  let closing: Promise<void> | undefined
  const overrides: HostFacadeOverrides = {
    ...sessionHostRoutes(
      () => host,
      () => host,
      () => host,
    ),
    compositionSessions: liveStatus.sessions,
    async createSession(input) {
      if (input.bundles?.length) resolveComposition(profile, { sessionBundles: input.bundles })
      const session = await host.createSession(input)
      // The Host binds the session to its runtime registries after the kernel announced it, so the
      // registries watched at announcement time may no longer be the current ones. Marked first, so
      // a failing pin still moves the subscriptions.
      liveStatus.markDirty([session.key])
      store.pin({
        sessionKey: session.key,
        tree: treeFor(session.preset.name),
        profile,
        legacy: true,
      })
      return session
    },
    // The session announces a completed switch itself (`onSettingsChanged`); a switch that fails
    // after assigning the preset does not, so a failure marks the key.
    async setSessionPreset(key, name) {
      try {
        return await host.setSessionPreset(key, name)
      } catch (error) {
        liveStatus.markDirty([key])
        throw error
      }
    },
    refreshSkillRow: (fresh) => afterPublication(() => host.refreshSkillRow(fresh)),
    reloadEcosystemExtension: (id, freshInit) =>
      afterPublication(() => host.reloadEcosystemExtension(id, freshInit)),
    applyRuntimeTarget: (target) => afterPublication(() => host.applyRuntimeTarget(target)),
    applyModelProfile: (next) => afterPublication(() => host.applyModelProfile(next)),
    extensionRows: {
      ...host.extensionRows,
      apply: (rows) => afterPublication(() => host.extensionRows.apply(rows)),
    },
    async releaseSessionGeneration(key) {
      host.profileServices?.revokeWakeSession(key)
      await host.releaseSessionGeneration?.(key)
      store.release(key)
    },
    close() {
      if (closing) return closing
      liveStatus.close()
      closing = host.close().finally(() => writer.close())
      return closing
    },
  }
  return createHostFacade(host, overrides)
}
