import { resolvePreset } from '@agnes/host-common/presets/resolve'
import { type ResolvedComposition, resolveComposition } from '@agnes/host-common/profile/composition'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import {
  CompositionSessionStore,
  createLiveCompositionWriter,
  type LiveCompositionSession,
} from '@agnes/host-providers/profile/composition-state'
import type { Host, HostSession } from '../lifecycle/host.js'
import { createHostFacade } from '../lifecycle/host-facade.js'
import type { HostFacadeOverrides } from '../lifecycle/host-routing.js'
import { sessionHostRoutes } from '../lifecycle/session-host-routes.js'
import { describeCapabilitySession } from './session-capability-view.js'

/** Keep legacy Hosts' behavior unchanged while exposing the same safe live inspection surface. */
export async function trackHostComposition(
  host: Host,
  profile: ResolvedProfile,
  profileDir: string,
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
  const describe = (session: HostSession): LiveCompositionSession =>
    describeCapabilitySession(host, session, treeFor(session.preset.name), profile.bundleCatalog)
  const live = (): readonly LiveCompositionSession[] => [...host.kernel.sessions.values()].map(describe)

  // The published file is rebuilt from per-session JSON fragments; only sessions that changed are
  // described again. Listeners only mark a key dirty, all real work runs in the microtask `flush`.
  const described = new Map<string, string>()
  const dirty = new Set<string>()
  type Subscription = {
    session: HostSession
    off: () => void
    /** The registry objects currently listened to; replaced when the session switches to others. */
    tools?: { source: object; off: () => void }
    resources?: { source: object; off: () => void }
  }
  const subscriptions = new Map<string, Subscription>()
  let scheduled = false,
    closing: Promise<void> | undefined
  const markDirty = (key: string): void => {
    dirty.add(key)
    if (scheduled) return
    scheduled = true
    queueMicrotask(flush)
  }
  const flush = (): void => {
    scheduled = false
    if (closing) return
    const keys = [...dirty]
    dirty.clear()
    for (const key of keys) {
      const session = host.kernel.sessions.get(key)
      // A closed session can stay in the table a moment after `onClosed`; it is no longer live.
      if (!session || session.closingOrClosed) {
        described.delete(key)
        subscriptions.get(key)?.off()
        subscriptions.delete(key)
        continue
      }
      try {
        watchRegistries(key, session)
        described.set(key, JSON.stringify(describe(session)))
      } catch {
        // Inspection never changes session admission. The previous fragment stays, and the key is
        // retried on the next event (no new microtask from here, so a persistent failure cannot spin).
        dirty.add(key)
      }
    }
    try {
      writer.writeFragments([...described.values()])
    } catch {
      /* inspection never changes session admission */
    }
  }
  /** One fresh closure per subscription: the same closure on one table would dedupe to one. */
  const watchRegistries = (key: string, session: HostSession): void => {
    const subscription = subscriptions.get(key)
    if (!subscription) return
    const tools = session.currentTools(),
      resources = session.currentResources()
    if (subscription.tools?.source !== tools) {
      subscription.tools?.off()
      subscription.tools = { source: tools, off: tools.onChange(() => markDirty(key)) }
    }
    if (subscription.resources?.source !== resources) {
      subscription.resources?.off()
      subscription.resources = { source: resources, off: resources.onChange(() => markDirty(key)) }
    }
  }
  const track = (session: HostSession): void => {
    const key = session.key,
      existing = subscriptions.get(key)
    if (existing?.session === session) return
    existing?.off()
    const mark = () => markDirty(key),
      offSettings = session.onSettingsChanged(mark),
      offClosed = session.onClosed(mark)
    const subscription: Subscription = {
      session,
      off: () => {
        offSettings()
        offClosed()
        subscription.tools?.off()
        subscription.resources?.off()
      },
    }
    subscriptions.set(key, subscription)
  }
  const offOpened = host.kernel.onSessionOpened((session) => {
    // Announced sessions can already be closing; the flush drops any that are gone by then.
    if (session.closingOrClosed) return
    track(session)
    markDirty(session.key)
  })
  for (const session of host.kernel.sessions.values()) {
    track(session)
    markDirty(session.key)
  }
  const overrides: HostFacadeOverrides = {
    ...sessionHostRoutes(
      () => host,
      () => host,
      () => host,
    ),
    compositionSessions: live,
    async createSession(input) {
      if (input.bundles?.length) resolveComposition(profile, { sessionBundles: input.bundles })
      const session = await host.createSession(input)
      store.pin({
        sessionKey: session.key,
        tree: treeFor(session.preset.name),
        profile,
        legacy: true,
      })
      // The Host binds the session to its runtime registries after the kernel announced it, so the
      // registries watched at announcement time may no longer be the current ones.
      markDirty(session.key)
      return session
    },
    // The session announces a completed switch itself (`onSettingsChanged`); a switch that fails
    // after assigning the preset does not, so a failure marks the key.
    async setSessionPreset(key, name) {
      try {
        return await host.setSessionPreset(key, name)
      } catch (error) {
        markDirty(key)
        throw error
      }
    },
    async releaseSessionGeneration(key) {
      host.profileServices?.revokeWakeSession(key)
      await host.releaseSessionGeneration?.(key)
      store.release(key)
    },
    close() {
      if (closing) return closing
      offOpened()
      for (const { off } of subscriptions.values()) off()
      subscriptions.clear()
      closing = host.close().finally(() => writer.close())
      return closing
    },
  }
  return createHostFacade(host, overrides)
}
