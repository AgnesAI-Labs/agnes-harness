// A programmable in-process server: every test drives the client against a plain
// object of method handlers instead of a real daemon.
import type { RpcEndpoint } from '../../src/transport/inproc.js'
import type { JsonRpcMessage, JsonRpcRequest } from '../../src/transport/types.js'

export type HandlerContext = { push(m: JsonRpcMessage): void; id: JsonRpcRequest['id'] }
export type Handler = (params: unknown, ctx: HandlerContext) => unknown | Promise<unknown>

export type Call = { method: string; params: unknown }

export type FakeEndpoint = {
  endpoint: RpcEndpoint
  /** Queue a server-to-client message (notification or request) for delivery. */
  push(m: JsonRpcMessage): void
  /** Every message the client sent, in arrival order. Responses show up as `<response:id>`. */
  calls: Call[]
  /** Number of handler invocations that have started but not yet settled. */
  inFlight(): number
  /** A stock `initialize` handler; most suites only care about the other methods. */
  initialize: Handler
}

const stockInitialize: Handler = () => ({
  protocolVersion: 1,
  agentCapabilities: {},
  _meta: { agnes: { agnesVersion: '0.0.0-test' } },
})

export function fakeEndpoint(methods: Record<string, Handler>): FakeEndpoint {
  const queue: JsonRpcMessage[] = []
  let wake: (() => void) | null = null
  let closed = false
  let running = 0
  const calls: Call[] = []
  const push = (m: JsonRpcMessage) => {
    queue.push(m)
    wake?.()
  }

  const endpoint: RpcEndpoint = {
    async handle(msg) {
      if (!('method' in msg)) {
        calls.push({ method: `<response:${String((msg as { id: unknown }).id)}>`, params: msg })
        return undefined
      }
      const req = msg as JsonRpcRequest
      calls.push({ method: req.method, params: req.params })
      const handler =
        methods[req.method] ??
        (req.method === '_agnes/v1/workspace.add'
          ? (params: unknown) => {
              const path = (params as { path: string }).path
              return {
                workspace: {
                  path,
                  name: path.split('/').filter(Boolean).at(-1) ?? path,
                  lastUsedAt: null,
                  sessionCount: 0,
                  available: true,
                },
              }
            }
          : undefined)
      const isNotification = !('id' in req) || req.id === undefined
      if (isNotification) {
        if (handler) {
          running++
          try {
            await handler(req.params, { push, id: -1 })
          } finally {
            running--
          }
        }
        return undefined
      }
      if (!handler)
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32601, message: 'METHOD_NOT_FOUND', data: { code: 'METHOD_NOT_FOUND' } },
        }
      running++
      try {
        return { jsonrpc: '2.0', id: req.id, result: await handler(req.params, { push, id: req.id }) }
      } catch (e) {
        const err = e as { code?: number; message: string; data?: Record<string, unknown> }
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: err.code ?? -32603,
            message: err.message,
            data: { code: String(err.data?.code ?? 'INTERNAL_ERROR'), ...err.data },
          },
        }
      } finally {
        running--
      }
    },
    notifications: (async function* () {
      while (!closed) {
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        await new Promise<void>((r) => {
          wake = r
        })
        wake = null
      }
    })(),
    async close() {
      closed = true
      wake?.()
    },
  }

  return { endpoint, push, calls, inFlight: () => running, initialize: stockInitialize }
}

/** Drains the microtask queue; the notification pump wakes through promises only. */
export async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}
