import { createWebServer, DEFAULT_WEB_PORT, type WebServer } from '@agnes/web/server'
import { ensureLocalBackend, type LocalBackend } from './backend.js'
import { localOAuthAdmin } from './oauth-admin.js'
import { localPackageAdmin } from './package-admin.js'
import { localResourceAdmin } from './resource-admin.js'
import { type LaunchResources, resolveLaunchResources } from './resources.js'
import { fetchSurfaceMountProxy } from './surface-mounts.js'
import { createNativeWorkspacePicker } from './workspace-picker.js'

export type WebCommandIO = {
  env?: NodeJS.ProcessEnv
  cwd?: string
  write?: (text: string) => void
  resources?: LaunchResources
  createServer?: typeof createWebServer
  ensureBackend?: typeof ensureLocalBackend
  signals?: NodeJS.EventEmitter
}

export type WebCommandOptions = {
  home?: string
  profile?: string
  cwd?: string
  dataDir?: string
  port?: number
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

function parsePort(value: string | undefined): number {
  const result = Number(value ?? DEFAULT_WEB_PORT)
  if (!Number.isInteger(result) || result < 1 || result > 65_535) throw new Error('invalid Web port')
  return result
}

function portFromOrigin(value: string): number {
  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    throw new Error('AGNES_WEB_ORIGIN must be an exact loopback HTTP origin')
  }
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.port === '' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    origin.origin !== value
  )
    throw new Error('AGNES_WEB_ORIGIN must be an exact loopback HTTP origin')
  return parsePort(origin.port)
}

export function parseWebCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): WebCommandOptions {
  const home = option(argv, '--home')
  const profile = option(argv, '--profile') ?? env.AGNES_PROFILE ?? 'local-dev'
  const cwd = option(argv, '--cwd')
  const dataDir = option(argv, '--data-dir')
  const selectedPort = option(argv, '--port')
  return {
    ...(home ? { home } : {}),
    ...(profile ? { profile } : {}),
    ...(cwd ? { cwd } : {}),
    ...(dataDir ? { dataDir } : {}),
    port:
      selectedPort === undefined
        ? env.AGNES_WEB_ORIGIN
          ? portFromOrigin(env.AGNES_WEB_ORIGIN)
          : DEFAULT_WEB_PORT
        : parsePort(selectedPort),
  }
}

function exactOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

function waitForSignal(signals: NodeJS.EventEmitter): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      signals.removeListener('SIGINT', onSigint)
      signals.removeListener('SIGTERM', onSigterm)
      resolve(signal)
    }
    const onSigint = (): void => onSignal('SIGINT')
    const onSigterm = (): void => onSignal('SIGTERM')
    signals.once('SIGINT', onSigint)
    signals.once('SIGTERM', onSigterm)
  })
}

/**
 * Run the local Web command using the CLI-owned shared daemon bootstrap.
 *
 * This function owns the static HTTP server and the SDK-side client returned by the bootstrap.
 * Closing either resource leaves the shared daemon and its other clients running; an operator can
 * stop that daemon explicitly through the normal daemon control command.
 */
export async function runWebCommand(
  argv: readonly string[] = process.argv.slice(2),
  io: WebCommandIO = {},
): Promise<void> {
  const parsed = parseWebCommand(argv, io.env ?? process.env)
  const cwd = parsed.cwd ?? io.cwd ?? process.cwd()
  const port = parsed.port ?? DEFAULT_WEB_PORT
  const origin = exactOrigin(port)
  const resources = io.resources ?? resolveLaunchResources()
  const ensure = io.ensureBackend ?? ensureLocalBackend
  const makeServer = io.createServer ?? createWebServer
  let backend: LocalBackend | undefined
  let web: WebServer | undefined
  let admin: ReturnType<typeof localPackageAdmin> | undefined
  let resourceAdmin: ReturnType<typeof localResourceAdmin> | undefined
  let oauthAdmin: ReturnType<typeof localOAuthAdmin> | undefined
  let mounts: Awaited<ReturnType<typeof fetchSurfaceMountProxy>> | undefined
  try {
    backend = await ensure({
      ...(io.env ? { env: io.env } : {}),
      cwd,
      ...(parsed.home ? { home: parsed.home } : {}),
      ...(parsed.profile ? { profile: parsed.profile } : {}),
      ...(parsed.dataDir ? { dataDir: parsed.dataDir } : {}),
      workspace: cwd,
      webOrigin: origin,
      webPort: port,
      resources,
    })
    if (!backend.web)
      throw new Error('local daemon Web credential is unavailable; stop/restart the local daemon')
    const adminHandler = localPackageAdmin(backend, origin)
    const resourceAdminHandler = localResourceAdmin(backend, origin)
    // The OAuth callback endpoints need the launcher's OWN externally-reachable origin (they build
    // an absolute `redirect_uri` a real, external authorization server redirects a browser back to,
    // not a same-process relative URL), which is exactly `origin` - the same value already handed
    // to createWebServer below.
    const oauthAdminHandler = localOAuthAdmin(backend, new URL(origin))
    admin = adminHandler
    resourceAdmin = resourceAdminHandler
    oauthAdmin = oauthAdminHandler
    // Polls over the same private daemon connection package-admin/resource-admin use, refreshing every
    // `SURFACE_MOUNT_REFRESH_MS` (spec RC1) so a Surface instance `agnesd` hot-updates after this
    // process's boot is picked up within a bounded window instead of never -- see
    // packages/cli/launch/surface-mounts.ts.
    mounts = await fetchSurfaceMountProxy(backend)
    web = await makeServer({
      root: resources.webRoot,
      wsUrl: backend.web.url,
      port,
      origin,
      workspacePicker: createNativeWorkspacePicker({ env: io.env ?? process.env }),
      // `/skins/*` bytes come from the daemon over the launcher's private connection: this process
      // does not own the package store, so it never resolves a skin path itself (design §22).
      skinAsset: (pathname: string) => adminHandler.readSkin(pathname),
      // `/plugins/*` client module bytes follow the same rule (design WC3): the daemon resolves
      // from its immutable snapshots over the same private connection; the launcher never touches
      // the package store itself.
      clientModuleAsset: (pathname: string) => adminHandler.readClientModule(pathname),
      // The daemon's roster invalidation is bridged to a separate same-origin SSE stream. This only
      // reloads browser modules; it never restarts the daemon/worker runtime.
      subscribePluginEvents: (listener) => adminHandler.subscribeClientModuleEvents(listener),
      // `handleAdmin` is already a fallback chain (package admin, then resource admin); the OAuth
      // callback endpoints join the same chain as a third link rather than server.ts gaining a
      // dedicated `oauthHandler` field, since server.ts's own contract only ever calls one
      // `handleAdmin` hook and nothing about that contract is OAuth-specific here - see the Task 4
      // report for why this reads cleaner than threading a second, parallel hook through server.ts.
      handleAdmin: async (request, response) =>
        // The generic admin router claims unknown `/api/*` requests. Check the fixed browser
        // service BFF first so its POST endpoint cannot be turned into an admin 405.
        (await adminHandler.handleClientService(request, response)) ||
        (await adminHandler.handleClientEffect(request, response)) ||
        (await adminHandler.handle(request, response)) ||
        (await resourceAdminHandler.handle(request, response)) ||
        oauthAdminHandler.handle(request, response),
      mountProxy: mounts.proxy,
    })
    ;(io.write ?? ((text: string) => process.stdout.write(text)))(`${web.url}/\n`)
    await waitForSignal(io.signals ?? process)
  } finally {
    await web?.close().catch(() => undefined)
    await admin?.close().catch(() => undefined)
    await resourceAdmin?.close().catch(() => undefined)
    await oauthAdmin?.close().catch(() => undefined)
    await mounts?.close().catch(() => undefined)
    await backend?.closeClient().catch(() => undefined)
  }
}
