import { isAbsolute } from 'node:path'
import { type DaemonScope, readDaemonDiscovery, resolveDaemonScope } from '@agnes/daemon'
import {
  type AuthOption,
  type CreateClientOptions,
  createClient,
  memoryJournal,
  type NodeClient,
  wsTransport,
} from '@agnes/sdk'
import { BootError } from '../errors.js'
import type { BootDeps, Booted, ParsedArgs } from '../types.js'
import { profileNameFrom } from './inputs.js'
import { localPipeFactories } from './pipe-factory.js'

/** A narrow seam for CLI tests; production always uses the Node SDK entry point. */
export type ConnectBootDeps = BootDeps & {
  createClientImpl?: (options: CreateClientOptions) => NodeClient
}

type ConnectTarget =
  | { kind: 'unix'; path: string; serverIdentity?: { pid: number; processStartId: string } }
  | { kind: 'ws'; url: string; protocols?: string[]; auth: AuthOption; origin?: string }

function tokenFrom(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.AGNES_WS_TOKEN || env.AGNES_CONNECT_TOKEN
  return token && token.length > 0 ? token : undefined
}

const PIPE_PREFIX = '\\\\.\\pipe\\'
function pipeName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control bytes in pipe names.
  if (!name || name === '.' || name === '..' || /[\\/:?#\u0000-\u001f\u007f]/.test(name))
    throw new BootError('connect: invalid local pipe name')
  return name
}

/** Encode a local socket/pipe path without putting credentials or query data in the target. */
export function unixConnectTarget(path: string): string {
  if (path.startsWith(PIPE_PREFIX))
    return `pipe:///${encodeURIComponent(pipeName(path.slice(PIPE_PREFIX.length)))}`
  if (!isAbsolute(path)) throw new BootError('connect: Unix socket path must be absolute')
  return `unix://${path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`
}

/**
 * Parse the deliberately small connection grammar. Unix sockets use `unix:///path`; websocket
 * connections use `ws://` or `wss://`; local Windows pipes use `pipe:///NAME`. Upgrade bearers
 * come from the environment so they can
 * never be copied into shell history or printed in diagnostics.
 */
export function parseConnectTarget(value: string, env: NodeJS.ProcessEnv): ConnectTarget {
  let target: URL
  try {
    target = new URL(value)
  } catch {
    throw new BootError('connect: expected unix:///path, pipe:///name or ws(s)://host:port')
  }
  if (target.username || target.password || target.search || target.hash)
    throw new BootError('connect: credentials, query parameters and fragments are not allowed')
  if (target.protocol === 'pipe:') {
    // Inspect the original spelling: URL normalizes dot segments and strips raw controls.
    const match = /^pipe:\/\/\/([^/?#]*)$/i.exec(value)
    if (!match || target.host) throw new BootError('connect: invalid local pipe URL')
    let name: string
    try {
      name = decodeURIComponent(match[1] as string)
    } catch {
      throw new BootError('connect: invalid local pipe URL')
    }
    return { kind: 'unix', path: PIPE_PREFIX + pipeName(name) }
  }
  if (target.protocol === 'unix:') {
    if (target.host || target.pathname.length === 0) throw new BootError('connect: invalid Unix socket URL')
    let path: string
    try {
      path = decodeURIComponent(target.pathname)
    } catch {
      throw new BootError('connect: invalid Unix socket URL')
    }
    if (!isAbsolute(path)) throw new BootError('connect: Unix socket path must be absolute')
    return { kind: 'unix', path }
  }
  if (target.protocol !== 'ws:' && target.protocol !== 'wss:')
    throw new BootError('connect: expected unix:///path, pipe:///name or ws(s)://host:port')
  if (!target.hostname || !target.port) throw new BootError('connect: websocket URL needs a host and port')
  const bearer = tokenFrom(env)
  if (!bearer) throw new BootError('connect: AGNES_WS_TOKEN is required for WebSocket connections')
  // `AGNES_CONNECT_JWT` is the application credential for a remote WSS daemon. Local Web uses the
  // same lifecycle bearer with local auth, so the two credentials stay explicit and cannot be
  // accidentally sent to the wrong server.
  const jwt = env.AGNES_CONNECT_JWT
  return {
    kind: 'ws',
    url: target.href,
    protocols: ['agnes-v1', `agnes-bearer.${bearer}`],
    auth: jwt && jwt.length > 0 ? { kind: 'jwt', token: jwt } : { kind: 'local' },
    ...(env.AGNES_WEB_ORIGIN ? { origin: env.AGNES_WEB_ORIGIN } : {}),
  }
}

function connectOptions(target: ConnectTarget, scope?: DaemonScope): CreateClientOptions {
  if (target.kind === 'unix')
    return {
      transport: target,
      auth: { kind: 'local' },
      journal: memoryJournal(),
      ...(scope ? { transportFactories: localPipeFactories(target.path, scope) } : {}),
    }
  const origin = target.origin
  return {
    transport: target,
    auth: target.auth,
    journal: memoryJournal(),
    ...(origin
      ? {
          transportFactories: {
            ws: (option) => {
              if (option.kind !== 'ws') throw new TypeError('ws factory requires a ws option')
              return wsTransport({ ...option, headers: { Origin: origin } })
            },
          },
        }
      : {}),
  }
}

/** Connects to an already-running daemon and owns only the SDK client. */
export async function bootConnect(p: ParsedArgs, deps: ConnectBootDeps): Promise<Booted> {
  if (!p.connect) throw new BootError('connect: target is missing')
  const target = parseConnectTarget(p.connect, deps.env)
  let scope: DaemonScope | undefined
  if (target.kind === 'unix' && target.path.startsWith(PIPE_PREFIX)) {
    try {
      scope = await resolveDaemonScope({
        env: deps.env,
        cwd: p.cwd ?? deps.cwd,
        ...(deps.home ? { home: deps.home } : {}),
        ...(p.profile ? { profile: p.profile } : {}),
        ...(deps.agnesVersion ? { agnesVersion: deps.agnesVersion } : {}),
      })
      const discovery = await readDaemonDiscovery(scope)
      if (!discovery || discovery.socketPath !== target.path)
        throw new BootError('connect: pipe does not match a verified daemon; check home, profile and cwd')
      target.serverIdentity = {
        pid: discovery.owner.pid,
        processStartId: discovery.owner.processStartId,
      }
    } catch (error) {
      if (error instanceof BootError) throw error
      throw new BootError('connect: daemon identity could not be verified', error)
    }
  }
  return connectTarget(p, deps, target, scope)
}

/** Internal automatic boot path: discovery already carries a local socket/pipe address. */
export function bootLocalConnect(
  p: ParsedArgs,
  deps: ConnectBootDeps,
  path: string,
  owner?: { pid: number; processStartId: string },
  scope?: DaemonScope,
): Promise<Booted> {
  if (path.startsWith(PIPE_PREFIX) && (!owner || !scope))
    throw new BootError('connect: verified daemon identity is missing')
  return connectTarget(
    p,
    deps,
    {
      kind: 'unix',
      path,
      ...(path.startsWith(PIPE_PREFIX) && owner
        ? { serverIdentity: { pid: owner.pid, processStartId: owner.processStartId } }
        : {}),
    },
    scope,
  )
}

async function connectTarget(
  p: ParsedArgs,
  deps: ConnectBootDeps,
  target: ConnectTarget,
  scope?: DaemonScope,
): Promise<Booted> {
  const started = performance.now()
  const profileName = profileNameFrom(p, deps.env)
  const makeClient = deps.createClientImpl ?? createClient
  let client: NodeClient | undefined
  try {
    client = makeClient(connectOptions(target, scope))
    await client.initialize()
  } catch (error) {
    await client?.close().catch(() => undefined)
    throw error instanceof BootError ? error : new BootError('connect handshake failed', error)
  }
  if (!client) throw new BootError('connect handshake failed: client was not created')
  return {
    client,
    profileName,
    resolvedProfileHash: null,
    bootMs: performance.now() - started,
    form: 'connect',
    // A connected client must not close the daemon or any other client. The SDK closes the socket
    // and detaches its own sessions; the owner of the local/WSS listener remains untouched.
    close: () => client.close(),
  }
}
