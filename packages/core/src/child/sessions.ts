import type { KernelChildren } from './factory.js'

const factories = new Map<string, KernelChildren>()

/** Remember the in-process backend for one parent session. A later bind replaces it. */
export function bindChildFactory(sessionKey: string, factory: KernelChildren): void {
  factories.set(sessionKey, factory)
}

/** Drop the binding when it still points at `factory`, or always when `factory` is omitted. */
export function unbindChildFactory(sessionKey: string, factory?: KernelChildren): void {
  if (factory && factories.get(sessionKey) !== factory) return
  factories.delete(sessionKey)
}

export function childBackend(sessionKey: string): KernelChildren | undefined {
  return factories.get(sessionKey)
}
