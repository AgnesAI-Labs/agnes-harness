import type { ClientContext } from '@agnes/web-client'
import type { ExampleRuntime, ExampleSceneHost, ExamplesPort, ExampleView } from './ports.js'

/** Installation, scene registration and the profile-owned simulation are separate readiness facts. */
export function nativeExamples(ctx: ClientContext): ExamplesPort {
  const operations = new Map<string, string>()
  const listeners = new Set<() => void>()
  const runtimes = new Map<string, { runtime: ExampleRuntime; release(): void }>()
  const scenes = new Map<string, NonNullable<ExampleView['Scene']>>()
  type Pending = {
    ticket: string
    operationId: string
    launchId: string
    presentation: unknown
    started: boolean
    requiresRuntime: boolean
  }
  const key = (id: string) => {
    const binding = ctx.module.binding
    if (binding?.lifetime !== 'profile') throw new Error('example-host-unavailable')
    return `agnes.example-launch.${binding.profileId}.${binding.activationId}.${ctx.module.rowId}.${id}`
  }
  const pending = (id: string): Pending | undefined => {
    const saved = sessionStorage.getItem(key(id))
    if (!saved) return undefined
    const value: unknown = JSON.parse(saved)
    if (
      !value ||
      typeof value !== 'object' ||
      !('ticket' in value) ||
      typeof value.ticket !== 'string' ||
      !('operationId' in value) ||
      typeof value.operationId !== 'string' ||
      !('launchId' in value) ||
      typeof value.launchId !== 'string' ||
      !('started' in value) ||
      typeof value.started !== 'boolean' ||
      !('requiresRuntime' in value) ||
      typeof value.requiresRuntime !== 'boolean' ||
      !('presentation' in value)
    )
      throw new Error('example-launch-outcome-unknown')
    return {
      ticket: value.ticket,
      operationId: value.operationId,
      launchId: value.launchId,
      presentation: value.presentation,
      started: value.started,
      requiresRuntime: value.requiresRuntime,
    }
  }
  let disposed = false
  const current = () => {
    if (disposed || ctx.availability.getSnapshot()?.availability !== 'active')
      throw new Error('example-host-unavailable')
  }
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const bind = (id: string, runtime: ExampleRuntime, signal: AbortSignal) => {
    current()
    signal.throwIfAborted()
    if (!ctx.examplePages.render(id, { t: (key) => key })) throw new Error('example-scene-unavailable')
    if (runtimes.has(id)) throw new Error('example-runtime-already-bound')
    let previous = JSON.stringify(runtime.getSnapshot())
    const off = runtime.subscribe(() => {
      const next = JSON.stringify(runtime.getSnapshot())
      if (next !== previous) {
        previous = next
        notify()
      }
    })
    const release = () => {
      if (runtimes.get(id)?.runtime !== runtime) return
      runtimes.delete(id)
      signal.removeEventListener('abort', release)
      off()
      notify()
    }
    runtimes.set(id, { runtime, release })
    signal.addEventListener('abort', release, { once: true })
    notify()
    return release
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const { runtime, release } of [...runtimes.values()]) {
      release()
      void runtime.stop().catch(() => {})
    }
    scenes.clear()
    listeners.clear()
  }
  ctx.effect(() => dispose)
  ctx.effect(() =>
    ctx.availability.subscribe(() => {
      if (ctx.availability.getSnapshot()?.availability !== 'active') dispose()
    }),
  )
  return {
    async list(signal) {
      current()
      const examples = await ctx.profile.examples.list()
      current()
      return Promise.all(
        examples.map(async (example): Promise<ExampleView> => {
          signal.throwIfAborted()
          let state: ExampleView['state'] =
            example.installation === 'enabled'
              ? 'installed'
              : example.installation === 'enabling'
                ? 'starting'
                : example.installation === 'failed'
                  ? 'failed'
                  : 'disabled'
          let code: string | undefined
          if (example.installation === 'enabled' && example.runtime) {
            state = example.runtime.state === 'unavailable' ? 'installed' : example.runtime.state
            code = example.runtime.code
          }
          const operation = operations.get(example.id)
          if (operation) {
            const receipt = await ctx.profile.examples.read(operation)
            signal.throwIfAborted()
            current()
            if (receipt.state === 'completed') operations.delete(example.id)
            else if (receipt.state === 'running') state = 'starting'
            else {
              state = 'failed'
              code = receipt.code ?? receipt.state
            }
          }
          const context = {
            t: (key: string, vars?: Readonly<Record<string, string | number>>) => ctx.locale.t(key, vars),
            session: ctx.session,
          }
          const scene = example.installation === 'enabled' && ctx.examplePages.render(example.id, context)
          if (scene && !scenes.has(example.id)) {
            const bindRuntime = (runtime: ExampleRuntime, lifetime: AbortSignal) =>
              bind(example.id, runtime, lifetime)
            const Scene: NonNullable<ExampleView['Scene']> = ({ onLaunch }) => {
              const data: ExampleSceneHost = {
                kind: 'agnes.mhs-example-scene/v1',
                profileId: ctx.module.binding?.lifetime === 'profile' ? ctx.module.binding.profileId : '',
                exampleId: example.id,
                bindRuntime,
                launch: (launchId) => {
                  current()
                  onLaunch?.(launchId)
                },
              }
              return ctx.examplePages.render(example.id, { ...context, data })
            }
            scenes.set(example.id, Scene)
          }
          const runtime = scene ? runtimes.get(example.id)?.runtime.getSnapshot() : undefined
          if (scene && example.installation === 'enabled' && !code) {
            if (runtime) state = runtime.state
            else if (state === 'running') state = 'installed'
          }
          return {
            id: example.id,
            name: example.metadata.displayName,
            description: example.metadata.description,
            state,
            ...(code ? { code } : {}),
            ...(runtime ? { connected: runtime.connected, total: runtime.total } : {}),
            ...(scene ? { Scene: scenes.get(example.id)!, requiresRuntime: true } : {}),
            ...(example.metadata.launches
              ? { launches: example.metadata.launches.map(({ id, title }) => ({ id, title })) }
              : {}),
          }
        }),
      )
    },
    subscribe(listener) {
      listeners.add(listener)
      const off = ctx.examplePages.subscribe(listener)
      return () => {
        listeners.delete(listener)
        off()
      }
    },
    async inspect(id) {
      current()
      operations.delete(id)
      const review = await ctx.profile.examples.inspect(id)
      current()
      return { reviewId: review.reviewId, presentation: review.presentation }
    },
    async enable(id, reviewId) {
      current()
      if (!reviewId) throw new Error('example-review-required')
      const operation = await ctx.profile.examples.enable(reviewId, crypto.randomUUID())
      current()
      operations.set(id, operation.operationId)
    },
    async stop(id) {
      current()
      try {
        await runtimes.get(id)?.runtime.stop()
      } finally {
        await ctx.profile.examples.stop(id, crypto.randomUUID())
        operations.delete(id)
      }
    },
    async prepare(id, launchId) {
      current()
      const example = (await ctx.profile.examples.list()).find((e) => e.id === id)
      current()
      const chosen = launchId ?? example?.metadata.launches?.[0]?.id
      if (!chosen || !example?.metadata.launches?.some((launch) => launch.id === chosen))
        throw new Error('example-launch-unavailable')
      if (example.metadata.pageEntry && runtimes.get(id)?.runtime.getSnapshot().state !== 'running')
        throw new Error('example-runtime-unavailable')
      const previous = pending(id)
      if (previous?.started) {
        if (previous.launchId !== chosen) throw new Error('example-launch-outcome-unknown')
        return { launchTicket: previous.ticket, presentation: previous.presentation }
      }
      const result = await ctx.profile.launch.prepare(id, chosen)
      current()
      sessionStorage.setItem(
        key(id),
        JSON.stringify({
          ticket: result.launchTicket,
          operationId: crypto.randomUUID(),
          launchId: chosen,
          presentation: result.presentation,
          started: false,
          requiresRuntime: !!example.metadata.pageEntry,
        }),
      )
      return result
    },
    async launch(id, launchTicket) {
      current()
      const launch = pending(id)
      if (!launchTicket || launch?.ticket !== launchTicket) throw new Error('example-launch-review-required')
      if (launch.requiresRuntime && runtimes.get(id)?.runtime.getSnapshot().state !== 'running')
        throw new Error('example-runtime-unavailable')
      sessionStorage.setItem(key(id), JSON.stringify({ ...launch, started: true }))
      const result = await ctx.profile.launch.start(launchTicket, launch.operationId)
      current()
      if (!result.sessionId) throw new Error('example-launch-outcome-unknown')
      sessionStorage.removeItem(key(id))
      return result
    },
  }
}
