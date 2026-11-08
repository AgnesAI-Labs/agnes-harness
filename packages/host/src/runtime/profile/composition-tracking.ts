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
  // Resolving a composition is pure in the preset, so each preset is resolved once.
  const trees = new Map<string, ResolvedComposition>()
  const treeFor = (presetName: string): ResolvedComposition => {
    let tree = trees.get(presetName)
    if (!tree) {
      tree = resolveComposition(profile, {
        preset: resolvePreset(presetName, host.presets, { limits: profile.limits }).doc,
      })
      trees.set(presetName, tree)
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
  const subscriptions = new Map<string, { session: HostSession; off: () => void }>()
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
        described.set(key, JSON.stringify(describe(session)))
      } catch {
        /* inspection never changes session admission; the previous fragment stays until the next change */
      }
    }
    try {
      writer.writeFragments([...described.values()])
    } catch {
      /* inspection never changes session admission */
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
    subscriptions.set(key, {
      session,
      off: () => {
        offSettings()
        offClosed()
      },
    })
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
      return session
    },
    // The session announces the new preset itself (`onSettingsChanged`).
    setSessionPreset: (key, name) => host.setSessionPreset(key, name),
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
