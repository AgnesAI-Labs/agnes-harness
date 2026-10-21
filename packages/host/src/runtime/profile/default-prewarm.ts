import { loopPatch, resolveComposition } from '@agnes/host-common/profile/composition'
import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { CompositionBinding } from '@agnes/host-providers/profile/composition-state'
import { type RuntimeGenerationSnapshotStore, withPackageVerification } from '@agnes/package-manager'
import type { LoopSelection } from '@agnes/protocol'
import { assertGenerationTrust } from '../generation/trust.js'
import type { HostOptions } from '../lifecycle/host.js'
import { type createHostCallQueue, hostIsIdle } from '../lifecycle/host-idle.js'
import { type CompositionContainer as Container, profileForComposition } from './composition-selection.js'
import { admitSessionBundlePresets } from './session-bundle-presets.js'

/** Opportunistic work joins the Host's admission queue only when foreground work has drained.
 * The owner keeps the result in its ordinary composition map, never a second admission cache. */
export function defaultPrewarm(o: {
  busy(): boolean
  prepare(): Promise<void>
  diagnostic(detail: { outcome: 'ready' | 'failed'; rssBefore: number; rssAfter: number }): void
}) {
  let closed = false
  let dirty = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    if (closed || running || timer || !dirty) return
    timer = setTimeout(run, 100)
    timer.unref()
  }
  const run = () => {
    timer = undefined
    if (closed) return
    if (o.busy()) return schedule()
    dirty = false
    running = true
    const rssBefore = process.memoryUsage().rss
    void Promise.resolve()
      .then(o.prepare)
      .then(
        () => report('ready'),
        () => report('failed'),
      )
      .finally(() => {
        running = false
        schedule()
      })
    function report(outcome: 'ready' | 'failed') {
      try {
        if (!closed) o.diagnostic({ outcome, rssBefore, rssAfter: process.memoryUsage().rss })
      } catch {
        // Diagnostic observers cannot turn speculative work into an unhandled failure.
      }
    }
  }
  return {
    invalidate() {
      dirty = true
      schedule()
    },
    close() {
      closed = true
      clearTimeout(timer)
    },
  }
}

/** Own one unused default container; admitted sessions keep the ordinary composition lifecycle. */
export function defaultCompositionPrewarm(o: {
  profile: ResolvedProfile
  initial: Container
  state: { container?: Container | undefined }
  containers: Map<string, Container>
  idleSince: Map<Container, number>
  calls: ReturnType<typeof createHostCallQueue>
  admission(): Promise<{ current: ResolvedProfile }>
  adminLoop(): Promise<LoopSelection | undefined>
  open(binding: CompositionBinding): Promise<Container>
  key(binding: CompositionBinding): string
  closed(): boolean
  log: HostOptions['log']
}) {
  const { profile, initial, state, containers, idleSince, calls, admission, open, key, log } = o
  const prewarm = defaultPrewarm({
    busy: () => calls.pending > 0,
    prepare: () =>
      calls.enqueue(() =>
        withPackageVerification(async () => {
          const { current } = await admission()
          if (o.closed()) return
          const adminLoop = await o.adminLoop()
          const admitted = admitSessionBundlePresets(current, initial.host, {})
          const tree = resolveComposition(
            { ...profile, ...admitted.scope },
            {
              packageCatalog: current.packages,
              preset: admitted.preset,
              ...(adminLoop ? { admin: { composition: loopPatch(adminLoop) } } : {}),
            },
          )
          const binding = { sessionKey: '', tree, profile: profileForComposition(admitted.profile, tree) }
          const identity = key(binding)
          // Only the unused speculative container is disposable. Sessions retain their normal owner.
          const previous = state.container
          if (
            previous &&
            previous !== initial &&
            containers.get(identity) !== previous &&
            hostIsIdle(previous.host)
          ) {
            for (const [key, container] of containers) if (container === previous) containers.delete(key)
            idleSince.delete(previous)
            state.container = undefined
            await previous.host.close()
          }
          const prepared = await open(binding)
          // Keep the foreground check armed if post-assembly inspection itself fails.
          state.container = prepared
          if (!prepared.host.pluginGenerationStatus?.().currentGenerationId) {
            state.container = undefined
            throw new Error('Default generation is awaiting runtime publication')
          }
        }),
      ),
    diagnostic: (detail) => {
      const message = `Default composition prewarm ${detail.outcome} rssBefore=${detail.rssBefore} rssAfter=${detail.rssAfter}`
      if (detail.outcome === 'failed') log.warn(message)
      else log.info(message)
    },
  })
  prewarm.invalidate()
  return prewarm
}

/** Speculation never replaces the foreground archive, source-byte or current grant checks. */
export async function verifyPreparedComposition(
  found: Container,
  binding: CompositionBinding,
  generations: Pick<RuntimeGenerationSnapshotStore, 'session' | 'readAsync'>,
  profile: ResolvedProfile,
  options: HostOptions,
): Promise<void> {
  const rssBefore = process.memoryUsage().rss
  // Speculation must not remove the cold-open archive check. Foreground admission still
  // validates its exact durable pin (or the prepared head), bytes and current grant.
  const pin = generations.session(binding.sessionKey)
  const id = pin?.generationId ?? found.host.pluginGenerationStatus?.().currentGenerationId
  if (!id) throw new Error('E_GENERATION_TARGET_MISSING: prepared default has no generation')
  const snapshot = await generations.readAsync(id)
  await assertGenerationTrust(
    snapshot.sources,
    options.profileDir,
    profile.name,
    options.agnesVersion ?? '0.0.0',
    options.runtimePluginSources,
  )
  try {
    options.log.info(
      `Default composition prewarm reused rssBefore=${rssBefore} rssAfter=${process.memoryUsage().rss}`,
    )
  } catch {
    // Diagnostics cannot change foreground admission.
  }
}
