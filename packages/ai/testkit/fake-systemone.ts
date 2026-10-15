// A loopback stand-in for TypeSafe System One's POST <base>/systemone. Each request is given a
// behaviour by the test's script; by default it answers every question with a well-formed answer.
// It never leaves the machine: the server binds 127.0.0.1 and the tests point a route at its `url`.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

/** The price the service charges per input token, in dollars per million. Output is free. */
const INPUT_PRICE_PER_MILLION = 0.042

export type FakeSystemOneBehaviour = {
  /** Wait this long before answering. */
  delayMs?: number
  /** Never answer; the socket stays open until the client gives up or the server closes. */
  hang?: boolean
  /** Destroy the socket as soon as the request arrives, without answering. */
  drop?: boolean
  status?: number
  headers?: Record<string, string>
  /** Replaces the whole body. A string is sent as it is, anything else as JSON. */
  body?: unknown
  /** Merged over the generated answers (to produce odd or incomplete ones). */
  answers?: Record<string, unknown>
  model?: string
  /** `cost` defaults to the input tokens times the price; pass `cost: undefined` to leave it out. */
  usage?: { input_tokens: number; output_tokens: number; cost?: number | undefined }
  /** Answer 200, then keep writing a body that never ends, one byte this often. */
  dripMs?: number
  /** Answer 200 with a body of this many bytes, written without a declared length. */
  streamBytes?: number
  /** Write the start of a body, then destroy the socket. */
  cutAfterWrite?: boolean
}

export type FakeSystemOneSeen = {
  n: number
  method: string
  path: string
  authorization: string | undefined
  body: unknown
  at: number
  /** Which accepted connection carried the request, counting from 1. */
  socket: number
}

export type FakeSystemOneScript =
  | FakeSystemOneBehaviour
  | ((n: number, seen: FakeSystemOneSeen) => FakeSystemOneBehaviour)

/** Error bodies in the shape the service has been observed to return, with a placeholder account id. */
export const SYSTEMONE_ERROR_BODIES = {
  overflow: JSON.stringify({
    error: {
      message: 'HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}',
      code: 400,
      metadata: { user_id: 'user_fake_000' },
    },
  }),
  validation: JSON.stringify({
    error: {
      message: '[{"type":"missing","loc":["body","questions"],"msg":"Field required"}]',
      code: 400,
      metadata: { user_id: 'user_fake_000' },
    },
  }),
  noModel: JSON.stringify({
    error: {
      message: 'Model typesafe/jev-9.99 does not exist',
      code: 400,
      metadata: { user_id: 'user_fake_000' },
    },
  }),
  auth: JSON.stringify({ error: { message: 'User not found.', code: 401 } }),
} as const

type Question = { type?: unknown; criteria?: unknown }

/** A well-formed answer for each question the request asked. */
export function answersFor(questions: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(questions)) {
    const q = (entry ?? {}) as Question
    if (q.type === 'noul') out[id] = { type: 'noul', noul: 0.12 }
    else if (q.type === 'choice') {
      const options = Object.keys((q.criteria ?? {}) as Record<string, unknown>)
      out[id] = {
        type: 'choice',
        choice: options[0],
        probabilities: Object.fromEntries(
          options.map((o, i) => [o, i === 0 ? 0.7 : 0.3 / Math.max(1, options.length - 1)]),
        ),
        confidence: 0.83,
      }
    } else {
      const criteria = (Array.isArray(q.criteria) ? q.criteria : []) as string[]
      const levels = criteria.map((_, i) => String(i))
      out[id] = {
        type: 'score',
        score: 1,
        legend: Object.fromEntries(levels.map((l, i) => [l, criteria[i]])),
        probabilities: Object.fromEntries(levels.map((l) => [l, 1 / Math.max(1, levels.length)])),
        confidence: 0.6,
      }
    }
  }
  return out
}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export type FakeSystemOneOptions = {
  /**
   * How long the server keeps an idle connection before closing it, and the `Keep-Alive: timeout`
   * hint it sends (Node's default is 5 s). 0 keeps idle connections until the test closes them and
   * sends no hint, so the only idle limit left is the client's own.
   */
  keepAliveTimeoutMs?: number
}

export async function startFakeSystemOne(
  script: FakeSystemOneScript = {},
  options: FakeSystemOneOptions = {},
) {
  const seen: FakeSystemOneSeen[] = []
  const sockets = new Set<Socket>()
  const socketIds = new WeakMap<Socket, number>()
  const pending = new Set<ServerResponse>()
  let accepts = 0
  const behave = typeof script === 'function' ? script : () => script

  const respond = (res: ServerResponse, b: FakeSystemOneBehaviour, req: FakeSystemOneSeen) => {
    const id = `gen-${req.n + 1}`
    const headers = { 'content-type': 'application/json', 'x-generation-id': id, ...b.headers }
    if (b.dripMs !== undefined) {
      res.writeHead(200, headers)
      res.write('{')
      const timer = setInterval(() => res.write(' '), b.dripMs)
      res.on('close', () => clearInterval(timer))
      return
    }
    if (b.streamBytes !== undefined) {
      res.writeHead(200, headers)
      const chunk = Buffer.alloc(64 * 1024, 0x20)
      for (let sent = 0; sent < b.streamBytes && !res.destroyed; sent += chunk.length) res.write(chunk)
      res.end()
      return
    }
    if (b.cutAfterWrite) {
      res.writeHead(b.status ?? 200, { 'content-length': '1000', ...headers })
      res.write('{"model"')
      setTimeout(() => res.socket?.destroy(), 20)
      return
    }
    const input = b.usage ?? { input_tokens: 180, output_tokens: 9 }
    const usage =
      'cost' in input ? input : { ...input, cost: (input.input_tokens * INPUT_PRICE_PER_MILLION) / 1e6 }
    const questions = (req.body as { questions?: Record<string, unknown> } | null)?.questions ?? {}
    const payload =
      b.body ??
      ({
        id,
        model: b.model ?? (req.body as { model?: string } | null)?.model ?? 'jev-1',
        answers: { ...answersFor(questions), ...(b.answers ?? {}) },
        usage,
      } as const)
    res.writeHead(b.status ?? 200, headers)
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const text = await readText(req)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const entry: FakeSystemOneSeen = {
      n: seen.length,
      method: req.method ?? '',
      path,
      authorization: req.headers.authorization,
      body,
      at: Date.now(),
      socket: socketIds.get(req.socket) ?? -1,
    }
    seen.push(entry)
    if (req.method !== 'POST' || !path.endsWith('/systemone')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"detail":"Not Found"}')
      return
    }
    const behaviour = behave(entry.n, entry)
    if (behaviour.drop) {
      req.socket.destroy()
      return
    }
    if (behaviour.hang) {
      pending.add(res)
      res.on('close', () => pending.delete(res))
      return
    }
    if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs))
    respond(res, behaviour, entry)
  })
  if (options.keepAliveTimeoutMs !== undefined) server.keepAliveTimeout = options.keepAliveTimeoutMs
  server.on('connection', (socket: Socket) => {
    accepts++
    socketIds.set(socket, accepts)
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    /** The route's base URL; the adapter appends /systemone. */
    url: `http://127.0.0.1:${port}/v1`,
    seen,
    /** TCP connections accepted so far. */
    accepts: () => accepts,
    /** Connections currently open on the server side. */
    openSockets: () => sockets.size,
    /** Close every idle kept-alive connection, as a server's idle timeout would. */
    dropIdle: () => server.closeIdleConnections(),
    /** Answer every hung request now, with an empty answer set. */
    release() {
      for (const res of pending) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: 'jev-1', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }))
      }
      pending.clear()
    },
    async close() {
      for (const res of pending) res.destroy()
      pending.clear()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

export type FakeSystemOne = Awaited<ReturnType<typeof startFakeSystemOne>>
