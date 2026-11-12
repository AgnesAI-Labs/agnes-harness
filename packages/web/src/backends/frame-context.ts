/** Each backend keeps its own Window, SDK connection, plugin runtime and request routing. */
export function backendFrame(): HTMLIFrameElement | undefined {
  if (typeof window === 'undefined' || window.parent === window) return undefined
  try {
    const frame = window.frameElement
    return frame?.getAttribute('data-agh-backend-frame') === '1' ? (frame as HTMLIFrameElement) : undefined
  } catch {
    return undefined
  }
}

export function frameFailure(message: string): void {
  if (backendFrame())
    window.parent.postMessage({ type: 'agh.backend.frame/v1', kind: 'error', message }, location.origin)
}

export function requestBackendEnvironment(remote?: string): boolean {
  if (!backendFrame()) return false
  window.parent.postMessage(
    { type: 'agh.backend.frame/v1', kind: 'environment', ...(remote ? { remote } : {}) },
    location.origin,
  )
  return true
}
