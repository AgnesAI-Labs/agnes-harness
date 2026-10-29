import { createServer } from 'node:net'
import type { ManagedServiceDescriptor } from '@agnes/protocol'
import { ManagedServiceError } from './lease.js'

/** OS bind is the final arbiter; releasing this preflight reservation does not remove the spawn race. */
export async function allocateManagedListeners(
  descriptor: ManagedServiceDescriptor,
): Promise<Record<string, { host: '127.0.0.1'; port: number }>> {
  const listeners: Record<string, { host: '127.0.0.1'; port: number }> = {}
  const reservations: ReturnType<typeof createServer>[] = []
  try {
    for (const listener of descriptor.listeners) {
      const server = createServer()
      reservations.push(server)
      await new Promise<void>((resolve, reject) => {
        server.once('error', (error: NodeJS.ErrnoException) =>
          reject(error.code === 'EADDRINUSE' ? new ManagedServiceError('PORT_IN_USE') : error),
        )
        server.listen(
          { host: '127.0.0.1', port: listener.port === 'auto' ? 0 : listener.port, exclusive: true },
          resolve,
        )
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new ManagedServiceError('UNAVAILABLE')
      listeners[listener.name] = { host: '127.0.0.1', port: address.port }
    }
    return listeners
  } finally {
    await Promise.all(
      reservations.map(
        (s) =>
          new Promise<void>((resolve) => {
            if (!s.listening) resolve()
            else s.close(() => resolve())
          }),
      ),
    )
  }
}
