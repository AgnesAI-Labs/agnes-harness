import { rpcError } from '@agnes/protocol'
import { JsonRpcError } from '@agnes/sdk/browser'

/**
 * Methods only the owner's own workbench page may call: reviewing and deciding owner inputs. Plugin
 * code in the page shares that page's connection, so every host API handed to plugin code (the client
 * module facade, plugin home pages, workbench panels) refuses them. Same-page code is not an isolated
 * boundary; this closes the official plugin paths, not a page that patches its own WebSocket.
 */
export function isOwnerOnlyMethod(method: unknown): boolean {
  return typeof method === 'string' && method.startsWith('_agnes/v1/managedInput.')
}

function refuse(method: string): Promise<never> {
  return Promise.reject(
    new JsonRpcError(rpcError('CAPABILITY_DENIED', { method, reason: 'owner web page required' })),
  )
}

/** `call` with the owner-only methods refused before anything is sent. */
export function withoutOwnerOnly<A extends unknown[], R>(
  call: (method: string, ...rest: A) => Promise<R>,
): (method: string, ...rest: A) => Promise<R> {
  return (method, ...rest) => (isOwnerOnlyMethod(method) ? refuse(method) : call(method, ...rest))
}

const clients = new WeakMap<object, object>()
const sessions = new WeakMap<object, object>()

function view<T extends object>(
  cache: WeakMap<object, object>,
  target: T,
  get: (target: T, key: string | symbol) => unknown,
): T {
  const cached = cache.get(target)
  if (cached) return cached as T
  const proxy = new Proxy(target, {
    get(inner, key) {
      const own = get(inner, key)
      if (own !== undefined) return own
      const value = Reflect.get(inner, key, inner)
      return typeof value === 'function' ? value.bind(inner) : value
    },
  })
  cache.set(target, proxy)
  return proxy
}

/** An SDK client as plugin code sees it: owner-only methods refused, the raw connection hidden. */
export function pluginClient<C extends object>(client: C): C {
  return view(clients, client, (inner, key) => {
    if (key === 'conn') return null
    if (key === 'call' || key === 'notify') {
      const send = Reflect.get(inner, key, inner) as (method: string, ...rest: unknown[]) => Promise<unknown>
      return withoutOwnerOnly(send.bind(inner))
    }
    return undefined
  })
}

/** An SDK session as plugin code sees it: its `client` is the plugin view of the client. */
export function pluginSession<S extends object>(session: S): S {
  return view(sessions, session, (inner, key) => {
    if (key !== 'client') return undefined
    const client = Reflect.get(inner, key, inner)
    return client && typeof client === 'object' ? pluginClient(client) : client
  })
}
