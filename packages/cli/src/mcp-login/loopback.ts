import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type OAuthResultPage, renderOAuthResultPage } from '@agnes/resource-control-runtime'
import { McpLoginRefused } from './paste.js'

/** The fixed callback port of the server's OAuth settings is taken by another program. */
export class McpLoginPortBusy extends Error {
  constructor(port: number) {
    super(`callback port ${port} is in use; close the program using it, or change the server's callback port`)
    this.name = 'McpLoginPortBusy'
  }
}

export type LoopbackCallback = Readonly<{
  /** `http://localhost:<port>/callback`. */
  redirectUri: string
  /** The code of the first callback with this sign-in's `state`. */
  code: Promise<string>
  /** Answers that callback's browser page with how the sign-in ended. */
  finish(kind: OAuthResultPage, detail?: string): void
  close(): Promise<void>
}>

/**
 * Listens on 127.0.0.1 for the browser's return to `/callback` during one sign-in. Another path is
 * 404; a callback with another `state` is 400 and the wait goes on; only the first callback with this
 * sign-in's `state` counts, and its page stays open until `finish` (or `close`) says how it ended.
 * `port` 0 picks a free port; a busy `fixedPort` is an error, a busy preferred port falls back to a
 * free one.
 */
export async function startLoopbackCallback(input: {
  port: number
  fixedPort: boolean
  state: string
  signal: AbortSignal
}): Promise<LoopbackCallback> {
  let settle: { resolve(code: string): void; reject(error: unknown): void } | undefined
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // The caller may finish by paste or timeout and never read this promise.
  code.catch(() => undefined)
  let taken = false
  let held: ServerResponse | undefined

  const answer = (res: ServerResponse, kind: OAuthResultPage, detail?: string) => {
    const page = renderOAuthResultPage(kind, detail)
    res.writeHead(page.status, page.headers).end(page.body)
  }
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method !== 'GET' || url.pathname !== '/callback') return void res.writeHead(404).end()
    if (taken || url.searchParams.get('state') !== input.state) return answer(res, 'state-expired')
    const error = url.searchParams.get('error')
    const value = url.searchParams.get('code')
    if (!error && !value) return answer(res, 'failed', 'The callback carried no code.')
    taken = true
    if (error) {
      answer(res, error === 'access_denied' ? 'cancelled' : 'failed', error)
      return settle?.reject(
        new McpLoginRefused(error, url.searchParams.get('error_description') ?? undefined),
      )
    }
    held = res
    settle?.resolve(value as string)
  }

  let server: Server
  try {
    server = await listen(handle, input.port)
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'EADDRINUSE' || input.port === 0) throw error
    if (input.fixedPort) throw new McpLoginPortBusy(input.port)
    server = await listen(handle, 0)
  }
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : input.port

  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      if (held && !held.writableEnded) answer(held, 'failed')
      settle?.reject(new Error('the sign-in callback was closed'))
      server.close(() => resolve())
      server.closeAllConnections()
    }))
  input.signal.addEventListener('abort', () => void close(), { once: true })

  return {
    redirectUri: `http://localhost:${port}/callback`,
    code,
    finish(kind, detail) {
      if (held && !held.writableEnded) answer(held, kind, detail)
    },
    close,
  }
}

function listen(handle: (req: IncomingMessage, res: ServerResponse) => void, port: number): Promise<Server> {
  const server = createServer(handle)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}
