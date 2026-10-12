import { Dispatcher, Dispatcher1Wrapper, getGlobalDispatcher } from 'undici'

/** Per-request policy; reuse the selected dispatcher without replacing or closing its pool. */
export function inferenceFetch(
  fetchImpl: typeof globalThis.fetch | undefined,
  failure: (error: unknown) => void,
): typeof globalThis.fetch {
  const selected = new (class extends Dispatcher {
    override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      const observed = new Proxy(handler, {
        get(target, key) {
          if (key === 'onResponseError')
            return (controller: Dispatcher.DispatchController, error: Error) => {
              failure(error)
              target.onResponseError?.(controller, error)
            }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return getGlobalDispatcher().dispatch({ ...options, bodyTimeout: 0, headersTimeout: 0 }, observed)
    }
  })()
  const dispatcher: Pick<Dispatcher, 'dispatch'> = {
    dispatch(options, handler) {
      // Native Node fetch uses the legacy handler contract; injected Undici fetch may use v2/H2.
      return typeof handler.onRequestStart === 'function'
        ? selected.dispatch(options, handler)
        : new Dispatcher1Wrapper(selected).dispatch(options, handler)
    },
  }
  return async (input, init) => {
    try {
      return await (fetchImpl ?? globalThis.fetch)(input, { ...init, dispatcher } as RequestInit)
    } catch (error) {
      failure(error)
      throw error
    }
  }
}
