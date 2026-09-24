/** A minimal SDK-agnostic transport callback port. */
export type CloseObservableTransport = {
  onclose?: (() => void) | undefined
  onerror?: ((error: Error) => void) | undefined
}

/**
 * Chains an SDK transport's callbacks after its client has installed them. Returning the disposer
 * restores those callbacks, so intentional client shutdown cannot be misreported as a disconnect.
 */
export function observeTransportDisconnect(
  transport: CloseObservableTransport,
  notify: () => void,
): () => void {
  const priorClose = transport.onclose
  const priorError = transport.onerror
  const notifyAfter = (prior: () => void): void => {
    let priorFailed = false
    let priorFailure: unknown
    try {
      prior()
    } catch (failure) {
      priorFailed = true
      priorFailure = failure
    }
    try {
      notify()
    } catch (failure) {
      // Preserve the SDK callback's original failure when both callbacks throw. A separate flag
      // also preserves legal JavaScript throws such as `throw undefined`.
      throw priorFailed ? priorFailure : failure
    }
    if (priorFailed) throw priorFailure
  }
  const close = (): void => notifyAfter(() => priorClose?.())
  const error = (cause: Error): void => notifyAfter(() => priorError?.(cause))
  transport.onclose = close
  transport.onerror = error
  return () => {
    if (transport.onclose === close) transport.onclose = priorClose
    if (transport.onerror === error) transport.onerror = priorError
  }
}
