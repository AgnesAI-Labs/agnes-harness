import { daemonStatus, resolveDaemonScope } from '@agnes/daemon'
import { BootError } from '../errors.js'
import { timingMark } from '../timing.js'
import { resolveLocale } from '../tui/locale.js'
import type { Booted, ParsedArgs } from '../types.js'
import { type EnsureLocalBackendOptions, ensureLocalBackend } from './backend.js'
import { bootConnect, type ConnectBootDeps } from './connect.js'
import { localPreparation } from './connection-scope.js'
import { bootLocal, type LocalBootDeps } from './local.js'

export type DefaultBootDeps = LocalBootDeps & Pick<ConnectBootDeps, 'createClientImpl'>

export type DefaultBootOptions = {
  /** The explicit test/embedder seam that asks for the historical in-process endpoint. */
  useEmbedded?: boolean
  /** Passed through for a Web launcher that only needs the scope/discovery result. */
  backend?: Omit<EnsureLocalBackendOptions, 'env' | 'cwd' | 'home' | 'profile' | 'signal' | 'agnesVersion'>
}

/**
 * Select the CLI's transport before any mode runs. Ordinary sessions share the detached daemon;
 * explicit `--connect`, `--standalone`, and `--ephemeral` retain their documented lifecycle.
 */
export async function bootDefault(
  p: ParsedArgs,
  deps: DefaultBootDeps,
  options: DefaultBootOptions = {},
): Promise<Booted> {
  const booted = await selectBoot(p, deps, options)
  timingMark('booted', deps.env)
  return booted
}

async function selectBoot(
  p: ParsedArgs,
  deps: DefaultBootDeps,
  options: DefaultBootOptions,
): Promise<Booted> {
  if (p.connect !== undefined) return bootConnect(p, deps)
  if (p.standalone && !p.ephemeral && !options.useEmbedded) {
    const scope = await resolveDaemonScope({
      env: deps.env,
      cwd: p.cwd ?? deps.cwd,
      home: deps.home,
      ...(p.profile ? { profile: p.profile } : {}),
    })
    if ((await daemonStatus(scope.home)).running)
      throw new BootError(
        'A daemon is already running for this home/profile. Omit --standalone to connect, or use --ephemeral for an isolated run.',
      )
  }
  if (options.useEmbedded || p.standalone || p.ephemeral) return bootLocal(p, deps)

  const started = performance.now()
  const backend = await ensureLocalBackend({
    preparation: localPreparation(p),
    // The client that proves readiness is this session's connection: one client, one initialize.
    retainClient: { locale: resolveLocale(deps.env) },
    env: deps.env,
    cwd: p.cwd ?? deps.cwd,
    ...(deps.home ? { home: deps.home } : {}),
    ...(p.profile ? { profile: p.profile } : {}),
    ...(deps.agnesVersion ? { agnesVersion: deps.agnesVersion } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(deps.createClientImpl ? { createClientImpl: deps.createClientImpl } : {}),
    // IPC attachment does not request a Web origin or its credential. Preserve the default
    // listener only for a newly started daemon; an explicit origin remains a strict requirement.
    ...(deps.env.AGNES_WEB_ORIGIN !== undefined
      ? {
          webOrigin: deps.env.AGNES_WEB_ORIGIN,
          localWeb: { addr: '127.0.0.1:0', origin: deps.env.AGNES_WEB_ORIGIN },
        }
      : { startupWeb: { addr: '127.0.0.1:0', origin: 'http://127.0.0.1:4177' } }),
    ...depsForBackend(options.backend),
  })
  const client = backend.client
  if (!client) throw new BootError('connect handshake failed: client was not created')
  return {
    client,
    profileName: backend.scope.profile,
    resolvedProfileHash: backend.discovery.profileHash,
    bootMs: performance.now() - started,
    form: 'connect',
    // The SDK closes only this socket and its own sessions; the daemon keeps running.
    close: () => client.close(),
  }
}

function depsForBackend(
  options: DefaultBootOptions['backend'],
): Omit<EnsureLocalBackendOptions, 'env' | 'cwd' | 'home' | 'profile' | 'signal' | 'agnesVersion'> {
  return options ?? {}
}
