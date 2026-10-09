import type { ObservabilityProvider } from '@agnes/extension-api'
import {
  type ObservabilityConfig,
  observabilityConfig,
  observabilityHome,
  readObservabilityConfig,
} from './config.js'
import { createObservability } from './provider.js'

// Symbol registry survives module replacement; queues belong to a process/home, not a code fiber.
const key = Symbol.for('@agnes/observability/live-exporters/v1')
type Runtime = {
  provider: ReturnType<typeof createObservability>
  refs: number
  timer: ReturnType<typeof setInterval>
  config: string
  explicit: Partial<ObservabilityConfig>
  closing?: Promise<void>
}
const globals = globalThis as typeof globalThis & { [key]?: Map<string, Runtime> }
const runtimes = globals[key] ?? new Map<string, Runtime>()
globals[key] = runtimes
/** Generation leases share session watermarks and in-flight delivery until the final lease closes. */
export function acquireObservability(
  home = observabilityHome(),
  explicit: Partial<ObservabilityConfig> = {},
): ObservabilityProvider {
  let runtime = runtimes.get(home)
  if (!runtime) {
    const read = () => observabilityConfig(explicit, { ...process.env, AGH_HOME: home })
    const config = read()
    const provider = createObservability(config)
    let reading = false
    runtime = {
      provider,
      refs: 0,
      config: JSON.stringify(config),
      explicit,
      timer: setInterval(async () => {
        if (reading) return
        reading = true
        try {
          const next = await readObservabilityConfig(home, runtime!.explicit),
            identity = JSON.stringify(next)
          if (runtime!.config !== identity) {
            provider.configure(next)
            runtime!.config = identity
          }
        } catch {
          provider.configure({ enabled: false })
          runtime!.config = ''
          /* Invalid live configuration stops capture until a valid snapshot is available. */
        } finally {
          reading = false
        }
      }, 1000),
    }
    runtime.timer.unref()
    runtimes.set(home, runtime)
  } else if (Object.keys(explicit).length) {
    const next = observabilityConfig(explicit, { ...process.env, AGH_HOME: home })
    runtime.provider.configure(next)
    runtime.config = JSON.stringify(next)
    runtime.explicit = explicit
  }
  const owner = runtime
  owner.refs++
  let disposed = false
  return {
    ...owner.provider,
    dispose() {
      if (disposed) return owner.closing ?? Promise.resolve()
      disposed = true
      if (--owner.refs > 0) return Promise.resolve()
      clearInterval(owner.timer)
      runtimes.delete(home)
      owner.closing = owner.provider.dispose()
      return owner.closing
    },
  }
}
export function exporterHealth(home = observabilityHome()) {
  return (
    runtimes.get(home)?.provider.health?.() ?? {
      status: 'disabled' as const,
      queued: 0,
      dropped: 0,
      failures: 0,
    }
  )
}

export function configureExporter(home: string, config: ObservabilityConfig): void {
  const runtime = runtimes.get(home)
  if (runtime) {
    runtime.provider.configure(config)
    runtime.explicit = {}
    runtime.config = JSON.stringify(config)
  }
}
