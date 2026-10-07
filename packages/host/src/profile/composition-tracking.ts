import type { Host } from '../host.js'
import { createHostFacade } from '../host-facade.js'
import { resolvePreset } from '../presets/resolve.js'
import { resolveComposition } from './composition.js'
import { createLiveCompositionWriter, type LiveCompositionSession } from './composition-state.js'
import type { ResolvedProfile } from './types.js'

/** Keep legacy Hosts' behavior unchanged while exposing the same safe live inspection surface. */
export async function trackHostComposition(
  host: Host,
  profile: ResolvedProfile,
  profileDir: string,
): Promise<Host> {
  const writer = await createLiveCompositionWriter(profileDir)
  const live = (): readonly LiveCompositionSession[] =>
    [...host.kernel.sessions.values()].map((session) => {
      const tree = resolveComposition(profile, {
        preset: resolvePreset(session.preset.name, host.presets, { limits: profile.limits }).doc,
      })
      const { loop: _loop, modelAdapters: _adapters, compaction, persistence, sandbox } = tree.selection
      const routes = new Set(Object.values(session.preset.model.route))
      return {
        sessionKey: session.key,
        generationId: host.sessionGeneration?.(session.key) ?? '',
        compositionHash: tree.hash,
        preset: session.preset.name,
        bundles: tree.bundles,
        providers: {
          loop: session.loop,
          modelAdapters: [
            ...new Set(
              session.d.provider
                .models()
                .filter((model) => routes.has(model.route))
                .map((model) => model.api),
            ),
          ],
          ...(compaction === undefined ? {} : { compaction }),
          ...(persistence ? { persistence } : {}),
          ...(sandbox ? { sandbox } : {}),
        },
      }
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
    close() {
      if (closing) return closing
      clearInterval(timer)
      closing = host.close().finally(() => writer.close())
      return closing
    },
  }
  return createHostFacade(host, overrides)
}
