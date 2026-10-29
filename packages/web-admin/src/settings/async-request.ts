import { useLayoutEffect, useRef } from 'react'

/**
 * Capture the owning read lifetime before starting work. The controller identity is the epoch:
 * refresh/cleanup retires every callback, including catch/finally, even if an adapter ignores abort.
 * Never decide whether an old operation is current using only the latest controller's signal.
 */
export function captureRequest(lifetime: { readonly current: AbortController | undefined }) {
  const controller = lifetime.current
  return {
    signal: controller?.signal,
    isCurrent: () => !!controller && controller === lifetime.current && !controller.signal.aborted,
  }
}

/** A connection or pushed page owns its requests; closing/reopening creates a fresh epoch. */
export function useRequestScope(scope: unknown, page?: unknown) {
  const lifetime = useRef<AbortController>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes retire pending callbacks and reset their UI state.
  useLayoutEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => controller.abort()
  }, [scope, page])
  return lifetime
}
