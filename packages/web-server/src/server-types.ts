import type { FileUploadHandler } from './upload-route.js'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { type AppServerParams, type AppServerResult } from '@agnes/protocol'

/** What a skin resolver answers with: a file to read, the bytes, or nothing. */
export type SkinAssetResolution = string | Uint8Array | null

/** What a client module resolver answers with: a file to read, the bytes, or nothing. */
export type ClientModuleAssetResolution = string | Uint8Array | null

/** A reload hint for one immutable client-module snapshot. */
export type PluginRebuiltEvent = Readonly<{ packageId: string; revision: string }>

export type WebServerOptions = {
  fileUpload?: FileUploadHandler
  /** Directory containing the built index.html, app.js and style.css files. */
  root: string
  /** Credential-free loopback WebSocket endpoint advertised to the browser. */
  wsUrl: string
  /** @deprecated Ignored legacy input; local Web access no longer uses a browser token. */
  token?: string
  /** Fixed local HTTP port. The default is kept stable for the daemon origin contract. */
  port?: number
  /** Exact page origin selected by the daemon. Defaults to http://127.0.0.1:<port>. */
  origin?: string
  /** Add the source-development reload client and event stream. Disabled for ordinary serve runs. */
  developmentReload?: boolean
  /**
   * Optional fixed admin-surface BFF. It receives matching requests before static routing and
   * returns true only when it wrote the response itself.
   */
  handleAdmin?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>
  /**
   * Optional same-origin skin asset resolver. Receives the request pathname and answers with either
   * an absolute file path, the bytes themselves, or null. Path authority lives in the resolver (the
   * package manager owns it), so this server never learns where packages are installed; it owns only
   * method, MIME and headers.
   *
   * Bytes exist because the production launcher is not the process that owns the files: it asks the
   * daemon over RPC (design §22). Returning bytes keeps that a single round trip with no temporary
   * file to clean up, and it may be async for the same reason.
   */
  skinAsset?: (pathname: string) => SkinAssetResolution | Promise<SkinAssetResolution>
  /**
   * Optional same-origin client module asset resolver for `/plugins/*` (design WC3). Same contract
   * as `skinAsset`: it receives the request pathname and answers with either an absolute file path,
   * the bytes themselves, or null. Path authority lives in the resolver (the daemon answers only
   * from its immutable snapshots), so this server never learns where packages are installed; it owns
   * only method, the three-MIME allowlist and headers. A miss and a refusal are the same null, which
   * this route turns into the same 404 the skin route uses.
   */
  clientModuleAsset?: (pathname: string) => ClientModuleAssetResolution | Promise<ClientModuleAssetResolution>
  /**
   * Optional launcher-owned subscription to daemon roster rebuilds.  The static server only fans
   * these safe `{ packageId, revision }` hints out over same-origin SSE; it neither watches package
   * directories nor learns package-store paths.  A missing subscription deliberately leaves the
   * endpoint alive but inert (release builds have no development watcher).
   */
  subscribePluginEvents?: (
    listener: (event: PluginRebuiltEvent) => void,
  ) => (() => void) | Promise<() => void>
  /**
   * Poll file-backed plugin build artifacts after they are served.  `mtimeMs` is only a cheap
   * sentinel: a rebuilt event is emitted only after the bytes are hashed and the digest differs.
   * This is intentionally stat polling rather than fs.watch because the resolver may point at a
   * network mount.  The default is 500 ms, a proven cadence for network-backed file systems.
   */
  pluginBuildPollMs?: number
  /** Optional launcher-owned native directory picker. Paths are still validated by workspace.add. */
  workspacePicker?: WorkspacePicker
  /**
   * Optional mounted-Surface reverse proxy (`@agnes/daemon`'s `createMountProxy`). A GET/HEAD consults
   * it just before the static asset whitelist (`fileName`) so a mount like `/demo` is not rejected as
   * an unknown asset, and only there: every branch above it (the workspace picker, `handleAdmin`, the
   * fixed admin API 503s under `/admin`, the `/skins` and `/plugins` resolvers) already returns before
   * this point for any request it handles, so this can never shadow them. Any other method consults it
   * from inside the method gate, only when `Origin` is this server's origin and `Sec-Fetch-Site` is
   * absent or `same-origin`; otherwise that request stays a 405. It answers
   * synchronously with whether it claimed the request (the forwarded response itself is written
   * asynchronously); when it returns false or is not provided, behavior is byte-for-byte the same as
   * before this option existed.
   */
  mountProxy?: (request: IncomingMessage, response: ServerResponse) => boolean
  /**
   * Ledger directory for same-origin history search. When omitted, the route uses the standard
   * home data directory. A profile with a custom dataDir must pass this; the route does not guess.
   */
  historyDataDir?: string
  historySearch?: (
    input: AppServerParams<'_agnes/v1/admin.history.search'>,
  ) => Promise<AppServerResult<'_agnes/v1/admin.history.search'>>
  triggers?: (
    input: import('@agnes/protocol/gen/app-server').WebhookRequest,
  ) => Promise<import('@agnes/protocol/gen/app-server').WebhookResult>
  planCommand?: (
    input: AppServerParams<'_agnes/v1/admin.plan'>,
  ) => Promise<AppServerResult<'_agnes/v1/admin.plan'>>
}

export type WorkspacePickerResult =
  | { status: 'selected'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' }

export type WorkspacePicker = {
  available(): Promise<boolean>
  pick(signal: AbortSignal): Promise<WorkspacePickerResult>
}

export type WebServer = {
  url: string
  reloadDevelopmentClients?(): void
  close(): Promise<void>
}
