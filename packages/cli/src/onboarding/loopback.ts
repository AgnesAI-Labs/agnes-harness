import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { generateAuthorizationState, type RandomBytesSource } from './pkce.js'

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000
const TOKEN_PARAMETERS = ['access_token', 'id_token', 'refresh_token', 'token'] as const

const SUCCESS_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Agnes</title><p>Authorization complete. Return to Agnes CLI.</p>'
const ERROR_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Agnes</title><p>Authorization failed. Return to Agnes CLI.</p>'
const NOT_FOUND_PAGE = '<!doctype html><meta charset="utf-8"><title>Agnes</title><p>Not found.</p>'

export type LoopbackAuthorizationErrorCode =
  | 'AUTH_EXPIRED'
  | 'AUTH_ABORTED'
  | 'AUTH_CALLBACK_ERROR'
  | 'AUTH_LISTENER_ERROR'

export class LoopbackAuthorizationError extends Error {
  readonly code: LoopbackAuthorizationErrorCode

  constructor(code: LoopbackAuthorizationErrorCode, message: string) {
    super(message)
    this.name = 'LoopbackAuthorizationError'
    this.code = code
  }
}

export interface LoopbackAuthorizationOptions {
  state: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Deterministic injection for tests; production path generation uses Node's CSPRNG. */
  randomBytes?: RandomBytesSource
}

export interface LoopbackAuthorization {
  readonly redirectUri: string
  readonly result: Promise<Readonly<{ code: string }>>
  readonly closed: boolean
  close(): Promise<void>
}

function staticPage(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    connection: 'close',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function exactSecret(received: string, expected: string): boolean {
  // Fixed-size digests avoid leaking the first different byte or the expected value's length.
  const receivedDigest = createHash('sha256').update(received, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(receivedDigest, expectedDigest)
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('listener did not expose an IPv4 address'))
        return
      }
      resolve(address.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true })
  })
}

function stop(server: Server, force: boolean): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => {
    server.close(() => resolve())
    if (force) server.closeAllConnections()
  })
}

function callbackError(): LoopbackAuthorizationError {
  return new LoopbackAuthorizationError('AUTH_CALLBACK_ERROR', 'the authorization callback was rejected')
}

export async function startLoopbackAuthorization(
  options: LoopbackAuthorizationOptions,
): Promise<LoopbackAuthorization> {
  if (options.state.length === 0 || options.state.length > 1_024) {
    throw new Error('authorization state must be between 1 and 1024 characters')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('authorization callback timeout must be a positive integer')
  }
  if (options.signal?.aborted) {
    throw new LoopbackAuthorizationError('AUTH_ABORTED', 'authorization callback was aborted')
  }

  const callbackPath = `/cli/callback/${generateAuthorizationState(options.randomBytes)}`
  let consumed = false
  let settled = false
  let closed = false
  let timer: NodeJS.Timeout | undefined
  let resolveResult!: (result: Readonly<{ code: string }>) => void
  let rejectResult!: (error: LoopbackAuthorizationError) => void
  const result = new Promise<Readonly<{ code: string }>>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // close() is valid before a consumer starts awaiting result; keep that rejection observable but handled.
  void result.catch(() => undefined)

  let closePromise: Promise<void> | undefined
  const closeServer = (force: boolean): Promise<void> => {
    closePromise ??= stop(server, force).then(() => {
      closed = true
    })
    return closePromise
  }
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
  const rejectAfterClose = async (error: LoopbackAuthorizationError, force: boolean): Promise<void> => {
    if (settled) return closeServer(force)
    settled = true
    cleanup()
    await closeServer(force)
    rejectResult(error)
  }
  const resolveAfterClose = async (code: string): Promise<void> => {
    if (settled) return closeServer(false)
    settled = true
    cleanup()
    await closeServer(false)
    resolveResult({ code })
  }
  function onAbort(): void {
    void rejectAfterClose(
      new LoopbackAuthorizationError('AUTH_ABORTED', 'authorization callback was aborted'),
      true,
    )
  }

  const server = createServer((request, response) => {
    if (consumed) {
      staticPage(response, 409, ERROR_PAGE)
      return
    }
    if (request.method !== 'GET') {
      staticPage(response, 405, ERROR_PAGE)
      return
    }

    let url: URL
    try {
      const target = request.url ?? ''
      if (!target.startsWith('/') || target.startsWith('//')) throw new Error('invalid request target')
      url = new URL(target, `http://${LOOPBACK_HOST}`)
    } catch {
      staticPage(response, 400, ERROR_PAGE)
      return
    }
    if (url.pathname !== callbackPath) {
      staticPage(response, 404, NOT_FOUND_PAGE)
      return
    }

    const states = url.searchParams.getAll('state')
    if (states.length !== 1 || !exactSecret(states[0] ?? '', options.state)) {
      staticPage(response, 400, ERROR_PAGE)
      return
    }
    if (TOKEN_PARAMETERS.some((parameter) => url.searchParams.has(parameter))) {
      staticPage(response, 400, ERROR_PAGE)
      return
    }

    const codes = url.searchParams.getAll('code')
    const errors = url.searchParams.getAll('error')
    if (errors.length === 1 && errors[0] !== '' && codes.length === 0) {
      consumed = true
      staticPage(response, 400, ERROR_PAGE)
      void rejectAfterClose(callbackError(), false)
      return
    }
    if (errors.length !== 0 || codes.length !== 1 || codes[0] === '') {
      staticPage(response, 400, ERROR_PAGE)
      return
    }

    consumed = true
    const code = codes[0] as string
    staticPage(response, 200, SUCCESS_PAGE)
    void resolveAfterClose(code)
  })

  let port: number
  try {
    port = await listen(server)
  } catch {
    throw new LoopbackAuthorizationError(
      'AUTH_LISTENER_ERROR',
      'could not start the authorization callback listener',
    )
  }

  server.on('error', () => {
    void rejectAfterClose(
      new LoopbackAuthorizationError('AUTH_LISTENER_ERROR', 'the authorization callback listener failed'),
      true,
    )
  })
  timer = setTimeout(() => {
    void rejectAfterClose(
      new LoopbackAuthorizationError('AUTH_EXPIRED', 'authorization callback expired'),
      true,
    )
  }, timeoutMs)
  timer.unref()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()

  return {
    redirectUri: `http://${LOOPBACK_HOST}:${port}${callbackPath}`,
    result,
    get closed() {
      return closed
    },
    close: async () => {
      if (!settled) {
        await rejectAfterClose(
          new LoopbackAuthorizationError('AUTH_ABORTED', 'authorization callback was closed'),
          true,
        )
        return
      }
      await closeServer(true)
    },
  }
}
