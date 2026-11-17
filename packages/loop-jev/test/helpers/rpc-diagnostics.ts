import type { TransportFactory } from '@agnes/sdk'

export function rpcDiagnostics(
  factory: TransportFactory,
  report: (failure: unknown) => void,
): TransportFactory {
  return async (handlers) => {
    const pending = new Map<string | number, string>()
    const transport = await factory({
      ...handlers,
      onClose(info) {
        pending.clear()
        handlers.onClose(info)
      },
      onMessage(message) {
        if ('id' in message && !('method' in message)) {
          const method = pending.get(message.id)
          pending.delete(message.id)
          if (method && message.error) {
            // Diagnostics never retain request params, arbitrary error messages or extra data.
            const data: Record<string, string> = {}
            for (const key of ['code', 'reason']) {
              const value = message.error.data?.[key]
              if (
                typeof value === 'string' &&
                (/^[A-Z][A-Z0-9_]{0,95}$/.test(value) ||
                  (key === 'reason' && value === 'clean-home-required'))
              )
                data[key] = value
            }
            report({ method, code: message.error.code, data })
          }
        }
        handlers.onMessage(message)
      },
    })
    return {
      kind: transport.kind,
      async send(message) {
        if ('id' in message && 'method' in message) pending.set(message.id, message.method)
        try {
          await transport.send(message)
        } catch (error) {
          if ('id' in message) pending.delete(message.id)
          throw error
        }
      },
      async close() {
        pending.clear()
        await transport.close()
      },
    }
  }
}
