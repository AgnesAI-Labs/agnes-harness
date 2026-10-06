import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttp2Server } from 'node:http2'
import { afterEach, describe, expect, it } from 'vitest'
import { createJevDecisionFetch } from '../src/runtime/jev-fetch.js'
import { createJevDecisionTransport } from '../src/runtime/jev-transport.js'

type Respond = 'ok' | 'error' | 'silent'

/** A local System One echo server with a mutable per-request behaviour and connection counters. */
interface EchoServer {
  url: string
  /** TCP connections accepted so far. */
  connections(): number
  /** TCP connections currently open. */
  openConnections(): number
  requests(): number
  setRespond(mode: Respond): void
  close(): Promise<void>
}

const BODY = '{"model":"jev","answers":{},"usage":{"input_tokens":1}}'

async function echoServer(initial: Respond = 'ok'): Promise<EchoServer> {
  let mode: Respond = initial
  let connections = 0
  let open = 0
  let requests = 0
  const server: Server = createHttpServer((request, response) => {
    requests++
    request.resume()
    if (mode === 'silent') return
    if (mode === 'error') {
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(BODY)
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(BODY)
  })
  server.on('connection', (socket) => {
    connections++
    open++
    socket.on('close', () => {
      open--
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`
  return {
    url,
    connections: () => connections,
    openConnections: () => open,
    requests: () => requests,
    setRespond: (next) => {
      mode = next
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

const post = (): Parameters<typeof fetch>[1] => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"model":"jev","state":{},"questions":{}}',
})

const opened: EchoServer[] = []
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close()
})

const open = async (initial: Respond = 'ok'): Promise<EchoServer> => {
  const server = await echoServer(initial)
  opened.push(server)
  return server
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * undici marks a client free only a tick after its response completes, so two requests issued
 * back-to-back race the pool and open a second connection. Real decision calls are always
 * separated by language generation or tool execution; a short pause reproduces that cadence.
 */
const decisionPause = (): Promise<void> => sleep(25)

describe('createJevDecisionFetch', () => {
  it('reuses one pooled connection across decision calls', async () => {
    const server = await open()
    const connections = createJevDecisionFetch()
    for (let i = 0; i < 3; i++) {
      const response = await connections.fetch(server.url, post())
      expect(response.status).toBe(200)
      await decisionPause()
    }
    expect(server.connections()).toBe(1)
    expect(connections.generations()).toBe(1)
    await connections.close()
  })

  it('answers over HTTP/1.1 regardless of the HTTP/2 preference', async () => {
    for (const http2 of [true, false]) {
      const server = await open()
      const connections = createJevDecisionFetch({ http2 })
      const response = await connections.fetch(server.url, post())
      expect(response.status).toBe(200)
      await connections.close()
    }
  })

  it('speaks prior-knowledge HTTP/2 to a cleartext HTTP/2 endpoint', async () => {
    let sawHttp2 = false
    const sessions: { destroy(): void }[] = []
    const server = createHttp2Server((request, response) => {
      sawHttp2 = request.httpVersion === '2.0'
      response.writeHead(200, { 'content-type': 'application/json' }).end(BODY)
    })
    server.on('session', (session) => sessions.push(session))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`
    try {
      const connections = createJevDecisionFetch({ http2: true, h2c: true })
      const response = await connections.fetch(url, post())
      expect(response.status).toBe(200)
      expect(sawHttp2).toBe(true)
      await connections.close()
    } finally {
      for (const session of sessions) session.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('replaces the pool after consecutive unanswered calls and recovers on a fresh one', async () => {
    const server = await open('silent')
    const connections = createJevDecisionFetch({ headersTimeoutMs: 150 })
    await expect(connections.fetch(server.url, post())).rejects.toThrow()
    await expect(connections.fetch(server.url, post())).rejects.toThrow()
    expect(server.requests()).toBe(2)
    expect(connections.generations()).toBe(2)
    server.setRespond('ok')
    const response = await connections.fetch(server.url, post())
    expect(response.status).toBe(200)
    expect(server.requests()).toBe(3)
    await connections.close()
  })

  it('counts an answered HTTP error status as a working connection', async () => {
    const server = await open('error')
    const connections = createJevDecisionFetch({ headersTimeoutMs: 150 })
    const answered = await connections.fetch(server.url, post())
    expect(answered.status).toBe(503)
    server.setRespond('silent')
    await expect(connections.fetch(server.url, post())).rejects.toThrow()
    expect(connections.generations()).toBe(1)
    server.setRespond('ok')
    const recovered = await connections.fetch(server.url, post())
    expect(recovered.status).toBe(200)
    expect(connections.generations()).toBe(1)
    await connections.close()
  })

  it('closes pooled connections with the handle', async () => {
    const server = await open()
    const connections = createJevDecisionFetch()
    await connections.fetch(server.url, post())
    expect(server.openConnections()).toBe(1)
    await connections.close()
    await expect(connections.fetch(server.url, post())).rejects.toThrow()
    for (let i = 0; i < 40 && server.openConnections() > 0; i++) await sleep(50)
    expect(server.openConnections()).toBe(0)
  })

  it('composes with the decision transport over one pooled connection', async () => {
    const server = await open()
    const connections = createJevDecisionFetch()
    const transport = createJevDecisionTransport({ endpoint: server.url, fetcher: connections.fetch })
    for (let i = 0; i < 2; i++) {
      const settlement = await transport.invoke(
        { model: 'jev', state: {}, questions: {} },
        new AbortController().signal,
      )
      expect(settlement.output).toBeDefined()
      expect(settlement.error).toBeUndefined()
      await decisionPause()
    }
    expect(server.connections()).toBe(1)
    await connections.close()
  })
})
