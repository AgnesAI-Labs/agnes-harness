// The in-process transport: the daemon's RpcEndpoint called directly, with no
// serialisation in between. It is the default path for the TUI and for `-p` - no child
// process, no socket, one request is one function call. The browser build can load this
// file too: it uses nothing but queueMicrotask and async iterators.
import type { JsonRpcMessage, Transport, TransportFactory } from './types.js'

// A structural type rather than an import of @agnes/daemon: the dependency allowlist
// permits sdk -> protocol and nothing else. The implementation is createLocalEndpoint(host)
// in `@agnes/daemon/local`.
export type RpcEndpoint = {
  // A request answers with a response message; a notification, or a response the client
  // sent, answers with nothing.
  // biome-ignore lint/suspicious/noConfusingVoidType: the cross-package contract is copied as written; `| undefined` would make the daemon's own `async handle() { ... }` (inferred as Promise<void>) unassignable, which is a `return undefined` forced on every implementer
  handle(msg: JsonRpcMessage): Promise<JsonRpcMessage | void>
  // The server-to-client direction - session event notifications, permission requests -
  // travels on this iterator, never on handle's return value.
  notifications: AsyncIterable<JsonRpcMessage>
  close(): Promise<void>
}

export function inprocTransport(endpoint: RpcEndpoint): TransportFactory {
  return async (handlers) => {
    // onClose fires exactly once. Three paths reach it - the pump ending, the pump
    // throwing, an explicit close - and whichever arrives first flips `open`, after which
    // the others are silent.
    let open = true
    void (async () => {
      try {
        for await (const m of endpoint.notifications) {
          if (!open) break
          handlers.onMessage(m)
        }
      } catch (error) {
        if (open) {
          open = false
          handlers.onClose({ reason: 'error', error: error as Error })
        }
        return
      }
      if (open) {
        open = false
        handlers.onClose({ reason: 'eof' })
      }
    })()

    const transport: Transport = {
      kind: 'inproc',
      async send(msg) {
        const reply = await endpoint.handle(msg)
        // Delivered on a microtask of its own, never inside the send() frame: the caller
        // (RpcConnection.request) finishes registering the request before the answer to
        // it can arrive, whatever the endpoint does.
        if (reply) queueMicrotask(() => handlers.onMessage(reply))
      },
      async close() {
        // The endpoint is closed whether or not the pump is still running. The daemon
        // side ending the stream first is the normal shutdown order, and an early return
        // here would leave its endpoint - and everything it holds - open for good.
        // Endpoints are expected to tolerate a close they have already had.
        const wasOpen = open
        open = false
        await endpoint.close()
        if (wasOpen) handlers.onClose({ reason: 'closed' })
      },
    }
    return transport
  }
}
