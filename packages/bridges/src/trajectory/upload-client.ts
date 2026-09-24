export type TraceConsent = 'DISABLED' | 'LOCAL' | 'ANON' | 'FULL'

/** Structural form of @agnes/base's session-bound gate; bridges keeps its lower-layer dependency. */
export type TrajectoryEgressGate = {
  readonly active: boolean
  readonly consent: TraceConsent
  readonly session: { readonly key: string }
  send(
    value: unknown,
    sender: (bytes: Uint8Array) => void | Promise<void>,
  ): Promise<{ bytes: Uint8Array; receipt: unknown }>
}

/** Runtime authority owned by the privacy layer. A structural look-alike is not sufficient. */
export type TrajectoryEgressAuthority = {
  assert(gate: TrajectoryEgressGate): void
}

export type UploaderOptions = {
  endpoint: string
  /** Explicit remote-origin allowlist. Loopback development endpoints are handled separately. */
  allowedOrigins?: readonly string[]
  harness: { name: string; version: string }
  /** Required: upload must use the canonical session/API gate that also commits its receipt. */
  egress: TrajectoryEgressGate
  /** Required opaque capability supplied by the layer that minted `egress`. */
  authority: TrajectoryEgressAuthority
  fetch: typeof fetch
  hash: (bytes: Uint8Array) => string
  now?: () => number
  minIntervalMs?: number
  debounceMs?: number
  requestTimeoutMs?: number
  signal?: AbortSignal
  authToken?: string
}

export type UploadResult = {
  status: 'sent' | 'deduped' | 'rate-limited' | 'skipped'
  reason?: string
}

export class UploadError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`UploadError: ${status} ${body.slice(0, 200)}`)
    this.name = 'UploadError'
  }
}

type Pending = { bytes: Uint8Array; inputHash: string; partial: boolean }
type SessionState = {
  lastInputHash?: string
  lastSentAt: number
  pending: Pending | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  operations: Promise<void>
  backgroundError: unknown | undefined
}

const nonNegative = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return value
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

const contentDigest = (hash: UploaderOptions['hash'], bytes: Uint8Array): string => {
  const digest = hash(bytes)
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('trajectory hash must be a lowercase sha256 hex digest')
  return digest
}

async function responseSnippet(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (length < 200) {
      const next = await reader.read()
      if (next.done) break
      const remaining = 200 - length
      const chunk = next.value.subarray(0, remaining)
      chunks.push(chunk)
      length += chunk.byteLength
      if (chunk.byteLength < next.value.byteLength) break
    }
  } catch {
    return ''
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Creates the real trajectory HTTP client. The injected gate is authoritative for consent,
 * ANON redaction, per-session receipt ordering and fail-closed receipt commit behaviour.
 */
export function createUploader(opts: UploaderOptions) {
  opts.authority.assert(opts.egress)
  const endpoint = new URL(opts.endpoint)
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:')
    throw new Error('trajectory endpoint must use http or https')
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
  if (endpoint.protocol === 'http:' && !loopback.has(endpoint.hostname))
    throw new Error('remote trajectory endpoint must use https')
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('trajectory endpoint must not contain credentials, query, or fragment')
  const allowedOrigins = new Set((opts.allowedOrigins ?? []).map((value) => new URL(value).origin))
  if (!loopback.has(endpoint.hostname) && !allowedOrigins.has(endpoint.origin))
    throw new Error('trajectory endpoint origin is not explicitly allowed')
  const now = opts.now ?? (() => Date.now())
  const minInterval = nonNegative(opts.minIntervalMs ?? 5_000, 'minIntervalMs')
  const debounce = nonNegative(opts.debounceMs ?? 1_500, 'debounceMs')
  const requestTimeout = nonNegative(opts.requestTimeoutMs ?? 30_000, 'requestTimeoutMs')
  const sessions = new Map<string, SessionState>()
  const activeRequests = new Set<AbortController>()
  const running = Symbol('running')
  let stopped: unknown | typeof running = running

  const stop = (reason: unknown): void => {
    if (stopped !== running) return
    stopped = reason
    opts.signal?.removeEventListener('abort', onAbort)
    for (const state of sessions.values()) {
      if (state.timer) clearTimeout(state.timer)
      state.timer = undefined
      state.pending = undefined
      state.backgroundError = undefined
    }
    for (const controller of activeRequests) controller.abort(reason)
    sessions.clear()
  }
  const onAbort = (): void =>
    stop(opts.signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
  const assertRunning = (): void => {
    if (stopped !== running) throw stopped
    throwIfAborted(opts.signal)
  }
  if (opts.signal?.aborted) onAbort()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })

  const stateFor = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId)
    if (!state) {
      state = {
        lastSentAt: Number.NEGATIVE_INFINITY,
        pending: undefined,
        timer: undefined,
        operations: Promise.resolve(),
        backgroundError: undefined,
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  const transmit = async (sessionId: string, state: SessionState, payload: Pending): Promise<void> => {
    assertRunning()
    opts.authority.assert(opts.egress)
    const value = opts.egress.consent === 'ANON' ? new TextDecoder().decode(payload.bytes) : payload.bytes
    await opts.egress.send(value, async (bytes) => {
      assertRunning()
      const url = new URL(
        `api/v1/agent-traces/sessions/${encodeURIComponent(sessionId)}`,
        endpoint.href.endsWith('/') ? endpoint : new URL(`${endpoint.href}/`),
      )
      const controller = new AbortController()
      activeRequests.add(controller)
      const timeout = setTimeout(
        () => controller.abort(new Error('trajectory upload timed out')),
        requestTimeout,
      )
      try {
        throwIfAborted(controller.signal)
        const response = await opts.fetch(url, {
          method: 'PUT',
          body: bytes.slice().buffer as ArrayBuffer,
          signal: controller.signal,
          redirect: 'error',
          headers: {
            'Content-Type': 'application/x-ndjson',
            'X-Agnes-Harness': `${opts.harness.name}/${opts.harness.version}`,
            'X-Agnes-Trace-Consent': opts.egress.consent,
            'X-Agnes-Trace-Digest': contentDigest(opts.hash, bytes),
            ...(payload.partial ? { 'X-Agnes-Trace-Partial': 'true' } : {}),
            ...(opts.authToken ? { Authorization: `Bearer ${opts.authToken}` } : {}),
          },
        })
        if (!response.ok) throw new UploadError(response.status, await responseSnippet(response))
        await response.body?.cancel().catch(() => undefined)
      } finally {
        clearTimeout(timeout)
        activeRequests.delete(controller)
      }
    })
    state.lastInputHash = payload.inputHash
    state.lastSentAt = now()
  }

  const flushOne = async (sessionId: string, state: SessionState): Promise<void> => {
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    let failure: unknown
    const task = state.operations.then(async () => {
      assertRunning()
      if (state.backgroundError !== undefined) {
        const error = state.backgroundError
        state.backgroundError = undefined
        throw error
      }
      const pending = state.pending
      state.pending = undefined
      if (pending) await transmit(sessionId, state, pending)
    })
    state.operations = task.catch((error: unknown) => {
      failure = error
    })
    await state.operations
    if (failure !== undefined) throw failure
  }

  return {
    async upload(
      sessionId: string,
      bytes: Uint8Array,
      meta: { partial?: boolean } = {},
    ): Promise<UploadResult> {
      assertRunning()
      if (!sessionId) throw new Error('trajectory sessionId is required')
      if (sessionId !== opts.egress.session.key)
        throw new Error('trajectory sessionId does not match the session-bound egress gate')
      if (!opts.egress.active) throw new Error('trajectory egress session is not active')
      const consent = opts.egress.consent
      if (consent === 'DISABLED' || consent === 'LOCAL') return { status: 'skipped', reason: 'consent' }
      const state = stateFor(sessionId)
      let result: UploadResult | undefined
      let failure: unknown
      const operation = state.operations.then(async () => {
        assertRunning()
        if (state.backgroundError !== undefined) {
          const error = state.backgroundError
          state.backgroundError = undefined
          throw error
        }
        const contentHash = contentDigest(opts.hash, bytes)
        if (state.pending?.inputHash === contentHash) {
          result = { status: 'deduped' }
          return
        }
        if (state.lastInputHash === contentHash) {
          // The latest snapshot returned to what is already remote. A newer queued snapshot must
          // not be allowed to overwrite that latest state after this call reports deduplication.
          state.pending = undefined
          if (state.timer) clearTimeout(state.timer)
          state.timer = undefined
          result = { status: 'deduped' }
          return
        }
        const payload = { bytes: bytes.slice(), inputHash: contentHash, partial: meta.partial === true }
        if (now() - state.lastSentAt < minInterval) {
          state.pending = payload
          if (state.timer) clearTimeout(state.timer)
          const remaining = Math.max(0, minInterval - (now() - state.lastSentAt))
          state.timer = setTimeout(
            () => {
              state.timer = undefined
              const background = state.operations.then(async () => {
                const pending = state.pending
                state.pending = undefined
                if (pending) await transmit(sessionId, state, pending)
              })
              state.operations = background.catch((error: unknown) => {
                state.backgroundError = error
              })
            },
            Math.max(debounce, remaining),
          )
          result = { status: 'rate-limited' }
          return
        }
        await transmit(sessionId, state, payload)
        result = { status: 'sent' }
      })
      state.operations = operation.catch((error: unknown) => {
        failure = error
      })
      await state.operations
      if (failure !== undefined) throw failure
      if (!result) throw new Error('trajectory upload completed without a result')
      return result
    },
    async flush(): Promise<void> {
      assertRunning()
      await Promise.all([...sessions].map(([sessionId, state]) => flushOne(sessionId, state)))
      assertRunning()
    },
    close(): void {
      stop(new Error('trajectory uploader is closed'))
    },
  }
}
