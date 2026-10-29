import type { Context } from '@agnes/cordis'
import { type OrdinaryDispatch, SeamRuntime } from './seam.js'

export const DYNAMIC_SEAM_NAMES = [
  'approval',
  'checkpoint',
  'billing',
  'verifier',
  'repair',
  'artifacts',
  'principals',
] as const

export type DynamicSeamName = (typeof DYNAMIC_SEAM_NAMES)[number]

type DynamicSeams = { readonly [K in DynamicSeamName]: object }
type StaticSeams = Readonly<{ sandbox: object; platform: object }>

export type MutableSeamImplementations<T> = Readonly<{
  seams: T
  /**
   * Point the facades at a published root. Callable before any root exists (the facades throw
   * `E_SEAM_UNAVAILABLE` until the first call) and again for every later published root.
   */
  adopt(root: Context): void
  /** Called after any facade's implementation was replaced or released; returns its unsubscribe. */
  onChanged(listener: () => void): () => void
}>

/**
 * Compose stable forwarding facades for the seven runtime seams with the two build-time seams.
 * The generic preserves Core's exact seam interfaces without making plugin-runtime depend on Core.
 */
export function createSeamImplementations<T extends DynamicSeams & StaticSeams>(
  root: Context,
  statics: Pick<T, 'sandbox' | 'platform'>,
  dispatch?: OrdinaryDispatch,
): T {
  const mutable = createMutableSeamImplementations<T>(statics, dispatch)
  mutable.adopt(root)
  return mutable.seams
}

/** Stable seam facades with an explicit Host-only published-root switch. */
export function createMutableSeamImplementations<T extends DynamicSeams & StaticSeams>(
  statics: Pick<T, 'sandbox' | 'platform'>,
  dispatch?: OrdinaryDispatch,
): MutableSeamImplementations<T> {
  const runtimes = new Map<DynamicSeamName, SeamRuntime<object>>()
  const releases = new Map<DynamicSeamName, () => void>()
  const output: Record<string, object> = {
    sandbox: statics.sandbox,
    platform: statics.platform,
  }

  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of [...listeners]) listener()
  }
  const provided = new Map<DynamicSeamName, unknown>()
  const replace = (name: DynamicSeamName, value: unknown): void => {
    // A newly published tree that kept the same implementation changes nothing for the kernel.
    if (value !== undefined && provided.get(name) === value) return
    releases.get(name)?.()
    releases.delete(name)
    provided.delete(name)
    if (value === undefined) {
      changed()
      return
    }
    if (!value || typeof value !== 'object') {
      throw new TypeError(`seam:${name} must provide an object`)
    }
    const runtime = runtimes.get(name)
    if (!runtime) throw new Error(`missing seam runtime: ${name}`)
    releases.set(name, runtime.provide(value))
    provided.set(name, value)
    changed()
  }

  for (const name of DYNAMIC_SEAM_NAMES) {
    const runtime = new SeamRuntime<object>(name, dispatch)
    runtimes.set(name, runtime)
    output[name] = runtime.facade
  }
  let offService: (() => void) | undefined
  const adopt = (root: Context): void => {
    // Retire the previous root's subscription BEFORE adopting the new generation. The published
    // pointer moves synchronously, but the old tree is closed asynchronously afterwards
    // (runtime-state.ts `#retire`). That close unsets every `seam:*` service on the old root, which
    // emits `internal/service` with `undefined`. A subscription left over from the old root would
    // route that into `replace(name, undefined)` and release the value the NEW root just provided,
    // leaving the facade permanently E_SEAM_UNAVAILABLE.
    offService?.()
    offService = undefined
    for (const name of DYNAMIC_SEAM_NAMES) {
      const value = root.get(`seam:${name}`, false) as unknown
      if (value === undefined) throw new Error(`E_SEAM_MISSING: ${name}`)
      replace(name, value)
    }
    offService = root.on(
      'internal/service',
      (service, value) => {
        if (typeof service !== 'string' || !service.startsWith('seam:')) return
        const name = service.slice('seam:'.length) as DynamicSeamName
        if (!DYNAMIC_SEAM_NAMES.includes(name)) return
        replace(name, value)
      },
      { global: true },
    )
  }
  return Object.freeze({
    seams: Object.freeze(output) as T,
    adopt,
    onChanged(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
}
