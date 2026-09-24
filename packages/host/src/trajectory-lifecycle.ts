import { createHash } from 'node:crypto'
import { type ScanQuery, scanAll } from '@agnes/core'
import type { SessionRef } from '@agnes/extension-api'
import type { EventEnvelope } from '@agnes/protocol'
import type { PublicationDispatch } from './publication-dispatch.js'
import type { PrivacyTrajectoryCapability, TrajectoryAssemblyOptions } from './trajectory-contract.js'
import { createPinnedTrajectoryFetch } from './trajectory-network.js'
import type { WorkspaceInvocationResolver } from './workspace-invocation-resolver.js'

type TrajectorySession = {
  readonly lastSeq: number
  scan(query: ScanQuery): Promise<EventEnvelope[]>
}

type TrajectoryLifecycleOptions = TrajectoryAssemblyOptions & {
  env: NodeJS.ProcessEnv
  resolve(session: SessionRef): TrajectorySession | undefined
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
      const chunk = next.value.subarray(0, 200 - length)
      chunks.push(chunk)
      length += chunk.byteLength
      if (chunk.byteLength < next.value.byteLength) break
    }
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

function endpointFor(env: NodeJS.ProcessEnv): URL | undefined {
  const configured = env.AGNES_TRACE_ENDPOINT?.trim()
  if (!configured) return undefined
  const endpoint = new URL(configured)
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('trajectory endpoint must be a credential-free HTTPS URL without query or fragment')
  const operatorOrigins = (env.AGNES_TRACE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const allowed = new URL(value)
      if (
        allowed.protocol !== 'https:' ||
        allowed.username ||
        allowed.password ||
        allowed.pathname !== '/' ||
        allowed.search ||
        allowed.hash
      )
        throw new Error('AGNES_TRACE_ALLOWED_ORIGINS entries must be credential-free HTTPS origins')
      return allowed.origin
    })
  if (!new Set(['https://platform.agnes-ai.com', ...operatorOrigins]).has(endpoint.origin))
    throw new Error('trajectory endpoint origin is not authorized by AGNES_TRACE_ALLOWED_ORIGINS')
  return endpoint
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

/** Build Host's one fixed, exact-session trajectory operation; no arbitrary network leaks outward. */
export function createTrajectoryLifecycle(
  options: TrajectoryLifecycleOptions,
  workspaceInvocationFor: WorkspaceInvocationResolver,
  publication?: PublicationDispatch,
): PrivacyTrajectoryCapability | undefined {
  const endpoint = endpointFor(options.env)
  if (!endpoint) return undefined
  const transport = options.trajectoryFetch ?? createPinnedTrajectoryFetch(options.trajectoryResolver)
  const sessionFor = (ref: SessionRef): TrajectorySession => {
    const session = options.resolve(ref)
    if (!session) throw new Error('trajectory session reference is not active')
    return session
  }
  return {
    previous: (ref, signal) => {
      const port = workspaceInvocationFor(ref.key)
      const handler = async () => {
        throwIfAborted(signal)
        const row = (
          await sessionFor(ref).scan({ type: 'x/agnes/privacy/egress', order: 'desc', limit: 1 })
        )[0]
        throwIfAborted(signal)
        const chain = (row?.data as { chain?: unknown } | undefined)?.chain
        if (chain === undefined) return null
        if (typeof chain !== 'string' || !/^[a-f0-9]{64}$/.test(chain))
          throw new Error('stored trajectory receipt chain is invalid')
        return chain
      }
      return publication ? publication.workspace(() => ({ port, handler })) : port.run(handler)
    },
    upload: (ref, gate, authority, signal) => {
      const port = workspaceInvocationFor(ref.key)
      const handler = async () => {
        authority.assert(gate)
        if (gate.session !== ref) throw new Error('trajectory gate is not bound to the active session')
        throwIfAborted(signal)
        const session = sessionFor(ref)
        const events = await scanAll((q) => session.scan(q), { toSeq: session.lastSeq })
        throwIfAborted(signal)
        const text = events.length ? `${events.map((event) => JSON.stringify(event)).join('\n')}\n` : ''
        await gate.send(text, async (bytes) => {
          throwIfAborted(signal)
          const controller = new AbortController()
          const abort = (): void => controller.abort(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          const timeout = setTimeout(() => controller.abort(new Error('trajectory upload timed out')), 30_000)
          try {
            throwIfAborted(signal)
            const url = new URL(
              `api/v1/agent-traces/sessions/${encodeURIComponent(ref.key)}`,
              endpoint.href.endsWith('/') ? endpoint : new URL(`${endpoint.href}/`),
            )
            const response = await transport(url, {
              method: 'PUT',
              body: bytes.slice().buffer as ArrayBuffer,
              signal: controller.signal,
              redirect: 'error',
              headers: {
                'Content-Type': 'application/x-ndjson',
                'X-Agnes-Harness': `agnes/${options.agnesVersion ?? '0.0.0'}`,
                'X-Agnes-Trace-Consent': gate.consent,
                'X-Agnes-Trace-Digest': createHash('sha256').update(bytes).digest('hex'),
                ...(options.env.AGNES_TRACE_TOKEN
                  ? { Authorization: `Bearer ${options.env.AGNES_TRACE_TOKEN}` }
                  : {}),
              },
            })
            if (!response.ok)
              throw new Error(
                `trajectory upload failed: ${response.status} ${await responseSnippet(response)}`,
              )
            await response.body?.cancel().catch(() => undefined)
          } finally {
            clearTimeout(timeout)
            signal.removeEventListener('abort', abort)
          }
        })
      }
      return publication ? publication.workspace(() => ({ port, handler })) : port.run(handler)
    },
  }
}
