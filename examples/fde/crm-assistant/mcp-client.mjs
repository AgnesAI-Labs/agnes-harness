import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const PROTOCOL_VERSION = '2025-06-18'
const TIMEOUT_MS = 5000

/**
 * An ordinary trusted connector. It owns its stdio process and closes it on plugin unload.
 *
 * It speaks MCP's newline-delimited JSON-RPC over stdio directly, so the installed package needs
 * no third-party module: an installed plugin resolves only its own files and the modules AGH
 * provides.
 */
export function fixtureConnector(serverUrl) {
  let connection
  let closed = false
  async function open() {
    if (closed) throw new Error('MCP fixture connector is disposed')
    connection ??= connect(fileURLToPath(serverUrl)).catch((error) => {
      connection = undefined
      throw error
    })
    const client = await connection
    if (closed) {
      client.close()
      throw new Error('MCP fixture connector is disposed')
    }
    return client
  }
  return {
    async call(name, args, signal) {
      signal.throwIfAborted()
      const client = await open()
      signal.throwIfAborted()
      return client.request('tools/call', { name, arguments: args }, signal)
    },
    async close() {
      closed = true
      const client = await connection?.catch(() => undefined)
      client?.close()
    },
  }
}

async function connect(serverPath) {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  const pending = new Map()
  let nextId = 0
  let exited = false
  const failAll = (error) => {
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }
  child.on('error', (error) => failAll(error))
  child.on('exit', () => {
    exited = true
    failAll(new Error('MCP fixture server exited'))
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(String(message.error.message ?? 'MCP request failed')))
    else waiter.resolve(message.result)
  })
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const client = {
    request(method, params, signal) {
      if (exited) return Promise.reject(new Error('MCP fixture server exited'))
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const settle = (fn) => (value) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          pending.delete(id)
          fn(value)
        }
        const onAbort = () => settle(reject)(signal.reason)
        const timer = setTimeout(() => settle(reject)(new Error(`MCP ${method} timed out`)), TIMEOUT_MS)
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, { resolve: settle(resolve), reject: settle(reject) })
        send({ jsonrpc: '2.0', id, method, params })
      })
    },
    close() {
      failAll(new Error('MCP fixture connector is disposed'))
      child.stdin.end()
      if (!exited) child.kill()
    },
  }
  try {
    await client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'fde-fixture-client', version: '1.0.0' },
    })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return client
  } catch (error) {
    client.close()
    throw error
  }
}
