import { type DaemonScope, readDaemonDiscovery } from '@agnes/daemon'
import { type CreateClientOptions, unixTransport } from '@agnes/sdk'

/** Keep discovery in the launcher and refresh its trusted identity on every SDK attempt. */
export function localPipeFactories(
  path: string,
  scope: DaemonScope,
): NonNullable<CreateClientOptions['transportFactories']> {
  if (!path.startsWith('\\\\.\\pipe\\')) return {}
  const selectedScope = { ...scope }
  return {
    unix: () =>
      unixTransport({
        path,
        resolveServerIdentity: async () => {
          const discovery = await readDaemonDiscovery(selectedScope)
          if (!discovery || discovery.socketPath !== path)
            throw new Error('local pipe does not match a verified daemon')
          return { pid: discovery.owner.pid, processStartId: discovery.owner.processStartId }
        },
      }),
  }
}
