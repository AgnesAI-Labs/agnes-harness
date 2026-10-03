import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import type { CallContext } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { validateRuntime } from '@agnes/protocol/runtime'
import {
  type ReferenceMcpEndpoint,
  ReferenceMcpError,
  type ReferenceMcpOptions,
  referenceData,
} from './mcp-support.js'

export interface ReferenceWire {
  readonly usable: boolean
  exchange(method: string, argument: Wire.JsonValue, call: CallContext): Promise<Wire.JsonValue>
  stop(): Promise<void>
}
function unpack(value: unknown, wanted: number): Wire.JsonValue {
  const envelope =
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  if (
    !envelope ||
    envelope.id !== wanted ||
    envelope.jsonrpc !== '2.0' ||
    envelope.error ||
    !Object.hasOwn(envelope, 'result')
  )
    throw new ReferenceMcpError('unknown_effect', 'mcp_protocol')
  const wrapped = validateRuntime('DataRef', { ...referenceData(null), value: envelope.result })
  if (!wrapped.ok || wrapped.value.kind !== 'inline')
    throw new ReferenceMcpError('unknown_effect', 'mcp_protocol')
  return wrapped.value.value
}
export async function referenceWire(
  config: ReferenceMcpEndpoint,
  locator: Wire.SecretHandle | null,
  settings: ReferenceMcpOptions,
  initial: CallContext,
): Promise<ReferenceWire> {
  let usable = true
  let counter = 0
  const disconnected = new AbortController()
  if (config.transport !== 'stdio') {
    if (!config.target) throw new ReferenceMcpError('invalid_input', 'mcp_endpoint')
    const target = config.target
    return {
      get usable() {
        return usable
      },
      async stop() {
        usable = false
        disconnected.abort()
      },
      async exchange(method, argument, call) {
        if (!usable) throw new ReferenceMcpError('unknown_effect', 'mcp_disconnected')
        const remaining = Math.min(Date.parse(call.deadline) - Date.now(), settings.timeoutMs ?? 10000)
        if (call.signal.aborted || !Number.isFinite(remaining) || remaining <= 0)
          throw new ReferenceMcpError('cancelled', 'mcp_cancelled')
        const signal = AbortSignal.any([call.signal, disconnected.signal, AbortSignal.timeout(remaining)])
        const tag = ++counter
        const notice = method.startsWith('notifications/')
        const bytes = Buffer.from(
          JSON.stringify({ jsonrpc: '2.0', method, params: argument, ...(notice ? {} : { id: tag }) }),
        )
        if (bytes.length > 1048576) throw new ReferenceMcpError('invalid_input', 'mcp_request_limit')
        const payload = await settings.content.retain(bytes, call)
        let answer: Wire.JsonValue = null
        let remoteFault: unknown
        const send = async (key: string, consumerSignal: AbortSignal = signal) => {
          signal.throwIfAborted()
          const headers: Record<string, string> = {
            accept: 'application/json',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-03-26',
          }
          if (key) headers.authorization = `Bearer ${key}`
          const outcome = await settings.network.request(
            {
              headers: referenceData(headers, 'agh.network/request-headers@1'),
              target,
              method: 'POST',
              redirect: { maxHops: 0, mode: 'deny' },
              maxBytes: 1048576,
              bodyRef: payload,
            },
            call,
            AbortSignal.any([signal, consumerSignal]),
          )
          if (!outcome.ok) throw new ReferenceMcpError(outcome.error.code, outcome.error.detailCode)
          const reply = outcome.value
          if (reply.status === 401) throw new ReferenceMcpError('denied', 'credential_refresh_required')
          if (notice && reply.status === 202) return
          if (reply.status !== 200) throw new ReferenceMcpError('unknown_effect', 'mcp_http_status')
          const response = await settings.content.read(reply.bodyRef, call)
          if (response.length > 1048576) throw new ReferenceMcpError('unknown_effect', 'mcp_response_limit')
          answer = unpack(JSON.parse(Buffer.from(response).toString('utf8')), tag)
        }
        if (config.credential) {
          if (!locator) throw new ReferenceMcpError('denied', 'mcp_credential')
          const consumed = await settings.secrets.use(
            locator,
            config.credential,
            call,
            async (key, consumerSignal) => {
              try {
                await send(key, consumerSignal)
              } catch (reason) {
                remoteFault = reason
              }
            },
          )
          if (!consumed.ok) throw new ReferenceMcpError(consumed.error.code, consumed.error.detailCode)
          if (remoteFault) throw remoteFault
        } else await send('')
        return answer
      },
    }
  }
  if (
    !config.executable ||
    !isAbsolute(config.executable) ||
    !settings.allowedExecutables.includes(config.executable)
  )
    throw new ReferenceMcpError('denied', 'mcp_executable')
  if (config.credential) throw new ReferenceMcpError('incompatible', 'mcp_stdio_credential_mapping')
  if (initial.signal.aborted) throw new ReferenceMcpError('cancelled', 'mcp_cancelled')
  const child = spawn(config.executable, Array.from(config.args ?? []), {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {},
  })
  const inbox: string[] = []
  let wake: (() => void) | undefined
  let queue = Promise.resolve()
  child.on('error', () => {
    usable = false
    wake?.()
  })
  child.on('exit', () => {
    usable = false
    wake?.()
  })
  child.stdin.on('error', () => {
    usable = false
    wake?.()
  })
  let partial = 0
  child.stdout.on('data', (buffer: Buffer) => {
    let start = 0
    while (start < buffer.length) {
      const end = buffer.indexOf(10, start)
      partial += (end < 0 ? buffer.length : end) - start
      if (partial > 1048576) {
        usable = false
        child.kill()
        wake?.()
        return
      }
      if (end < 0) break
      partial = 0
      start = end + 1
    }
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    if (inbox.length > 32 || Buffer.byteLength(line) > 1048576) {
      usable = false
      child.kill()
    } else inbox.push(line)
    wake?.()
  })
  let stopped: Promise<void> | undefined
  return {
    get usable() {
      return usable
    },
    exchange(method, argument, call) {
      const request = queue.then(async () => {
        if (!usable) throw new ReferenceMcpError('unknown_effect', 'mcp_disconnected')
        const remaining = Math.min(Date.parse(call.deadline) - Date.now(), settings.timeoutMs ?? 10000)
        if (call.signal.aborted || !Number.isFinite(remaining) || remaining <= 0)
          throw new ReferenceMcpError('cancelled', 'mcp_cancelled')
        const tag = ++counter
        const notice = method.startsWith('notifications/')
        const text = `${JSON.stringify({ jsonrpc: '2.0', params: argument, method, ...(notice ? {} : { id: tag }) })}\n`
        if (Buffer.byteLength(text) > 1048576)
          throw new ReferenceMcpError('invalid_input', 'mcp_request_limit')
        child.stdin.write(text)
        if (notice) return null
        const interrupt = AbortSignal.any([call.signal, disconnected.signal, AbortSignal.timeout(remaining)])
        for (;;) {
          while (inbox.length) {
            const raw: unknown = JSON.parse(inbox.shift() ?? '')
            if (!raw || typeof raw !== 'object' || Array.isArray(raw))
              throw new ReferenceMcpError('unknown_effect', 'mcp_protocol')
            const envelope = raw as Record<string, unknown>
            if (envelope.id === tag && !envelope.method) return unpack(raw, tag)
            if (envelope.id !== undefined && envelope.method)
              child.stdin.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: envelope.id, error: { code: -32601, message: 'Unsupported request' } })}\n`,
              )
          }
          if (!usable) throw new ReferenceMcpError('unknown_effect', 'mcp_disconnected')
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              usable = false
              child.kill()
              done()
              reject(new ReferenceMcpError('unknown_effect', 'mcp_interrupted'))
            }
            const done = () => {
              interrupt.removeEventListener('abort', abort)
              wake = undefined
            }
            wake = () => {
              done()
              resolve()
            }
            interrupt.addEventListener('abort', abort, { once: true })
            if (interrupt.aborted) abort()
          })
        }
      })
      queue = request.then(
        () => {},
        () => {},
      )
      return request
    },
    stop() {
      if (!stopped)
        stopped = new Promise<void>((resolve) => {
          usable = false
          disconnected.abort()
          wake?.()
          lines.close()
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve()
            return
          }
          const watchdog = setTimeout(() => child.kill('SIGKILL'), 500)
          child.once('exit', () => {
            clearTimeout(watchdog)
            resolve()
          })
          child.kill()
        })
      return stopped
    },
  }
}
