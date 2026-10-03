import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import type { CallContext } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import type { McpSession } from './mcp-leases.js'
import { type McpDependencies, type McpEndpoint, McpFault, mcpData } from './mcp-types.js'

const LIMIT = 1024 * 1024
function decoded(raw: unknown, id: number): W.JsonValue {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new McpFault('unknown_effect', 'mcp_protocol')
  const reply = raw as Record<string, unknown>
  if (reply.jsonrpc !== '2.0' || reply.id !== id || 'error' in reply || !('result' in reply))
    throw new McpFault('unknown_effect', 'mcp_protocol')
  const checked = validateRuntime('DataRef', { ...mcpData(null, 'agh.mcp/rpc@1'), value: reply.result })
  if (!checked.ok || checked.value.kind !== 'inline') throw new McpFault('unknown_effect', 'mcp_protocol')
  return checked.value.value
}
export async function openMcpSession(
  endpoint: McpEndpoint,
  handle: W.SecretHandle | null,
  deps: McpDependencies,
  context: CallContext,
): Promise<McpSession> {
  const lifetime = new AbortController()
  let sequence = 0
  let live = true
  if (endpoint.transport === 'streamable-http') {
    const destination = endpoint.target
    if (!destination) throw new McpFault('invalid_input', 'mcp_endpoint')
    return {
      get alive() {
        return live
      },
      async request(method, params, call) {
        if (!live) throw new McpFault('unknown_effect', 'mcp_disconnected')
        const remaining = Math.min(Date.parse(call.deadline) - Date.now(), deps.timeoutMs ?? 10000)
        if (call.signal.aborted || !Number.isFinite(remaining) || remaining <= 0)
          throw new McpFault('cancelled', 'mcp_cancelled')
        const id = ++sequence
        const notification = method === 'notifications/initialized'
        const payload = Buffer.from(
          JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
        )
        if (payload.length > LIMIT) throw new McpFault('invalid_input', 'mcp_request_limit')
        const signal = AbortSignal.any([call.signal, lifetime.signal, AbortSignal.timeout(remaining)])
        const bodyRef = await deps.content.retain(payload, call)
        let result: W.JsonValue = null
        let wireFailure: unknown
        const exchange = async (secret: string, brokerSignal: AbortSignal = signal) => {
          signal.throwIfAborted()
          const response = await deps.network.request(
            {
              target: destination,
              method: 'POST',
              bodyRef,
              redirect: { mode: 'deny', maxHops: 0 },
              maxBytes: LIMIT,
              headers: mcpData(
                {
                  'content-type': 'application/json',
                  accept: 'application/json',
                  'mcp-protocol-version': '2025-03-26',
                  ...(secret ? { authorization: `Bearer ${secret}` } : {}),
                },
                'agh.network/request-headers@1',
              ),
            },
            call,
            AbortSignal.any([signal, brokerSignal]),
          )
          if (!response.ok) throw new McpFault(response.error.code, response.error.detailCode)
          if (response.value.status === 401) throw new McpFault('denied', 'credential_refresh_required')
          if (notification && response.value.status === 202) return
          if (response.value.status !== 200) throw new McpFault('unknown_effect', 'mcp_http_status')
          const bytes = await deps.content.read(response.value.bodyRef, call)
          if (bytes.length > LIMIT) throw new McpFault('unknown_effect', 'mcp_response_limit')
          result = decoded(JSON.parse(Buffer.from(bytes).toString('utf8')), id)
        }
        if (endpoint.credential) {
          if (!handle) throw new McpFault('denied', 'mcp_credential')
          const used = await deps.secrets.use(
            handle,
            endpoint.credential,
            call,
            async (secret, brokerSignal) => {
              try {
                await exchange(secret, brokerSignal)
              } catch (error) {
                wireFailure = error
              }
            },
          )
          if (!used.ok) throw new McpFault(used.error.code, used.error.detailCode)
          if (wireFailure) throw wireFailure
        } else await exchange('')
        return result
      },
      async close() {
        live = false
        lifetime.abort()
      },
    }
  }
  const executable = endpoint.executable
  if (!executable || !isAbsolute(executable) || !deps.allowedExecutables.includes(executable))
    throw new McpFault('denied', 'mcp_executable')
  if (endpoint.credential) throw new McpFault('incompatible', 'mcp_stdio_credential_mapping')
  // No inherited environment. Secrets remain inside the broker's trusted executor boundary.
  if (context.signal.aborted) throw new McpFault('cancelled', 'mcp_cancelled')
  const child = spawn(executable, [...(endpoint.args ?? [])], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] })
  if (!child?.stdout || !child.stdin) throw new McpFault('denied', 'mcp_spawn')
  const process = child
  const pending = new Map<number, { resolve(value: W.JsonValue): void; reject(error: unknown): void }>()
  const lost = () => {
    live = false
    for (const waiter of pending.values()) waiter.reject(new McpFault('unknown_effect', 'mcp_disconnected'))
    pending.clear()
  }
  process.once('error', lost)
  process.once('exit', lost)
  process.stdin?.on('error', lost)
  let buffered = 0
  process.stdout?.on('data', (chunk: Buffer) => {
    for (const byte of chunk) {
      buffered = byte === 10 ? 0 : buffered + 1
      if (buffered > LIMIT) {
        lost()
        process.kill()
        return
      }
    }
  })
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
  reader.on('line', (line) => {
    try {
      if (Buffer.byteLength(line) > LIMIT) throw new Error('frame limit')
      const message: unknown = JSON.parse(line)
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('frame')
      const id = (message as Record<string, unknown>).id
      if ('method' in message && (typeof id === 'number' || typeof id === 'string')) {
        process.stdin?.write(
          `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported request' } })}\n`,
        )
        return
      }
      if (typeof id !== 'number') return
      const waiter = pending.get(id)
      if (waiter) waiter.resolve(decoded(message, id))
    } catch {
      lost()
      process.kill()
    }
  })
  let closing: Promise<void> | undefined
  return {
    get alive() {
      return live
    },
    request(method, params, call) {
      if (!live) return Promise.reject(new McpFault('unknown_effect', 'mcp_disconnected'))
      const remaining = Math.min(Date.parse(call.deadline) - Date.now(), deps.timeoutMs ?? 10000)
      if (!Number.isFinite(remaining) || remaining <= 0)
        return Promise.reject(new McpFault('cancelled', 'mcp_cancelled'))
      const notification = method === 'notifications/initialized'
      const id = ++sequence
      const signal = AbortSignal.any([call.signal, lifetime.signal, AbortSignal.timeout(remaining)])
      if (signal.aborted) return Promise.reject(new McpFault('cancelled', 'mcp_cancelled'))
      const frame = `${JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params })}\n`
      if (Buffer.byteLength(frame) > LIMIT)
        return Promise.reject(new McpFault('invalid_input', 'mcp_request_limit'))
      if (notification) {
        process.stdin?.write(frame)
        return Promise.resolve(null)
      }
      return new Promise<W.JsonValue>((resolve, reject) => {
        const abort = () => {
          pending.delete(id)
          reject(new McpFault('unknown_effect', 'mcp_interrupted'))
        }
        const cleanup = () => {
          pending.delete(id)
          signal.removeEventListener('abort', abort)
        }
        pending.set(id, {
          resolve(value) {
            cleanup()
            resolve(value)
          },
          reject(error) {
            cleanup()
            reject(error)
          },
        })
        signal.addEventListener('abort', abort, { once: true })
        process.stdin?.write(frame, (error) => {
          if (error) pending.get(id)?.reject(new McpFault('unknown_effect', 'mcp_disconnected'))
        })
      })
    },
    close() {
      if (!closing)
        closing = new Promise<void>((resolve) => {
          lifetime.abort()
          lost()
          reader.close()
          if (process.exitCode !== null || process.signalCode !== null) {
            resolve()
            return
          }
          const timer = setTimeout(() => process.kill('SIGKILL'), 500)
          process.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
          process.kill('SIGTERM')
        })
      return closing
    },
  }
}
