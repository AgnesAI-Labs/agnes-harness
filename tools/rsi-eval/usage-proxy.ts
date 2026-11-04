import { appendFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { errorBodyPreview } from './infra.js'
import type { UsageRow } from './types.js'

export type { UsageRow }

// Usage-recording reverse proxy for eval runs. Requests arrive as `/run/<runId>/<upstream path>`; the
// prefix is stripped and everything else (method, path, query, headers including auth, body) is forwarded
// to the upstream unchanged. The response streams back unchanged while a copy is parsed for token usage.
// One `UsageRow` is appended to the log per request. The log holds token counts and a few scalars only:
// never request/response headers or bodies, and never a key.
//
// The one body that is kept is that of a response that is not a 200: the status alone does not say why a
// call was refused (an unexplained 400, a 402 that is a balance and not a quota). It goes to a separate
// file, `errors.jsonl` next to the usage log: the first 500 characters, with anything that looks like a
// credential removed (see `errorBodyPreview`); never a header, never the request.
//
// Compressed responses: the bytes are forwarded as the upstream sent them (accept-encoding is not touched)
// and a decoded copy is parsed (gzip, deflate, br). An encoding we cannot decode yields `unknown`.
//
// Networking: the listener binds 127.0.0.1 by default. Containers on Docker Desktop (macOS/Windows) reach
// it as `host.docker.internal`. On Linux Docker that name does not resolve to the loopback of the host, so
// either pass `host` (the docker bridge address, e.g. 172.17.0.1) or run the container with
// `--add-host host.docker.internal:host-gateway` and start the proxy with `host: '0.0.0.0'`. The proxy has
// no authentication of its own, so only widen the bind on a trusted machine.

export type Prices = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type RunUsage = {
  requests: number
  unknown: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  costUsd: number
}

type Counts = {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  model: string | null
}

const MAX_JSON_BYTES = 32 * 1024 * 1024
/** How much of a response is read for an error preview; the preview itself is shorter. */
const PREVIEW_BYTES = 4096
const CLOSE_GRACE_MS = 5000
const MAX_STATUSES = 50

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

const emptyCounts = (): Counts => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  model: null,
})

/** Merge one `usage` object. Fields are overwritten only when present, so later events refine earlier ones. */
const applyUsage = (acc: Counts, usage: Record<string, unknown>): void => {
  const prompt = count(usage.prompt_tokens)
  if (prompt !== undefined) {
    // OpenAI chat: cached tokens are counted inside prompt_tokens.
    const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
    const cached = Math.min(count(details.cached_tokens) ?? 0, prompt)
    acc.input = prompt - cached
    acc.cacheRead = cached
    const completion = count(usage.completion_tokens)
    if (completion !== undefined) acc.output = completion
    return
  }
  const input = count(usage.input_tokens)
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined
  const cachedDetail = details === undefined ? undefined : count(details.cached_tokens)
  if (input !== undefined) {
    if (cachedDetail !== undefined) {
      // OpenAI Responses API: same convention as chat, cached tokens are inside input_tokens.
      const cached = Math.min(cachedDetail, input)
      acc.input = input - cached
      acc.cacheRead = cached
    } else {
      acc.input = input
    }
  }
  const output = count(usage.output_tokens)
  if (output !== undefined) acc.output = output
  const cacheRead = count(usage.cache_read_input_tokens)
  if (cacheRead !== undefined) acc.cacheRead = cacheRead
  const cacheWrite = count(usage.cache_creation_input_tokens)
  if (cacheWrite !== undefined) acc.cacheWrite = cacheWrite
}

const applyPayload = (acc: Counts, payload: unknown): void => {
  if (!isRecord(payload)) return
  if (payload.type === 'message_start' && isRecord(payload.message)) {
    if (typeof payload.message.model === 'string') acc.model = payload.message.model
    if (isRecord(payload.message.usage)) applyUsage(acc, payload.message.usage)
    return
  }
  if (payload.type === 'message_delta') {
    // Anthropic: the delta carries the cumulative output count; input/cache come from message_start.
    const output = isRecord(payload.usage) ? count(payload.usage.output_tokens) : undefined
    if (output !== undefined) acc.output = output
    return
  }
  const holder = isRecord(payload.response) ? payload.response : payload
  if (typeof holder.model === 'string') acc.model = holder.model
  if (isRecord(holder.usage)) applyUsage(acc, holder.usage)
}

/** Incremental SSE reader: feeds each event's JSON `data` payload to `applyPayload`. */
const createSseReader = (acc: Counts) => {
  const decoder = new TextDecoder()
  let pending = ''
  let dataLines: string[] = []
  const flushEvent = () => {
    if (dataLines.length === 0) return
    const data = dataLines.join('\n')
    dataLines = []
    if (data === '[DONE]') return
    try {
      applyPayload(acc, JSON.parse(data))
    } catch {
      // Not JSON: ignore the event.
    }
  }
  const line = (text: string) => {
    if (text === '') flushEvent()
    else if (text.startsWith('data:')) dataLines.push(text.slice(5).replace(/^ /, ''))
  }
  return {
    write(chunk: Buffer) {
      pending += decoder.decode(chunk, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        line(pending.slice(0, newline).replace(/\r$/, ''))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    },
    end() {
      pending += decoder.decode()
      if (pending !== '') line(pending.replace(/\r$/, ''))
      flushEvent()
    },
  }
}

const decoderFor = (encoding: string | undefined) => {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return { kind: 'none' as const }
    case 'gzip':
    case 'x-gzip':
      return { kind: 'stream' as const, stream: createGunzip() }
    case 'deflate':
      return { kind: 'stream' as const, stream: createInflate() }
    case 'br':
      return { kind: 'stream' as const, stream: createBrotliDecompress() }
    default:
      return { kind: 'unsupported' as const }
  }
}

/** Parses a tee of one response body. `finish()` resolves once all bytes were decoded and read. */
const createUsageTap = (contentType: string, contentEncoding: string | undefined) => {
  const acc = emptyCounts()
  const isSse = contentType.toLowerCase().includes('text/event-stream')
  const sse = createSseReader(acc)
  const jsonChunks: Buffer[] = []
  let jsonBytes = 0
  let broken = false
  const head: Buffer[] = []
  let headBytes = 0
  const decoder = decoderFor(contentEncoding)
  if (decoder.kind === 'unsupported') broken = true

  const consume = (chunk: Buffer) => {
    if (headBytes < PREVIEW_BYTES) {
      const part = chunk.subarray(0, PREVIEW_BYTES - headBytes)
      head.push(part)
      headBytes += part.length
    }
    if (isSse) {
      sse.write(chunk)
      return
    }
    jsonBytes += chunk.length
    if (jsonBytes > MAX_JSON_BYTES) broken = true
    else jsonChunks.push(chunk)
  }
  const result = (): Counts & { reported: boolean; head: string } => {
    if (isSse) sse.end()
    else if (!broken) {
      try {
        applyPayload(acc, JSON.parse(Buffer.concat(jsonChunks).toString('utf8')))
      } catch {
        broken = true
      }
    }
    // A partial count (e.g. a stream cut after message_start) is not a usable total: report unknown.
    const reported = !broken && acc.input !== null && acc.output !== null
    return {
      ...acc,
      reported,
      head:
        decoder.kind === 'unsupported'
          ? '(body not readable: unsupported content-encoding)'
          : Buffer.concat(head).toString('utf8'),
    }
  }

  let done: Promise<ReturnType<typeof result>> | undefined
  return {
    write(chunk: Buffer) {
      if (broken && decoder.kind === 'unsupported') return
      if (decoder.kind === 'stream') decoder.stream.write(chunk)
      else consume(chunk)
    },
    finish(): Promise<ReturnType<typeof result>> {
      done ??= new Promise((resolve) => {
        if (decoder.kind !== 'stream') {
          resolve(result())
          return
        }
        decoder.stream.on('data', (chunk: Buffer) => consume(chunk))
        decoder.stream.on('error', () => {
          broken = true
          resolve(result())
        })
        decoder.stream.on('end', () => resolve(result()))
        decoder.stream.end()
      })
      return done
    },
  }
}

const unknownRow = (runId: string, status: number): UsageRow => ({
  ts: new Date().toISOString(),
  runId,
  status,
  model: null,
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  usage: 'unknown',
})

/** The status a request past a run's cap is answered with: a refused request, not an upstream failure. */
export const CAP_STATUS = 400

/** The proxy's handle. `limit` sets a run's request cap (see `RequestCap`). */
export type UsageProxy = {
  port: number
  close(): Promise<void>
  statuses(runId: string): number[]
} & RequestCap

/**
 * A cap on the model requests of one run id. Requests past `max` are not forwarded: they are answered
 * `CAP_STATUS` with a body that says so (a refusal the infrastructure check does not take for an upstream
 * failure), nothing is logged as usage, and `reached` is called once so the runner can stop the run.
 */
export type RequestCap = {
  limit(runId: string, max: number, reached: () => void): void
  unlimit(runId: string): void
  /** Requests forwarded for the run id so far. */
  forwarded(runId: string): number
}

export async function startUsageProxy(opts: {
  upstream: string
  port: number
  logFile: string
  /** Bind address. Default 127.0.0.1; see the networking note at the top of this file. */
  host?: string
  /** Where the bodies of non-200 responses are kept. Default `errors.jsonl` next to `logFile`. */
  errorLogFile?: string
  /** Secrets (the API key) that are removed from a kept body wherever they appear. */
  redact?: string[]
}): Promise<UsageProxy> {
  const upstream = new URL(opts.upstream)
  const client = upstream.protocol === 'https:' ? https : http
  const basePath = upstream.pathname.replace(/\/+$/, '')
  const inflight = new Set<Promise<void>>()
  const statuses = new Map<string, number[]>()
  const forwarded = new Map<string, number>()
  const caps = new Map<string, { max: number; reached: () => void; fired: boolean }>()

  const log = (row: UsageRow) => {
    appendFileSync(opts.logFile, `${JSON.stringify(row)}\n`)
    const seen = statuses.get(row.runId) ?? []
    seen.push(row.status)
    if (seen.length > MAX_STATUSES) seen.shift()
    statuses.set(row.runId, seen)
  }
  const errorLogFile = opts.errorLogFile ?? join(dirname(opts.logFile), 'errors.jsonl')
  const logError = (runId: string, status: number, body: string) => {
    appendFileSync(
      errorLogFile,
      `${JSON.stringify({ ts: new Date().toISOString(), runId, status, body: errorBodyPreview(body, opts.redact) })}\n`,
    )
  }

  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const match = /^\/run\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? '')
    if (!match) {
      req.resume()
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('expected /run/<runId>/<path>')
      return
    }
    let runId: string
    try {
      runId = decodeURIComponent(match[1] as string)
    } catch {
      req.resume()
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('bad run id')
      return
    }
    const path = `${basePath}${match[2] ?? '/'}${match[3] ?? ''}`

    const cap = caps.get(runId)
    if (cap && (forwarded.get(runId) ?? 0) >= cap.max) {
      req.resume()
      const message = `rsi-eval: this run reached its cap of ${cap.max} model requests; the request was not sent`
      res.writeHead(CAP_STATUS, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }))
      logError(runId, CAP_STATUS, message)
      if (!cap.fired) {
        cap.fired = true
        cap.reached()
      }
      return
    }
    forwarded.set(runId, (forwarded.get(runId) ?? 0) + 1)

    const headers: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(name) && name !== 'host' && value !== undefined) headers[name] = value
    }
    headers.host = upstream.host

    let settle: () => void = () => {}
    const tracked = new Promise<void>((resolve) => {
      settle = resolve
    })
    inflight.add(tracked)
    let logged = false
    let answered = false
    const logOnce = (row: UsageRow) => {
      if (logged) return
      logged = true
      log(row)
      inflight.delete(tracked)
      settle()
    }

    const upstreamReq = client.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port === '' ? undefined : Number(upstream.port),
        method: req.method,
        path,
        headers,
      },
      (upstreamRes) => {
        answered = true
        const status = upstreamRes.statusCode ?? 502
        const tap = createUsageTap(
          String(upstreamRes.headers['content-type'] ?? ''),
          upstreamRes.headers['content-encoding'],
        )
        const outHeaders: http.OutgoingHttpHeaders = {}
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(name) && value !== undefined) outHeaders[name] = value
        }
        res.writeHead(status, upstreamRes.statusMessage, outHeaders)
        // Pass-through is a plain pipe (backpressure intact); the tap sees a copy of each chunk. The data
        // listener keeps draining after a client disconnect so the tokens already spent are still counted.
        upstreamRes.pipe(res)
        upstreamRes.on('data', (chunk: Buffer) => tap.write(chunk))
        upstreamRes.on('error', () => res.destroy())
        upstreamRes.on('close', () => {
          void tap.finish().then((parsed) => {
            if (status !== 200 && !logged) logError(runId, status, parsed.head)
            logOnce({
              ts: new Date().toISOString(),
              runId,
              status,
              model: parsed.model,
              input: parsed.reported ? parsed.input : null,
              output: parsed.reported ? parsed.output : null,
              cacheRead: parsed.reported ? (parsed.cacheRead ?? 0) : null,
              cacheWrite: parsed.reported ? (parsed.cacheWrite ?? 0) : null,
              usage: parsed.reported ? 'reported' : 'unknown',
            })
          })
        })
      },
    )
    upstreamReq.on('error', (error: NodeJS.ErrnoException) => {
      if (!logged) logError(runId, 502, `upstream unreachable: ${error.code ?? error.name}`)
      logOnce(unknownRow(runId, 502))
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('upstream unreachable')
      } else {
        res.destroy()
      }
    })
    res.on('close', () => {
      // Client went away before the upstream answered: stop the upstream request.
      if (!logged && !upstreamReq.destroyed && !answered) upstreamReq.destroy()
    })
    req.on('error', () => upstreamReq.destroy())
    req.pipe(upstreamReq)
  }

  const server = http.createServer(handle)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    /** The statuses the upstream answered a run with, oldest first (the last 50). */
    statuses: (runId) => [...(statuses.get(runId) ?? [])],
    limit: (runId, max, reached) => {
      caps.set(runId, { max, reached, fired: false })
    },
    unlimit: (runId) => {
      caps.delete(runId)
    },
    forwarded: (runId) => forwarded.get(runId) ?? 0,
    async close() {
      server.closeIdleConnections()
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, CLOSE_GRACE_MS)
        }),
      ])
      clearTimeout(timer)
      server.closeAllConnections()
      await closed
    },
  }
}

export function summarizeUsage(rows: UsageRow[], prices: Prices): Map<string, RunUsage> {
  const byRun = new Map<string, RunUsage>()
  for (const row of rows) {
    let entry = byRun.get(row.runId)
    if (!entry) {
      entry = {
        requests: 0,
        unknown: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
      }
      byRun.set(row.runId, entry)
    }
    entry.requests += 1
    if (row.usage === 'unknown') entry.unknown += 1
    entry.tokens.input += row.input ?? 0
    entry.tokens.output += row.output ?? 0
    entry.tokens.cacheRead += row.cacheRead ?? 0
    entry.tokens.cacheWrite += row.cacheWrite ?? 0
  }
  for (const entry of byRun.values()) {
    const { input, output, cacheRead, cacheWrite } = entry.tokens
    entry.costUsd =
      (input * prices.input +
        output * prices.output +
        cacheRead * prices.cacheRead +
        cacheWrite * prices.cacheWrite) /
      1_000_000
  }
  return byRun
}

const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const main = async (): Promise<void> => {
  const upstream = flag('--upstream')
  const port = Number(flag('--port'))
  const logFile = flag('--log')
  if (!upstream || !logFile || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('usage: usage-proxy.ts --upstream <url> --port <n> --log <file> [--host <addr>]')
  const proxy = await startUsageProxy({
    upstream,
    port,
    logFile,
    ...(flag('--host') ? { host: flag('--host') as string } : {}),
  })
  process.stdout.write(`usage proxy listening on port ${proxy.port}, log ${logFile}\n`)
  const stop = () => {
    void proxy.close().then(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
