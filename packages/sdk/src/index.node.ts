// Node build entry point. Sensitive capabilities are constructed here so browser builds cannot
// reach them through the shared Client implementation.
import { Client as BaseClient, type CreateClientOptions } from './client.js'
import { defaultNodeJournal } from './default-journal.node.js'
import { createExtensionClient, type ExtensionClient } from './extensions.node.js'
import { mintPortalIdentity, verifyPortalIdentity } from './identity.node.js'
import { createPackageAdminClient, type PackageAdminClient } from './package-admin.node.js'
import { createResourceControlClient, type ResourceControlClient } from './resource-control.node.js'
import { sourceAuthProvider, surfaceAuthProvider } from './sign.node.js'
import { stdioTransport } from './transport/stdio.node.js'
import { unixTransport } from './transport/unix.node.js'
import { wsTransport } from './transport/ws.node.js'

function normalizeNodeOptions(opts: CreateClientOptions): CreateClientOptions {
  return {
    ...opts,
    journal: defaultNodeJournal(opts),
    authProviders: {
      'source-auth': (option) => {
        if (option.kind !== 'source-auth') throw new TypeError('source-auth provider requires source-auth')
        return sourceAuthProvider(option.secret)
      },
      surface: (option) => {
        if (option.kind !== 'surface') throw new TypeError('surface provider requires surface auth')
        return surfaceAuthProvider(option)
      },
      ...opts.authProviders,
    },
    transportFactories: {
      ws: (option) => {
        if (option.kind !== 'ws') throw new TypeError('ws factory requires a ws option')
        return wsTransport(option)
      },
      unix: (option) => {
        if (option.kind !== 'unix') throw new TypeError('unix factory requires a unix option')
        return unixTransport(option)
      },
      stdio: (option) => {
        if (option.kind !== 'stdio') throw new TypeError('stdio factory requires a stdio option')
        return stdioTransport(option)
      },
      ...opts.transportFactories,
    },
  }
}

export class Client extends BaseClient {
  readonly identity = Object.freeze({ mint: mintPortalIdentity, verify: verifyPortalIdentity })
  readonly packages: PackageAdminClient
  readonly resources: ResourceControlClient['resources']
  readonly skills: ResourceControlClient['skills']
  readonly mcp: ResourceControlClient['mcp']
  readonly extensions: ExtensionClient

  constructor(opts: CreateClientOptions) {
    super(normalizeNodeOptions(opts))
    this.packages = createPackageAdminClient(this)
    const resources = createResourceControlClient(this)
    this.resources = resources.resources
    this.skills = resources.skills
    this.mcp = resources.mcp
    this.extensions = createExtensionClient(this)
  }
}

/** The Node entry's client includes server-side control-plane handles. */
export type NodeClient = Client

export function createClient(opts: CreateClientOptions): Client {
  return new Client(opts)
}
export type {
  WorkspaceAddParams,
  WorkspaceAddResult,
  WorkspaceEntry,
  WorkspaceListParams,
  WorkspaceListResult,
} from '@agnes/protocol'
export * from './auth.js'
export * from './branding.js'
export * from './client.js'
export * from './errors.js'
// Emitter only: `Disposer` is the same `() => void` in both modules, and re-exporting
// it twice would make the name ambiguous on the package surface.
export { Emitter } from './events.js'
export * from './extensions.node.js'
export * from './identity.node.js'
export { jcs } from './jcs.js'
export * from './journal.js'
export { fileJournal } from './journal-file.node.js'
export { loginCodex, loginSubscription, type OAuthClient, type OAuthInteraction } from './oauth.js'
export * from './package-admin.node.js'
export * from './preview-merger.js'
export { createRelay, type RelayOptions, type RelayRoute, stripIdentity } from './relay.node.js'
export type { ResourceControlClient, ResourceControlRpc } from './resource-control.node.js'
export { createResourceControlClient } from './resource-control.node.js'
export * from './rpc.js'
export * from './session.js'
export * from './sign.node.js'
export * from './surface.node.js'
export * from './text.js'
export * from './transport/inproc.js'
export * from './transport/jsonl.js'
export * from './transport/stdio.node.js'
export * from './transport/types.js'
export { unixTransport } from './transport/unix.node.js'
export type { WebSocketLike, WsOptions } from './transport/ws.js'
export { wsTransport } from './transport/ws.node.js'
export * from './ui-projection-sync.js'
