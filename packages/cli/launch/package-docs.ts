import { randomUUID } from 'node:crypto'
import { PACKAGE_DOCS_FEATURE, type PackageDocsGetParams, type PackageDocsGetResult } from '@agnes/protocol'
import type { Client } from '@agnes/sdk'

export function createPackageDocsBridge(open: () => Client) {
  let current: { owner: Client; epoch: string; lifetime: AbortController } | undefined
  let unsubscribe: (() => void) | undefined

  const rotate = (owner: Client) => {
    current?.lifetime.abort()
    current = { owner, epoch: randomUUID(), lifetime: new AbortController() }
  }
  const isCurrent = (epoch: string): boolean =>
    current?.epoch === epoch && current.owner.connectionState === 'connected' && !current.owner.isClosed

  return {
    bind(owner: Client): Client {
      unsubscribe?.()
      rotate(owner)
      unsubscribe = owner.on('connectionStateChanged', (state) => {
        if (state === 'reconnecting' || state === 'closed') rotate(owner)
      })
      return owner
    },
    close(): void {
      unsubscribe?.()
      current?.lifetime.abort()
      current = undefined
    },
    docs: {
      async epoch(): Promise<string | undefined> {
        const binding = current
        if (!binding) return undefined
        const { features } = await binding.owner.initialize()
        return isCurrent(binding.epoch) && features?.includes(PACKAGE_DOCS_FEATURE)
          ? binding.epoch
          : undefined
      },
      isCurrent,
      async get(
        params: PackageDocsGetParams,
        epoch: string,
        httpSignal: AbortSignal,
      ): Promise<PackageDocsGetResult | undefined> {
        const binding = current
        if (!binding || !isCurrent(epoch)) return undefined
        const signal = AbortSignal.any([httpSignal, binding.lifetime.signal])
        const { features } = await binding.owner.initialize()
        if (signal.aborted || !isCurrent(epoch) || !features?.includes(PACKAGE_DOCS_FEATURE)) return undefined

        // SDK request cancellation only stops the local wait. A dedicated Unix exchange also
        // stops the daemon's read when the tab disconnects without closing the shared admin client.
        const exchange = open()
        const stop = () => void exchange.close().catch(() => undefined)
        const stopOnDisconnect = exchange.on('connectionStateChanged', (state) => {
          if (state === 'reconnecting') stop()
        })
        signal.addEventListener('abort', stop, { once: true })
        try {
          signal.throwIfAborted()
          const { features } = await exchange.initialize()
          if (signal.aborted || !isCurrent(epoch) || !features?.includes(PACKAGE_DOCS_FEATURE))
            return undefined
          const result = await exchange.request('_agnes/v1/packages.docs.get', params, { signal })
          if (
            signal.aborted ||
            !isCurrent(epoch) ||
            exchange.connectionState !== 'connected' ||
            exchange.isClosed
          )
            return undefined
          return result
        } finally {
          signal.removeEventListener('abort', stop)
          stopOnDisconnect()
          await exchange.close().catch(() => undefined)
        }
      },
    },
  }
}
