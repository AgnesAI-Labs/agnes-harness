import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialStore } from '@agnes/host'
import { expect, it, vi } from 'vitest'
import { authorizeCloudConnection } from '../src/cloud-authorization.js'
import { createCredentialAdmin } from '../src/credentials.js'

vi.mock('node:timers/promises', async (original) => ({
  ...(await original<typeof import('node:timers/promises')>()),
  setTimeout: (ms: number, value: unknown, options: { signal?: AbortSignal } = {}) =>
    new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(value)
      }
      const abort = () => finish(options.signal?.reason)
      const timer = setTimeout(() => finish(), ms)
      if (options.signal?.aborted) abort()
      else options.signal?.addEventListener('abort', abort, { once: true })
    }),
}))

it('resolves managed cloud credentials privately, refuses rejected/missing credentials and sanitizes platform failures', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'agh-cloud-credential-'))
  const store = createCredentialStore({ root: join(scratch, 'home') })
  const id = 'secret://generic/11111111-1111-1111-1111-111111111111'
  const input = { origin: 'https://cloud.fixture:8443', credentialRef: id }
  vi.stubEnv('AGH_LLMSG_API_BASE_URL', 'https://broker.fixture')
  const key = 'agh_sk_synthetic-cloud-key'
  const token = `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`
  const expiresAt = Date.now() + 3_600_000
  try {
    await expect(authorizeCloudConnection(input, store)).rejects.toMatchObject({
      data: { reason: 'CONFIG_CREDENTIAL_NOT_FOUND' },
    })
    await store.putGeneric(id, key, { label: 'Cloud fixture', createdAt: new Date().toISOString() })
    const result = await authorizeCloudConnection(input, store, async (url, init) => {
      expect(String(url)).toBe('https://cloud.fixture:8443/_agnes/remote-frontend/auth')
      expect(JSON.parse(String(init?.body))).toEqual({ key })
      expect(init?.redirect).toBe('error')
      return Response.json({ token, expiresAt, key: 'must-not-be-projected' })
    })
    expect(result).toEqual({ token, expiresAt })
    expect(JSON.stringify(result)).not.toContain(key)
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const origin = `http://${host}:8443`
      await expect(
        authorizeCloudConnection({ ...input, origin }, store, async (url) => {
          expect(String(url)).toBe(`${origin}/_agnes/remote-frontend/auth`)
          return Response.json({ token, expiresAt })
        }),
      ).resolves.toEqual({ token, expiresAt })
    }
    const cleartext = vi.fn<typeof fetch>()
    await expect(
      authorizeCloudConnection({ ...input, origin: 'http://cloud.fixture:8443' }, store, cleartext),
    ).rejects.toMatchObject({ data: { reason: 'CLOUD_CONNECTION_INVALID' } })
    expect(cleartext).not.toHaveBeenCalled()
    const sandbox = { ...input, origin: 'https://8443-fixture.ap-shanghai.tencentags.com' }
    const addresses: string[] = []
    const platform = await authorizeCloudConnection(sandbox, store, async (url, init) => {
      addresses.push(String(url))
      expect(init?.redirect).toBe('error')
      if (String(url).endsWith('/llmsg/api/agh/connection')) {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`)
        expect(JSON.parse(String(init?.body))).toEqual({ sandbox_url: sandbox.origin })
        return Response.json({
          code: 200,
          data: { sandbox_url: sandbox.origin, traffic_token: 'business-fixture' },
        })
      }
      expect(new Headers(init?.headers).get('e2b-traffic-access-token')).toBe('business-fixture')
      return Response.json({ token, expiresAt })
    })
    expect(platform).toEqual({ token, expiresAt, trafficToken: 'business-fixture' })
    expect(addresses).toEqual([
      'https://broker.fixture/llmsg/api/agh/connection',
      `${sandbox.origin}/_agnes/remote-frontend/auth`,
    ])
    const discovered = await authorizeCloudConnection({ credentialRef: id }, store, async (url, init) => {
      if (String(url).endsWith('/llmsg/api/agh/connection')) {
        expect(JSON.parse(String(init?.body))).toEqual({})
        return Response.json({
          code: 200,
          data: { sandbox_url: sandbox.origin, traffic_token: 'business-fixture' },
        })
      }
      expect(String(url)).toBe(`${sandbox.origin}/_agnes/remote-frontend/auth`)
      expect(new Headers(init?.headers).get('e2b-traffic-access-token')).toBe('business-fixture')
      return Response.json({ token, expiresAt })
    })
    expect(discovered).toEqual({ origin: sandbox.origin, token, expiresAt, trafficToken: 'business-fixture' })
    for (const invalid of ['http://127.0.0.1:80', 'https://foreign.example', `${sandbox.origin}/path`])
      await expect(
        authorizeCloudConnection({ credentialRef: id }, store, async () =>
          Response.json({ code: 200, data: { sandbox_url: invalid, traffic_token: 'business-fixture' } }),
        ),
      ).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
    let ordinaryFetched = false
    await expect(
      authorizeCloudConnection(
        { credentialRef: id },
        {
          read: async () => ({
            version: 1,
            kind: 'api-key',
            provider: 'generic',
            label: 'ordinary',
            value: 'sk-ordinary',
          }),
        },
        async () => {
          ordinaryFetched = true
          return Response.json({})
        },
      ),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_CREDENTIAL_REJECTED' } })
    expect(ordinaryFetched).toBe(false)
    await expect(
      authorizeCloudConnection(sandbox, store, async () => new Response('', { status: 401 })),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_CREDENTIAL_REJECTED' } })
    await expect(
      authorizeCloudConnection(sandbox, store, async () =>
        Response.json({
          code: 200,
          data: { sandbox_url: 'https://foreign.example', traffic_token: 'business-fixture' },
        }),
      ),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
    for (const [status, reason] of [
      [400, 'CLOUD_CONNECTION_INVALID'],
      [401, 'CONFIG_CREDENTIAL_REJECTED'],
      [403, 'CONFIG_CREDENTIAL_REJECTED'],
      [409, 'CLOUD_SANDBOX_NOT_READY'],
      [429, 'CLOUD_RATE_LIMITED'],
      [500, 'CONFIG_AUTH_UNAVAILABLE'],
    ] as const) {
      await expect(
        authorizeCloudConnection(sandbox, store, async (url) => {
          expect(String(url)).toBe('https://broker.fixture/llmsg/api/agh/connection')
          return Response.json({ message: key, traffic_token: 'must-not-escape' }, { status })
        }),
      ).rejects.toMatchObject({ data: { reason } })
    }
    for (const body of [
      null,
      { code: 200, data: { sandbox_url: sandbox.origin, traffic_token: '' } },
      { code: 200, data: { sandbox_url: sandbox.origin, traffic_token: 'bad\nheader' } },
      { code: 200, data: { sandbox_url: sandbox.origin, traffic_token: 'bad\u007fheader' } },
      {
        code: 200,
        data: { sandbox_url: sandbox.origin, traffic_token: 'valid', padding: 'x'.repeat(16_384) },
      },
    ])
      await expect(
        authorizeCloudConnection(sandbox, store, async () => Response.json(body)),
      ).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
    vi.stubEnv('AGH_LLMSG_API_BASE_URL', undefined)
    const defaultAddresses: string[] = []
    await expect(
      authorizeCloudConnection({ credentialRef: id }, store, async (url, init) => {
        defaultAddresses.push(String(url))
        if (String(url).endsWith('/llmsg/api/agh/connection')) {
          expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`)
          expect(JSON.parse(String(init?.body))).toEqual({})
          return Response.json({
            code: 200,
            data: { sandbox_url: sandbox.origin, traffic_token: 'business-fixture' },
          })
        }
        expect(new Headers(init?.headers).get('e2b-traffic-access-token')).toBe('business-fixture')
        return Response.json({ token, expiresAt })
      }),
    ).resolves.toEqual({ origin: sandbox.origin, token, expiresAt, trafficToken: 'business-fixture' })
    expect(defaultAddresses).toEqual([
      'https://api.llm.sg/llmsg/api/agh/connection',
      `${sandbox.origin}/_agnes/remote-frontend/auth`,
    ])
    for (const failure of ['network', 'http'] as const) {
      vi.stubEnv('AGH_LLMSG_API_BASE_URL', 'https://broker.fixture')
      const failedAddresses: string[] = []
      await expect(
        authorizeCloudConnection({ credentialRef: id }, store, async (url) => {
          failedAddresses.push(String(url))
          if (failure === 'network') throw Error('synthetic network failure')
          return new Response('', { status: 500 })
        }),
      ).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
      expect(failedAddresses).toEqual(['https://broker.fixture/llmsg/api/agh/connection'])
    }
    vi.stubEnv('AGH_LLMSG_API_BASE_URL', '')
    await expect(
      authorizeCloudConnection(sandbox, store, async () => {
        throw Error('must not contact a default broker for an invalid explicit configuration')
      }),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
    vi.stubEnv('AGH_LLMSG_API_BASE_URL', 'http://broker.fixture')
    await expect(
      authorizeCloudConnection(sandbox, store, async () => {
        throw Error('must not send the Key over public HTTP')
      }),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
    vi.stubEnv('AGH_LLMSG_API_BASE_URL', 'https://broker.fixture')
    for (const skew of [-60_000, 0, 60_000]) {
      const expiry = Date.now() + 8 * 60 * 60 * 1000 + skew
      await expect(
        authorizeCloudConnection(input, store, async () => Response.json({ token, expiresAt: expiry })),
      ).resolves.toEqual({ token, expiresAt: expiry })
    }
    for (const expiry of [Date.now() - 1, Date.now() + 9 * 60 * 60 * 1000, Number.NaN])
      await expect(
        authorizeCloudConnection(input, store, async () => Response.json({ token, expiresAt: expiry })),
      ).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
    await expect(
      authorizeCloudConnection(input, store, async () => new Response('', { status: 401 })),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_CREDENTIAL_REJECTED' } })
    await expect(
      authorizeCloudConnection(input, store, async () => {
        throw new Error(key)
      }),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
    await expect(
      authorizeCloudConnection({ ...input, origin: 'http://cloud.fixture/path' }, store),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
  } finally {
    vi.unstubAllEnvs()
    await rm(scratch, { recursive: true, force: true })
  }
})

it.each(['declared', 'chunked', 'malformed', 'refused', 'unavailable', 'cancelled'] as const)(
  'bounds the cloud authorization response (%s)',
  async (kind) => {
    const credentialRef = 'secret://generic/11111111-1111-1111-1111-111111111111'
    const store = {
      read: async () => ({
        version: 1 as const,
        kind: 'api-key' as const,
        provider: 'generic',
        value: 'fixture',
        label: 'fixture',
      }),
    }
    const cancellation = new AbortController()
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          if (kind === 'chunked') {
            controller.enqueue(new Uint8Array(8192))
            controller.enqueue(new Uint8Array(8193))
          }
        },
        pull() {
          if (kind === 'cancelled') cancellation.abort()
        },
        cancel,
      },
      kind === 'cancelled' ? { highWaterMark: 0 } : undefined,
    )
    const response =
      kind === 'malformed'
        ? new Response('{')
        : new Response(stream, {
            status: kind === 'refused' ? 401 : kind === 'unavailable' ? 500 : 200,
            ...(kind === 'declared' ? { headers: { 'content-length': '16385' } } : {}),
          })
    await expect(
      authorizeCloudConnection(
        { credentialRef, origin: 'https://cloud.fixture' },
        store,
        async () => response,
        cancellation.signal,
      ),
    ).rejects.toMatchObject({
      data: { reason: kind === 'refused' ? 'CONFIG_CREDENTIAL_REJECTED' : 'CONFIG_AUTH_UNAVAILABLE' },
    })
    if (kind !== 'malformed') expect(cancel).toHaveBeenCalledOnce()
  },
)

it('bounds transient cloud authorization retries across both stages and admits slow successful responses', async () => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms)
    return controller.signal
  })
  vi.stubEnv('AGH_LLMSG_API_BASE_URL', 'https://broker.fixture')
  const input = { credentialRef: 'secret://generic/11111111-1111-1111-1111-111111111111' }
  const store = {
    read: async () => ({
      version: 1 as const,
      kind: 'api-key' as const,
      provider: 'generic',
      label: 'fixture',
      value: 'agh_sk_synthetic',
    }),
  }
  const origin = 'https://8443-fixture.ap-shanghai.tencentags.com'
  const token = `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`
  const connection = () =>
    Response.json({ code: 200, data: { sandbox_url: origin, traffic_token: 'fixture' } })
  try {
    let calls = 0
    const slow = authorizeCloudConnection(input, store, async (url, init) => {
      calls++
      if (calls === 1) return new Response('', { status: 502 })
      await new Promise((resolve) =>
        setTimeout(resolve, String(url).endsWith('/connection') ? 23_000 : 12_000),
      )
      init?.signal?.throwIfAborted()
      return String(url).endsWith('/connection')
        ? connection()
        : Response.json({ token, expiresAt: Date.now() + 60_000 })
    })
    const accepted = expect(slow).resolves.toMatchObject({ origin, token, trafficToken: 'fixture' })
    await vi.advanceTimersByTimeAsync(36_000)
    await accepted
    expect(calls).toBe(3)
    for (const [status, reason] of [
      [400, 'CLOUD_CONNECTION_INVALID'],
      [401, 'CONFIG_CREDENTIAL_REJECTED'],
      [403, 'CONFIG_CREDENTIAL_REJECTED'],
      [409, 'CLOUD_SANDBOX_NOT_READY'],
      [429, 'CLOUD_RATE_LIMITED'],
    ] as const) {
      calls = 0
      await expect(
        authorizeCloudConnection(input, store, async () => {
          calls++
          return new Response('', { status })
        }),
      ).rejects.toMatchObject({ data: { reason } })
      expect(calls, 'permanent refusals must not consume an automatic retry').toBe(1)
    }
    for (const failure of [502, 503, 504, 'network', 'timeout'] as const) {
      calls = 0
      const pending = authorizeCloudConnection(input, store, async () => {
        calls++
        if (failure === 'network') throw new TypeError('private network detail')
        if (failure === 'timeout') throw new DOMException('private timeout detail', 'TimeoutError')
        return new Response('private upstream detail', { status: failure })
      })
      const rejected = expect(pending).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
      await vi.advanceTimersByTimeAsync(1000)
      await rejected
      expect(calls).toBe(2)
    }
    calls = 0
    const shared = authorizeCloudConnection(input, store, async (url) => {
      calls++
      if (calls === 1) return new Response('', { status: 503 })
      return String(url).endsWith('/connection') ? connection() : new Response('', { status: 502 })
    })
    const rejected = expect(shared).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(calls, 'sandbox failure cannot start another retry after discovery used the budget').toBe(3)
    calls = 0
    const hung = authorizeCloudConnection(input, store, async (_url, init) => {
      calls++
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    })
    const bounded = expect(hung).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
    await vi.advanceTimersByTimeAsync(45_000)
    await bounded
    expect(calls, 'one retry must remain inside the original total deadline').toBe(2)
  } finally {
    timeout.mockRestore()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  }
})

it.each(['discovery', 'exchange'])(
  'aborts the in-flight cloud %s without starting another hop',
  async (stage) => {
    const controller = new AbortController()
    let markStarted!: (signal: AbortSignal) => void
    const started = new Promise<AbortSignal>((resolve) => {
      markStarted = resolve
    })
    const origin = 'https://8443-fixture.ap-shanghai.tencentags.com'
    const store = {
      read: async () => ({
        version: 1 as const,
        kind: 'api-key' as const,
        provider: 'generic',
        label: 'fixture',
        value: 'agh_sk_synthetic',
      }),
    }
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const discovery = String(url).endsWith('/connection')
      if (stage === 'exchange' && discovery)
        return Response.json({ code: 200, data: { sandbox_url: origin, traffic_token: 'fixture' } })
      const signal = init?.signal
      if (!signal) throw Error('missing abort signal')
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        markStarted(signal)
      })
    })
    const input = { credentialRef: 'secret://generic/11111111-1111-1111-1111-111111111111', origin }
    const result = authorizeCloudConnection(input, store, fetcher, controller.signal)
    const rejection = expect(result).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
    const upstream = await started
    controller.abort()
    expect(upstream.aborted).toBe(true)
    await rejection
    expect(fetcher).toHaveBeenCalledTimes(stage === 'discovery' ? 1 : 2)
  },
)

it.each(['full-access', 'workspace-write'])(
  'retains the credential administration confirmation boundary under %s',
  async (policy) => {
    const scratch = await mkdtemp(join(tmpdir(), 'agh-credential-permission-'))
    // The existing credential writer creates a fresh private home; it refuses broad pre-existing ACLs.
    const home = join(scratch, 'home')
    const actor = { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} }
    try {
      const onDeleted = vi.fn()
      const admin = createCredentialAdmin({
        home,
        dataDir: join(home, 'data'),
        configurations: async () => [],
        writableStore: async () => true,
        onDeleted,
      })
      const created = (await admin.call(
        'create',
        { label: 'Fixture', value: 'synthetic-test-value' },
        actor.id,
      )) as { id: string }
      const context = { sessionKey: 's', sessionId: 'backend', epoch: 0, policy, actor }
      const change = admin.call('delete', { id: created.id, force: true }, actor.id, {
        context,
        current: async () => context,
      })
      if (policy === 'full-access') {
        await expect(change).resolves.toEqual({})
        expect(onDeleted).toHaveBeenCalledExactlyOnceWith(created.id)
        expect(await admin.call('list', {}, actor.id)).toEqual({ items: [] })
        const audit = (await readFile(join(home, 'data/audit/credentials.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(audit.at(-1).detail).toMatchObject({
          action: 'delete',
          reason: 'full-access',
          answeredBy: { role: 'system' },
        })
        expect(JSON.stringify(audit)).not.toContain('synthetic-test-value')
      } else {
        await expect(change).rejects.toMatchObject({
          data: { reason: 'CONFIG_CREDENTIAL_CONFIRMATION_REQUIRED' },
        })
        expect(await admin.call('list', {}, actor.id)).toMatchObject({ items: [{ id: created.id }] })
        expect(onDeleted).not.toHaveBeenCalled()
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  },
)
