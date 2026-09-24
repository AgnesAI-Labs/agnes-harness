import { readDaemonDiscovery, resolveDaemonScope } from '@agnes/daemon'
import { createClient, type TransportFactory, unixTransport } from '@agnes/sdk'
import { ChannelError } from '../errors.js'
import { type RunnerConfig, validateLocalDaemonTarget } from './config.js'

const defaults = { resolveDaemonScope, readDaemonDiscovery, unixTransport }
/** Re-read trusted ownership on every SDK reconnect; never derive identity from the pipe peer. */
export function channelPipeTransport(
  config: Pick<RunnerConfig, 'connect' | 'workspace' | 'localDaemon'>,
  deps = defaults,
  timeoutMs = 3000,
): TransportFactory {
  validateLocalDaemonTarget(config)
  if (config.connect.kind !== 'unix' || !config.connect.path.startsWith('\\\\.\\pipe\\'))
    throw new ChannelError('E_CONFIG_INVALID', 'local pipe transport requires a Windows pipe')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
    throw new ChannelError('E_CONFIG_INVALID', 'invalid local pipe connect timeout')
  const path = config.connect.path
  const scopeOptions = { ...config.localDaemon, workspace: config.workspace, env: { ...process.env } }
  return (handlers) => {
    let expired = false
    const deadline = Date.now() + timeoutMs
    const unavailable = () =>
      new ChannelError('E_DAEMON_UNAVAILABLE', 'cannot verify configured local daemon')
    const remaining = () => {
      const left = deadline - Date.now()
      if (expired || left <= 0) throw unavailable()
      return left
    }
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true
        reject(unavailable())
      }, timeoutMs)
    })
    const connect = async () => {
      const scope = await deps.resolveDaemonScope(scopeOptions)
      const discovery = await deps.readDaemonDiscovery(scope, {
        identityTimeoutMs: Math.min(1000, remaining()),
      })
      remaining()
      if (!discovery || discovery.socketPath !== path) throw unavailable()
      const transport = await deps.unixTransport({
        path,
        serverIdentity: {
          pid: discovery.owner.pid,
          processStartId: discovery.owner.processStartId,
        },
        connectTimeoutMs: remaining(),
      })(handlers)
      if (expired || Date.now() >= deadline) {
        await transport.close()
        throw unavailable()
      }
      return transport
    }
    return Promise.race([connect(), timeout]).finally(() => clearTimeout(timer))
  }
}

export function createChannelClient(config: RunnerConfig) {
  validateLocalDaemonTarget(config)
  const transport =
    config.connect.kind === 'unix'
      ? { kind: 'unix' as const, path: config.connect.path }
      : { kind: 'ws' as const, url: config.connect.url }
  return createClient({
    transport,
    auth: { kind: 'local' },
    ...(transport.kind === 'unix' && transport.path.startsWith('\\\\.\\pipe\\')
      ? {
          transportFactories: { unix: () => channelPipeTransport(config) },
        }
      : {}),
  })
}
