/**
 * Wakes a conversation from background code (hub-api.md section 15.3). Plugins have no in-process way
 * to post into a session, so this speaks to the Agnes daemon's local socket: newline-delimited
 * JSON-RPC, `initialize`, then `_agnes/v1/jobs.enqueue` with a one-shot prompt that steers a running
 * turn or starts a new one when the session is idle.
 */
import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

const TIMEOUT_MS = 5000

/**
 * The daemon's client socket, as recorded under the Agnes data directory (<home>/data/daemon). The
 * recorded path matters: a long data directory moves the socket to a short directory under /tmp.
 */
export function socketPath(home: string): string {
  const daemonDir = join(home, 'data', 'daemon')
  for (const file of ['owner.json', 'discovery.json']) {
    try {
      const found = JSON.parse(readFileSync(join(daemonDir, file), 'utf8')) as { socketPath?: unknown }
      if (typeof found.socketPath === 'string') return found.socketPath
    } catch {
      // Not written yet, or another layout: try the next one.
    }
  }
  return join(daemonDir, 'agnesd.sock')
}

/** Sends JSON-RPC requests in order over one connection and returns their results. */
function rpc(path: string, requests: { method: string; params: unknown }[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    const results: unknown[] = []
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('the Agnes daemon did not answer'))
    }, TIMEOUT_MS)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      socket.end()
      if (error) reject(error)
      else resolve(results)
    }
    const sendNext = () => {
      const request = requests[results.length]
      if (!request) return finish()
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: results.length + 1, ...request })}\n`)
    }
    socket.on('connect', sendNext)
    socket.on('error', (e) => finish(e))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let msg: { id?: unknown; result?: unknown; error?: { message?: string } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id !== results.length + 1) continue // notifications and anything else
        if (msg.error) return finish(new Error(msg.error.message ?? 'daemon error'))
        results.push(msg.result)
        sendNext()
      }
    })
  })
}

let wakes = 0

/** Posts `text` into the session: steered into a running turn, or a new turn when it is idle. */
export async function wake(home: string, session: string, text: string): Promise<void> {
  wakes += 1
  await rpc(socketPath(home), [
    {
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        _meta: { 'ai.agnes.harness': { clientId: 'agnes-hub' } },
      },
    },
    {
      method: '_agnes/v1/jobs.enqueue',
      params: {
        idempotencyKey: `agnes-hub-${process.pid}-${Date.now()}-${wakes}`,
        sessionKey: session,
        payload: { prompt: text, delivery: 'steer' },
        schedule: { kind: 'once' },
        // One attempt: a retried wake would write the same message into the conversation again.
        maxAttempts: 1,
      },
    },
  ])
}
