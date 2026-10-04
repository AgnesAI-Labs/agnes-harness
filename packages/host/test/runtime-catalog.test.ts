import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionImpl } from '@agnes/core'
import { NATIVE_RUNTIME, RuntimeRegistry } from '@agnes/runtime-api'
import { createDecisionBackend, type DecisionRequest } from '@agnes/runtime-jev'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionRuntimeRegistry,
  jevFromEnvironment,
  openRuntimeSession,
  type RuntimeOpenContext,
} from '../src/runtime/catalog.js'
import { createJevDecisionTransport } from '../src/runtime/jev-transport.js'
import { createTestHost } from '../testkit/index.js'

const endpoint = 'https://api.typesafe.ai/v1/systemone'
const configuredEnv = { AGNES_JEV_ENDPOINT: endpoint, AGNES_JEV_MODEL: 'jev-latest' }
const request: DecisionRequest = {
  model: 'jev-latest',
  state: { task: 'test task' },
  questions: { purpose: { type: 'choice' } },
}
const signal = () => new AbortController().signal
const response = () => Response.json({ answers: { purpose: { choice: 'RESPOND' } }, model: 'jev-latest' })
afterEach(() => vi.restoreAllMocks())

describe('Jev environment availability and authentication', () => {
  it('holds a failed opener lease through an actual retained writer until a successful drain retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-failed-runtime-'))
    const { host } = await createTestHost({ dataDir: root, disableSessionTitle: true })
    const registry = new RuntimeRegistry<RuntimeOpenContext, SessionImpl>()
    const registration = registry.register({
      descriptor: {
        ...NATIVE_RUNTIME,
        apiVersion: 1,
        label: 'Native',
        available: true,
        capabilities: { prompt: true, cancel: true, resume: true, compact: true, fork: true },
      },
      open: (context) => context.open(),
    })
    let failed: SessionImpl | undefined
    let allowDrain = false
    try {
      await expect(
        openRuntimeSession(registry, NATIVE_RUNTIME, {
          open: async () => {
            const session = await host.createSession({ cwd: root, key: 'retained-writer' })
            failed = session
            const close = session.close.bind(session)
            session.close = async () => {
              if (!allowDrain) throw new Error('drain incomplete')
              await close()
            }
            throw new Error('initialization failed')
          },
          failedSession: () => failed,
        }),
      ).rejects.toThrow('initialization failed')
      registration.retire()
      let drained = false
      void registration.whenDrained().then(() => {
        drained = true
      })
      await Promise.resolve()
      expect(drained).toBe(false)
      if (!failed) throw new Error('Missing retained session')
      await expect(failed.close()).rejects.toThrow('drain incomplete')
      expect(failed.d.log.isClosed).toBe(false)
      expect(drained).toBe(false)
      allowDrain = true
      await failed.close()
      await registration.whenDrained()
      expect(failed.d.log.isClosed).toBe(true)
    } finally {
      allowDrain = true
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    [{}, /未配置/],
    [configuredEnv, /缺少 Bearer 密钥/],
    [{ ...configuredEnv, AGNES_JEV_API_KEY: ' ', TYPESAFE_API_KEY: ' ' }, /缺少 Bearer 密钥/],
    [{ ...configuredEnv, AGNES_JEV_AUTHENTICATION: 'basic' }, /认证方式无效/],
    [{ ...configuredEnv, AGNES_JEV_ENDPOINT: 'invalid' }, /地址无效/],
    [{ ...configuredEnv, AGNES_JEV_ENDPOINT: 'https://user:private@example.invalid/path' }, /不含凭据/],
    [{ ...configuredEnv, AGNES_JEV_ENDPOINT: `${endpoint}?secret=private` }, /不含凭据/],
    [{ ...configuredEnv, AGNES_JEV_API_KEY: 'one\ntwo' }, /密钥格式无效/],
    [
      { ...configuredEnv, AGNES_JEV_AUTHENTICATION: 'none', AGNES_JEV_DECISION_REQUEST_CREDITS: '0' },
      /有限正数/,
    ],
  ])('disables only Jev for invalid configuration %#', (env, reason) => {
    const registry = createSessionRuntimeRegistry(jevFromEnvironment(env))
    expect(registry.list().find((item) => item.id === 'native')?.available).toBe(true)
    expect(registry.list().find((item) => item.id === 'jevloop')).toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(reason),
    })
    expect(() => registry.acquire({ id: 'jevloop', version: '1' })).toThrow(
      expect.objectContaining({ code: 'E_RUNTIME_UNAVAILABLE' }),
    )
    expect(JSON.stringify(registry.list())).not.toContain('private')
  })

  it.each([
    [
      { AGNES_JEV_API_KEY: 'fixture-primary-key', TYPESAFE_API_KEY: 'fixture-alias-key' },
      'Bearer fixture-primary-key',
    ],
    [{ TYPESAFE_API_KEY: 'fixture-alias-key' }, 'Bearer fixture-alias-key'],
    [{ AGNES_JEV_AUTHENTICATION: 'none', AGNES_JEV_API_KEY: 'fixture-unused-key' }, null],
  ])('binds one credential-free request and sends the selected authentication %#', async (auth, expected) => {
    const fetcher = vi.fn<typeof fetch>(async () => response())
    const config = jevFromEnvironment({ ...configuredEnv, ...auth }, fetcher)
    if (!config || !('decision' in config)) throw new Error('Expected configured transport')
    expect(
      createSessionRuntimeRegistry(config)
        .list()
        .find((item) => item.id === 'jevloop')?.available,
    ).toBe(true)
    const backend = createDecisionBackend(config.decision)
    const call = await backend.prepare(
      { purpose: 'decision', state: request.state, questions: request.questions, inputCursor: '7' },
      signal(),
    )
    expect(JSON.stringify(call)).not.toContain('fixture-')
    const result = await backend.invoke(call, signal())
    expect(result.error).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
    const sent = fetcher.mock.calls[0]
    if (!sent) throw new Error('Expected a dispatched request')
    const [url, init] = sent
    expect(url).toBe(endpoint)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: JSON.stringify(request) })
    expect(new Headers(init?.headers).get('authorization')).toBe(expected)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    await expect(backend.invoke(call, signal())).rejects.toThrow('already invoked')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps Native Host startup and opening available when Bearer credentials are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-jev-catalog-'))
    const { host } = await createTestHost({
      dataDir: root,
      disableSessionTitle: true,
      env: {
        ...process.env,
        ...configuredEnv,
        AGNES_JEV_API_KEY: '',
        TYPESAFE_API_KEY: '',
        AGNES_JEV_AUTHENTICATION: 'bearer',
      },
    })
    try {
      expect(host.runtimeCatalog().find((item) => item.id === 'jevloop')).toMatchObject({
        available: false,
        unavailableReason: expect.stringContaining('缺少 Bearer 密钥'),
      })
      const native = await host.createSession({ cwd: root, runtime: 'native' })
      expect(native.runtimeIdentity).toEqual({ id: 'native', version: '1' })
      await native.close()
      await expect(
        host.createSession({ cwd: root, key: 'no-credentials', runtime: 'jevloop' }),
      ).rejects.toThrow(/缺少 Bearer 密钥/)
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Jev single-attempt bounded transport', () => {
  it.each([
    ['DECISION_HTTP', () => new Response('private-token and private-path', { status: 401 }), false],
    ['DECISION_HTTP', () => new Response('private-token', { status: 429 }), true],
    ['DECISION_HTTP', () => new Response('private-token', { status: 500 }), true],
    ['DECISION_HTTP', () => new Response('private-token', { status: 503 }), true],
    ['DECISION_INVALID_JSON', () => new Response('{"private-token": "unfinished')],
    ['DECISION_INVALID_UTF8', () => new Response(new Uint8Array([0xc3, 0x28]))],
    ['DECISION_EMPTY_RESPONSE', () => new Response(null, { status: 204 })],
    ['DECISION_RESPONSE_TOO_LARGE', () => new Response(new Uint8Array(4 * 1024 * 1024 + 1))],
    ['DECISION_INVALID_RESPONSE', () => Response.json([])],
    ['DECISION_INVALID_RESPONSE', () => new Response('{"score":1e999}')],
  ])('returns sanitized %s without retrying', async (code, makeResponse, retryable = false) => {
    const fetcher = vi.fn<typeof fetch>(async () => makeResponse())
    const result = await createJevDecisionTransport({ endpoint, token: 'private-token', fetcher }).invoke(
      request,
      signal(),
    )
    expect(result).toMatchObject({ error: { code, retryable }, latencyMs: expect.any(Number) })
    expect(JSON.stringify(result)).not.toMatch(/private-token|private-path|unfinished/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('sanitizes transport exceptions and never dispatches an already cancelled call', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('private-token at /private-path')
    })
    const transport = createJevDecisionTransport({ endpoint, fetcher })
    const result = await transport.invoke(request, signal())
    expect(result.error).toMatchObject({ code: 'DECISION_TRANSPORT', retryable: true })
    expect(JSON.stringify(result)).not.toMatch(/private-token|private-path/)
    const aborted = new AbortController()
    aborted.abort('private-token')
    expect((await transport.invoke(request, aborted.signal)).error?.code).toBe('DECISION_CANCELLED')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps the deadline active while streaming the response body', async () => {
    const timeout = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    let reading!: () => void
    const started = new Promise<void>((resolve) => {
      reading = resolve
    })
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(new Error('private-body-error')),
                { once: true },
              )
            },
            pull() {
              reading()
            },
          }),
        ),
    )
    const pending = createJevDecisionTransport({ endpoint, fetcher }).invoke(request, signal())
    await started
    timeout.abort()
    const result = await pending
    expect(result.error).toMatchObject({ code: 'DECISION_TIMEOUT', retryable: true })
    expect(JSON.stringify(result)).not.toContain('private-body-error')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['deadline', 'cancel'] as const)('releases a real fetch response reader after %s', async (mode) => {
    let requests = 0
    const server = createServer((req, res) => {
      requests++
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.flushHeaders()
      // Keep the response open until the caller aborts; no timer or synthetic stream is involved.
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected a local test server')
    const caller = new AbortController(),
      timeout = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    let ready!: () => void
    const received = new Promise<void>((resolve) => {
      ready = resolve
    })
    let response: Response | undefined
    const fetcher: typeof fetch = async (...args) => {
      response = await fetch(...args)
      ready()
      return response
    }
    try {
      const pending = createJevDecisionTransport({
        endpoint: `http://127.0.0.1:${address.port}/decision`,
        fetcher,
      }).invoke(request, caller.signal)
      await received
      await Promise.resolve()
      expect(response?.body?.locked).toBe(true)
      ;(mode === 'deadline' ? timeout : caller).abort()
      const result = await pending
      expect(result.error).toMatchObject({
        code: mode === 'deadline' ? 'DECISION_TIMEOUT' : 'DECISION_CANCELLED',
        retryable: mode === 'deadline',
      })
      expect(response?.body?.locked).toBe(false)
      expect(requests).toBe(1)
    } finally {
      caller.abort()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it.each(['deadline', 'cancel'] as const)(
    'aborts an in-flight request on %s with one attempt',
    async (mode) => {
      const timeout = new AbortController()
      const caller = new AbortController()
      const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
      const fetcher = vi.fn<typeof fetch>(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('private-token')), { once: true })
          }),
      )
      const pending = createJevDecisionTransport({ endpoint, fetcher }).invoke(request, caller.signal)
      ;(mode === 'deadline' ? timeout : caller).abort('private-token')
      const result = await pending
      expect(result.error).toMatchObject({
        code: mode === 'deadline' ? 'DECISION_TIMEOUT' : 'DECISION_CANCELLED',
        retryable: mode === 'deadline',
      })
      expect(JSON.stringify(result)).not.toContain('private-token')
      expect(deadline).toHaveBeenCalledWith(120_000)
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )
})
