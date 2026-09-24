// Browser build entry point: no signing, no identity minting, no relay, no file journal.
// Everything exported here is isomorphic - TextEncoder, TextDecoder, Web Crypto,
// queueMicrotask, setTimeout and AbortSignal only. The stdio and unix transports will
// be wired into the node entry point alone.

import { isResourceControlMethod } from '@agnes/resource-control-client-node'
import type { AuthOption } from './auth.js'
import {
  Client as BaseClient,
  type CallOptions,
  type CreateClientOptions,
  type TransportOption,
} from './client.js'
import { Unsupported } from './errors.js'
import { localStorageJournal } from './journal-local-storage.js'
import { wsTransport } from './transport/ws.js'

export type BrowserAuthOption = Extract<AuthOption, { kind: 'jwt' | 'portal-identity' | 'local' }>
export type BrowserCreateClientOptions = Omit<
  CreateClientOptions,
  'auth' | 'transport' | 'authProviders' | 'transportFactories'
> & {
  auth?: BrowserAuthOption
  transport: Extract<TransportOption, { kind: 'ws' }>
  authProviders?: never
  transportFactories?: never
}

function normalizeBrowserOptions(opts: BrowserCreateClientOptions): CreateClientOptions {
  const unchecked = opts as CreateClientOptions
  if (unchecked.transport.kind !== 'ws') throw new TypeError('browser client requires ws transport')
  if (unchecked.auth && !['local', 'jwt', 'portal-identity'].includes(unchecked.auth.kind))
    throw new TypeError('browser client auth kind unsupported')
  return {
    ...unchecked,
    journal:
      unchecked.journal ??
      localStorageJournal(
        undefined,
        unchecked.clientId === undefined ? 'agnes-sdk-journal' : `agnes-sdk-journal:${unchecked.clientId}`,
        unchecked.clientId,
      ),
    // Ignore an untyped caller's injected provider/factory tables too.
    authProviders: {},
    transportFactories: {
      ws: (option) => {
        if (option.kind !== 'ws') throw new TypeError('ws factory requires a ws option')
        return wsTransport(option)
      },
    },
  }
}

/** Browser code may read the public client-module roster, but backend service dispatch is BFF-only. */
function browserControlPlaneMethod(method: string): boolean {
  return (
    method.startsWith('_agnes/v1/packages.') ||
    method.startsWith('_agnes/v1/extension.') ||
    method === '_agnes/v1/clientModules.callService' ||
    method === '_agnes/v1/clientModules.callEffect' ||
    isResourceControlMethod(method)
  )
}

export class Client extends BaseClient {
  constructor(opts: BrowserCreateClientOptions) {
    super(normalizeBrowserOptions(opts))
  }

  override call<T>(method: string, params: unknown, options?: CallOptions): Promise<T> {
    if (browserControlPlaneMethod(method))
      return Promise.reject(new Unsupported('Node-only control-plane method'))
    return super.call(method, params, options)
  }

  override notify(method: string, params: unknown): Promise<void> {
    if (browserControlPlaneMethod(method))
      return Promise.reject(new Unsupported('Node-only control-plane method'))
    return super.notify(method, params)
  }
}

export function createClient(opts: BrowserCreateClientOptions): Client {
  return new Client(opts)
}
export type {
  WorkspaceAddParams,
  WorkspaceAddResult,
  WorkspaceEntry,
  WorkspaceListParams,
  WorkspaceListResult,
} from '@agnes/protocol'
export { type AuthProvider, jwtAuth, localAuth, portalIdentityAuth } from './auth.js'
export * from './branding.js'
export type {
  CallOptions,
  ClientEvent,
  ConnectionState,
  GapEvent,
  GenerationChangedEvent,
  InitializeInfo,
  ReconnectedEvent,
} from './client.js'
export * from './errors.js'
// Emitter only: `Disposer` is the same `() => void` in both modules, and re-exporting
// it twice would make the name ambiguous on the package surface.
export { Emitter } from './events.js'
export { jcs } from './jcs.js'
export * from './journal.js'
export { localStorageJournal, type StorageLike } from './journal-local-storage.js'
export { loginCodex, loginSubscription, type OAuthClient, type OAuthInteraction } from './oauth.js'
export * from './preview-merger.js'
export * from './rpc.js'
export * from './session.js'
export * from './text.js'
export * from './transport/jsonl.js'
export * from './transport/types.js'
export { type WebSocketLike, type WsOptions, wsTransport } from './transport/ws.js'
export * from './ui-projection-sync.js'
