import { PassThrough } from 'node:stream'
import type { JsonRpcMessage } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { runAcp } from '../src/modes/acp.js'
import { FrameTooLarge, pump, splitLines } from '../src/modes/jsonl.js'
import type { CliRpcEndpoint } from '../src/types.js'
import { type FakeEndpoint, scriptedEndpoint } from './fake-endpoint.js'

const collect = (stream: PassThrough): { text(): string } => {
  let value = ''
  stream.on('data', (chunk) => {
    value += String(chunk)
  })
  return { text: () => value }
}

/** handle() for each gated method stays pending until release(method). */
const gatedEndpoint = (gated: string[]) => {
  const started: string[] = []
  const waiting = new Map<string, () => void>()
  let closed = false
  const endpoint: CliRpcEndpoint = {
    async handle(message) {
      const { id, method } = message as { id?: number; method?: string }
      started.push(method ?? 'response')
      if (method && gated.includes(method)) await new Promise<void>((resolve) => waiting.set(method, resolve))
      return id === undefined ? undefined : ({ jsonrpc: '2.0', id, result: {} } as JsonRpcMessage)
    },
    notifications: (async function* () {})(),
    async close() {
      closed = true
    },
  }
  return { endpoint, started, release: (method: string) => waiting.get(method)?.(), closed: () => closed }
}

const frame = (id: number, method: string): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })}\n`
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('JSONL ACP mode', () => {
  it('frames split chunks, CRLF, and the byte ceiling', () => {
    const split = splitLines()
    expect(split(Buffer.from('{"a":1}\n{"b"'))).toEqual(['{"a":1}'])
    expect(split(Buffer.from(':2}\r\n'))).toEqual(['{"b":2}'])
    expect(() => splitLines()(Buffer.alloc(16 * 1024 * 1024 + 1, 0x61))).toThrow(FrameTooLarge)
  })

  it('orders initialize, session/new, and prompt received in one chunk', async () => {
    const endpoint = scriptedEndpoint({ reply: 'acp answer' })
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const output = collect(stdout)
    const running = pump({ endpoint, stdin, stdout, stderr: new PassThrough() })
    for (const message of [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      },
      { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: {
          sessionId: 'agnes:local:default:cli:dm:main',
          prompt: [{ type: 'text', text: 'hi' }],
        },
      },
    ])
      stdin.write(`${JSON.stringify(message)}\n`)
    stdin.end()
    await running

    const messages = output
      .text()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id?: number; method?: string; result?: unknown })
    expect(endpoint.calls.slice(0, 3).map(({ method }) => method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ])
    expect(messages.find(({ id }) => id === 1)?.result).toMatchObject({ protocolVersion: 1 })
    expect(messages.find(({ id }) => id === 3)?.result).toMatchObject({ stopReason: 'end_turn' })
    expect(messages.some(({ method }) => method === '_agnes/v1/session.event')).toBe(true)
  })

  it('starts a frame only after the request before it settles, so session/new cannot overtake initialize', async () => {
    const e = gatedEndpoint(['initialize', 'session/new'])
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    stdout.resume()
    const running = pump({ endpoint: e.endpoint, stdin, stdout, stderr: new PassThrough() })

    stdin.write(frame(1, 'initialize') + frame(2, 'session/new') + frame(3, 'session/load'))
    await settle()
    expect(e.started).toEqual(['initialize'])
    e.release('initialize')
    await settle()
    expect(e.started).toEqual(['initialize', 'session/new'])
    e.release('session/new')
    stdin.end()
    await running
    expect(e.started).toEqual(['initialize', 'session/new', 'session/load'])
  })

  it('cancellation does not start frames still waiting behind an unsettled request', async () => {
    const e = gatedEndpoint(['initialize'])
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    stdout.resume()
    const abort = new AbortController()
    const running = pump({
      endpoint: e.endpoint,
      stdin,
      stdout,
      stderr: new PassThrough(),
      signal: abort.signal,
    })

    stdin.write(frame(1, 'initialize') + frame(2, 'session/new'))
    await settle()
    abort.abort(new Error('test cancellation'))
    e.release('initialize')
    await running
    expect(e.started).toEqual(['initialize'])
    expect(e.closed()).toBe(true)
    stdin.destroy()
  })

  it('emits parse/frame errors and closes on EOF', async () => {
    const malformed = scriptedEndpoint()
    const malformedIn = new PassThrough()
    const malformedOut = new PassThrough()
    const malformedText = collect(malformedOut)
    const malformedRun = pump({
      endpoint: malformed,
      stdin: malformedIn,
      stdout: malformedOut,
      stderr: new PassThrough(),
    })
    malformedIn.end('{nope}\n')
    await malformedRun
    expect(JSON.parse(malformedText.text()).error.code).toBe(-32700)
    expect(malformed.closed).toBe(true)

    const oversized = scriptedEndpoint()
    const oversizedIn = new PassThrough()
    const oversizedOut = new PassThrough()
    const oversizedText = collect(oversizedOut)
    const oversizedRun = pump({
      endpoint: oversized,
      stdin: oversizedIn,
      stdout: oversizedOut,
      stderr: new PassThrough(),
    })
    oversizedIn.end(Buffer.alloc(16 * 1024 * 1024 + 1, 0x61))
    await oversizedRun
    expect(JSON.parse(oversizedText.text()).error.code).toBe(-32600)
    expect(oversized.closed).toBe(true)
  })

  it.each(['null', '[]', '1', '"text"'])('rejects non-request JSON %s as -32600', async (wire) => {
    const endpoint = scriptedEndpoint()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const output = collect(stdout)
    const running = pump({ endpoint, stdin, stdout, stderr: new PassThrough() })

    stdin.end(`${wire}\n`)
    await running

    expect(JSON.parse(output.text()).error.code).toBe(-32600)
    expect(endpoint.calls).toEqual([])
    expect(endpoint.closed).toBe(true)
  })

  it('cancels a blocked stdout drain and still closes the endpoint', async () => {
    const endpoint = scriptedEndpoint()
    const stdin = new PassThrough()
    // No reader is attached and one byte fills the buffer, so the first protocol error blocks on
    // drain until cancellation. This is the same failure mode as a client that stops reading.
    const stdout = new PassThrough({ highWaterMark: 1 })
    const abort = new AbortController()
    const running = pump({
      endpoint,
      stdin,
      stdout,
      stderr: new PassThrough(),
      signal: abort.signal,
    })

    stdin.write('null\n')
    abort.abort(new Error('test cancellation'))

    await expect(running).resolves.toBeUndefined()
    expect(endpoint.closed).toBe(true)
    stdin.destroy()
    stdout.destroy()
  })

  it('runAcp owns and closes the local endpoint', async () => {
    const endpoint: FakeEndpoint = scriptedEndpoint()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    stdout.resume()
    const running = runAcp(
      {
        client: undefined as never,
        endpoint,
        profileName: 'local-dev',
        resolvedProfileHash: 'hash',
        bootMs: 1,
        form: 'local',
        close: async () => undefined,
      },
      parseArgs(['--mode', 'acp']),
      { stdin, stdout, stderr: new PassThrough() },
    )
    stdin.end()
    await expect(running).resolves.toBe(0)
    expect(endpoint.closed).toBe(true)
  })

  it('cancellation closes an ACP run whose stdin remains open', async () => {
    const endpoint = scriptedEndpoint()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    stdout.resume()
    let cancel: (() => Promise<void>) | undefined
    const running = runAcp(
      {
        client: undefined as never,
        endpoint,
        profileName: 'local-dev',
        resolvedProfileHash: 'hash',
        bootMs: 1,
        form: 'local',
        close: async () => undefined,
      },
      parseArgs(['--mode', 'acp']),
      {
        stdin,
        stdout,
        stderr: new PassThrough(),
        registerCancel: (registered) => {
          cancel = registered
        },
      },
    )
    await cancel?.()
    await expect(running).resolves.toBe(0)
    expect(endpoint.closed).toBe(true)
    stdin.destroy()
  })
})
