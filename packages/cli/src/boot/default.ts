import type { Booted, ParsedArgs } from '../types.js'
import { type EnsureLocalBackendOptions, ensureLocalBackend } from './backend.js'
import { bootConnect, bootLocalConnect, type ConnectBootDeps } from './connect.js'
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
  if (p.connect !== undefined) return bootConnect(p, deps)
  if (options.useEmbedded || p.standalone || p.ephemeral || p.mode === 'acp' || p.command === 'acp')
    return bootLocal(p, deps)

  const backend = await ensureLocalBackend({
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
  try {
    const connected = await bootLocalConnect(
      p,
      deps,
      backend.socketPath,
      backend.discovery.owner,
      backend.scope,
    )
    return {
      ...connected,
      profileName: backend.scope.profile,
      resolvedProfileHash: backend.discovery.profileHash,
    }
  } catch (error) {
    await backend.closeClient().catch(() => undefined)
    throw error
  }
}

function depsForBackend(
  options: DefaultBootOptions['backend'],
): Omit<EnsureLocalBackendOptions, 'env' | 'cwd' | 'home' | 'profile' | 'signal' | 'agnesVersion'> {
  return options ?? {}
}
