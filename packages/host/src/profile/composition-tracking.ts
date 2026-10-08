import type { Host } from '../host.js'
import { createHostFacade } from '../host-facade.js'
import { resolvePreset } from '../presets/resolve.js'
import { resolveComposition } from './composition.js'
import {
  CompositionSessionStore,
  createLiveCompositionWriter,
  type LiveCompositionSession,
} from './composition-state.js'
import { describeCapabilitySession } from './session-capability-view.js'
import type { ResolvedProfile } from './types.js'

/** Keep legacy Hosts' behavior unchanged while exposing the same safe live inspection surface. */
export async function trackHostComposition(
  host: Host,
  profile: ResolvedProfile,
  profileDir: string,
): Promise<Host> {
  const writer = await createLiveCompositionWriter(profileDir)
  const store = new CompositionSessionStore(profileDir)
  const live = (): readonly LiveCompositionSession[] =>
    [...host.kernel.sessions.values()].map((session) => {
      const tree = resolveComposition(profile, {
        preset: resolvePreset(session.preset.name, host.presets, { limits: profile.limits }).doc,
      })
      return describeCapabilitySession(host, session, tree, profile.bundleCatalog)
    })
  const publish = () => {
    try {
      writer.write(live())
    } catch {
      /* inspection never changes session admission */
    }
  }
  const timer = setInterval(publish, 1000)
  timer.unref()
  let closing: Promise<void> | undefined
  const overrides: Partial<Host> = {
    compositionSessions: live,
    async createSession(input) {
      if (input.bundles?.length) resolveComposition(profile, { sessionBundles: input.bundles })
      const session = await host.createSession(input),
        close = session.close.bind(session)
      store.pin({
        sessionKey: session.key,
        tree: resolveComposition(profile, {
          preset: resolvePreset(session.preset.name, host.presets, { limits: profile.limits }).doc,
        }),
        profile,
        legacy: true,
      })
      session.close = async () => {
        try {
          await close()
        } finally {
          publish()
        }
      }
      publish()
      return session
    },
    async setSessionPreset(key, name) {
      const seq = await host.setSessionPreset(key, name)
      publish()
      return seq
    },
    async releaseSessionGeneration(key) {
      await host.releaseSessionGeneration?.(key)
      store.release(key)
    },
    close() {
      if (closing) return closing
      clearInterval(timer)
      closing = host.close().finally(() => writer.close())
      return closing
    },
  }
  return createHostFacade(host, overrides)
}
