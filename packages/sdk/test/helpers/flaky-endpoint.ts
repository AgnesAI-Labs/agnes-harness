// A fakeEndpoint that can be told to drop the connection - `drop()` fires the transport's
// onClose the way a real disconnect would, and the next connect() (Reconnector's own retry,
// or a caller's) gets a fresh transport wired to the same underlying endpoint, so state kept
// there (pending commands, session state) survives across the "reconnect" the way a real
// daemon's session table would. Deliberately not `inprocTransport(inner.endpoint)`: that
// pumps `endpoint.notifications`, a single AsyncGenerator that cannot be restarted for a
// second transport, and every reconnect here needs exactly that - a second transport over
// the same endpoint.
import type { RpcEndpoint } from '../../src/transport/inproc.js'
import type { JsonRpcMessage, Transport, TransportFactory } from '../../src/transport/types.js'
import { fakeEndpoint, type Handler } from './fake-endpoint.js'

export function flakyEndpoint(methods: Record<string, Handler>) {
  const inner = fakeEndpoint(methods)
  // The live transport's handlers - reassigned on every successful connect(), and read by
  // drop()/notify() only after that reassignment, never before: doConnect() always closes
  // the outgoing transport (and so releases its own handlers reference) before the factory
  // below hands back a new one, so a close in flight can never fire against the wrong pair.
  let handlers: Parameters<TransportFactory>[0] | null = null
  let connectCount = 0
  const factory: TransportFactory = async (h) => {
    handlers = h
    connectCount++
    let open = true
    const transport: Transport = {
      kind: 'inproc',
      async send(msg: JsonRpcMessage) {
        if (!open) throw new Error('flaky transport closed')
        const reply = await inner.endpoint.handle(msg)
        if (reply) queueMicrotask(() => h.onMessage(reply))
      },
      async close() {
        if (!open) return
        open = false
        h.onClose({ reason: 'closed' })
      },
    }
    return transport
  }
  /** Simulates the connection dying under the client - a drop nobody asked for. */
  const drop = () => handlers?.onClose({ reason: 'eof' })
  /** Injects a server-to-client message (event, notice, permission request) out of band. */
  const notify = (m: JsonRpcMessage) => handlers?.onMessage(m)
  return {
    factory,
    drop,
    notify,
    calls: inner.calls,
    initialize: inner.initialize,
    get connects() {
      return connectCount
    },
  }
}
export type { RpcEndpoint }
