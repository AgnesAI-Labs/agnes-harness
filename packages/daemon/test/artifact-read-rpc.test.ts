import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createAuthenticatedArtifactReadHandler } from '../src/local/artifact-read.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { type ArtifactReadScopeAuthority, registerArtifactRead } from '../src/local/methods/artifacts.js'
import { openTestHost } from './host.js'

const bytes = new TextEncoder().encode('authenticated artifact bytes')
const artifact = Object.freeze({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.byteLength,
  mime: 'image/png',
})

function rpc(
  overrides: {
    principalId?: string
    authKind?: 'local' | 'jwt'
    scope?: ArtifactReadScopeAuthority['resolve']
    read?: ReturnType<typeof createAuthenticatedArtifactReadHandler>
    scopeTimeoutMs?: number
    readTimeoutMs?: number
  } = {},
) {
  const principalId = overrides.principalId ?? 'owner-a'
  const endpoint = new LocalEndpoint({ clock: () => 1, principalId })
  endpoint.conn.initialized = true
  endpoint.conn.authKind = overrides.authKind ?? 'jwt'
  const scope =
    overrides.scope ??
    vi.fn(async (target: { sessionId: string; laneId: string }) => ({
      sessionId: target.sessionId,
      laneId: target.laneId,
    }))
  const authority = {
    resolve: vi.fn(async () => ({
      sessionId: 'session-a',
      laneId: 'lane-a',
      ownerId: principalId,
      artifact,
    })),
  }
  const artifacts = { get: vi.fn(async () => bytes) }
  const read =
    overrides.read ??
    createAuthenticatedArtifactReadHandler({
      authority,
      artifacts,
      limits: { maxArtifactBytes: 4 * 1024 * 1024, maxResponseBytes: 1024 * 1024 },
      operationTimeoutMs: 1_000,
    })
  registerArtifactRead(endpoint, {
    read,
    scope: { resolve: scope },
    scopeTimeoutMs: overrides.scopeTimeoutMs ?? 1_000,
    ...(overrides.readTimeoutMs === undefined ? {} : { readTimeoutMs: overrides.readTimeoutMs }),
  })
  const call = (params: Record<string, unknown>) =>
    endpoint.handle({
      jsonrpc: '2.0',
      id: 'read-1',
      method: '_agnes/v1/artifact.read',
      params,
    })
  return { endpoint, call, scope, authority, artifacts, read }
}

const request = Object.freeze({ sessionId: 'session-a', laneId: 'lane-a', artifact })

describe('authenticated artifact read RPC', () => {
  it('fails endpoint startup instead of advertising a malformed optional composition', async () => {
    const opened = await openTestHost()
    expect(() => opened.endpoint({ artifactRead: null as never })).toThrow(
      'artifact read RPC configuration is invalid',
    )
    await opened.close()
  })

  it('is conditionally registered by the real local endpoint composition', async () => {
    const opened = await openTestHost()
    const read = vi.fn(async () => ({
      ok: false as const,
      status: 404 as const,
      code: 'artifact_not_found' as const,
      message: 'Artifact is unavailable.',
    }))
    const endpoint = opened.endpoint({
      artifactRead: {
        read,
        scope: {
          resolve: async (target) => ({ sessionId: target.sessionId, laneId: target.laneId }),
        },
        scopeTimeoutMs: 1_000,
      },
    })
    endpoint.conn.initialized = true
    endpoint.conn.authKind = 'local'
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 'composed-read',
        method: '_agnes/v1/artifact.read',
        params: request,
      }),
    ).resolves.toMatchObject({ result: { ok: false, status: 404, code: 'artifact_not_found' } })
    expect(read).toHaveBeenCalledOnce()
    await endpoint.close()
    await opened.close()
  })

  it('derives the caller from server connection and scope authority, then returns bounded base64', async () => {
    const fixture = rpc()
    const response = await fixture.call({ ...request, range: 'bytes=2-7' })
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 'read-1',
      result: {
        ok: true,
        status: 206,
        artifact,
        acceptRanges: 'bytes',
        contentLength: 6,
        etag: `"${artifact.sha256}"`,
        contentRange: `bytes 2-7/${artifact.size}`,
        base64: Buffer.from(bytes.slice(2, 8)).toString('base64'),
      },
    })
    expect(fixture.scope).toHaveBeenCalledWith(
      {
        principalId: 'owner-a',
        authKind: 'jwt',
        sessionId: 'session-a',
        laneId: 'lane-a',
      },
      expect.any(AbortSignal),
    )
    expect(fixture.authority.resolve).toHaveBeenCalledWith(
      'session-a',
      'lane-a',
      artifact.sha256,
      expect.any(AbortSignal),
    )
  })

  it('never accepts owner, path or timeout authority from the request', async () => {
    const fixture = rpc()
    for (const injected of [{ ownerId: 'owner-b' }, { path: '/tmp/secret' }, { timeoutMs: 60_000 }]) {
      const response = await fixture.call({ ...request, ...injected })
      expect(response).toMatchObject({ error: { code: -32602 } })
    }
    expect(fixture.scope).not.toHaveBeenCalled()
    expect(fixture.authority.resolve).not.toHaveBeenCalled()
    expect(fixture.artifacts.get).not.toHaveBeenCalled()
  })

  it('fails before reading bytes when server scope authentication denies or drifts', async () => {
    const denied = rpc({ scope: vi.fn(async () => undefined) })
    await expect(denied.call(request)).resolves.toMatchObject({
      result: { ok: false, status: 403, code: 'artifact_forbidden' },
    })
    expect(denied.authority.resolve).not.toHaveBeenCalled()

    const drifted = rpc({
      scope: vi.fn(async () => ({ sessionId: 'session-a', laneId: 'lane-b' })),
    })
    await expect(drifted.call(request)).resolves.toMatchObject({
      result: { ok: false, status: 403, code: 'artifact_forbidden' },
    })
    expect(drifted.authority.resolve).not.toHaveBeenCalled()
  })

  it('does not expose scope or read exceptions and refuses unauthenticated connections', async () => {
    const broken = rpc({
      scope: vi.fn(async () => {
        throw new Error('Bearer sk-scope-secret')
      }),
    })
    const first = await broken.call(request)
    expect(first).toMatchObject({
      result: { ok: false, status: 500, code: 'artifact_unavailable' },
    })
    expect(JSON.stringify(first)).not.toContain('secret')

    const read = vi.fn(async () => {
      throw new Error('Bearer sk-store-secret')
    })
    const readBroken = rpc({ read: read as never })
    const second = await readBroken.call(request)
    expect(second).toMatchObject({
      result: { ok: false, status: 500, code: 'artifact_unavailable' },
    })
    expect(JSON.stringify(second)).not.toContain('secret')

    const unauthenticated = rpc()
    delete unauthenticated.endpoint.conn.authKind
    await expect(unauthenticated.call(request)).resolves.toMatchObject({
      result: { ok: false, status: 401, code: 'authentication_required' },
    })
    expect(unauthenticated.scope).not.toHaveBeenCalled()
  })

  it('bounds scope lookup time and the encoded response before allocation', async () => {
    const timedOut = rpc({
      scope: vi.fn(
        (_target, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Bearer late secret')), { once: true })
          }),
      ),
      scopeTimeoutMs: 5,
    })
    await expect(timedOut.call(request)).resolves.toMatchObject({
      result: { ok: false, status: 500, code: 'artifact_unavailable' },
    })

    const body = new Uint8Array(1024 * 1024 + 1)
    const oversized = rpc({
      read: vi.fn(async () => ({
        ok: true as const,
        status: 200 as const,
        artifact: { ...artifact, size: body.byteLength },
        headers: {
          acceptRanges: 'bytes' as const,
          contentLength: body.byteLength,
          contentType: artifact.mime,
          etag: `"${artifact.sha256}"`,
        },
        body,
      })) as never,
    })
    await expect(
      oversized.call({ ...request, artifact: { ...artifact, size: body.byteLength } }),
    ).resolves.toMatchObject({
      result: { ok: false, status: 413, code: 'artifact_too_large' },
    })
  })

  it('owns the read deadline, aborts the read signal and contains late secret failures', async () => {
    let readSignal: AbortSignal | undefined
    const read = vi.fn(
      async (_request: unknown, _caller: unknown, signal?: AbortSignal) =>
        await new Promise((_resolve, reject) => {
          readSignal = signal
          signal?.addEventListener('abort', () => reject(new Error('Bearer sk-late-read-secret')), {
            once: true,
          })
        }),
    )
    const fixture = rpc({ read: read as never, readTimeoutMs: 5 })
    const response = await fixture.call(request)
    expect(response).toMatchObject({
      result: { ok: false, status: 500, code: 'artifact_unavailable' },
    })
    expect(readSignal?.aborted).toBe(true)
    expect(JSON.stringify(response)).not.toContain('secret')
  })

  it('snapshots hostile results without invoking accessors, traps or coercion', async () => {
    const getter = vi.fn(() => true)
    const accessor = { status: 200, artifact, headers: {}, body: bytes } as Record<string, unknown>
    Object.defineProperty(accessor, 'ok', { enumerable: true, get: getter })
    const trap = vi.fn(() => {
      throw new Error('Bearer sk-result-proxy-secret')
    })
    const promiseConstructor = vi.fn(() => Promise)
    const poisonedPromise = Promise.resolve(accessor)
    Object.defineProperty(poisonedPromise, 'constructor', {
      configurable: true,
      get: promiseConstructor,
    })
    for (const readResult of [
      async () => accessor,
      () => new Proxy({}, { get: trap }),
      () => poisonedPromise,
    ]) {
      const fixture = rpc({ read: readResult as never })
      const response = await fixture.call(request)
      const encoded = JSON.stringify(response)
      expect(encoded).toContain('"status":500')
      expect(encoded).toContain('"code":"artifact_unavailable"')
      expect(encoded).not.toContain('secret')
    }
    expect(getter).not.toHaveBeenCalled()
    expect(trap).not.toHaveBeenCalled()
    expect(promiseConstructor).not.toHaveBeenCalled()
  })

  it('accepts only an ordinary bounded Uint8Array and copies it through intrinsics', async () => {
    class ByteSubclass extends Uint8Array {}
    const detached = Uint8Array.from(bytes)
    structuredClone(detached.buffer, { transfer: [detached.buffer] })
    const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength))
    shared.set(bytes)
    for (const body of [
      Buffer.from(bytes),
      new ByteSubclass(bytes),
      new Proxy(Uint8Array.from(bytes), {}),
      detached,
      shared,
    ]) {
      const fixture = rpc({
        read: vi.fn(async () => ({
          ok: true,
          status: 200,
          artifact,
          headers: {
            acceptRanges: 'bytes',
            contentLength: bytes.byteLength,
            contentType: artifact.mime,
            etag: `"${artifact.sha256}"`,
          },
          body,
        })) as never,
      })
      await expect(fixture.call(request)).resolves.toMatchObject({
        result: { ok: false, status: 500, code: 'artifact_unavailable' },
      })
    }

    const source = Uint8Array.from(bytes)
    const fixture = rpc({
      read: vi.fn(async () => ({
        ok: true,
        status: 200,
        artifact,
        headers: {
          acceptRanges: 'bytes',
          contentLength: source.byteLength,
          contentType: artifact.mime,
          etag: `"${artifact.sha256}"`,
        },
        body: source,
      })) as never,
    })
    const response = await fixture.call(request)
    source.fill(0)
    expect(response).toMatchObject({
      result: { ok: true, base64: Buffer.from(bytes).toString('base64') },
    })
  })

  it('binds success to the requested identity and exact response headers and range math', async () => {
    const base = {
      ok: true as const,
      status: 200 as const,
      artifact,
      headers: {
        acceptRanges: 'bytes' as const,
        contentLength: bytes.byteLength,
        contentType: artifact.mime,
        etag: `"${artifact.sha256}"`,
      },
      body: Uint8Array.from(bytes),
    }
    const variants = [
      { ...base, artifact: { ...artifact, size: artifact.size + 1 } },
      { ...base, artifact: { ...artifact, mime: 'image/jpeg' } },
      { ...base, artifact: { ...artifact, sha256: 'f'.repeat(64) } },
      { ...base, headers: { ...base.headers, acceptRanges: 'items' } },
      { ...base, headers: { ...base.headers, contentType: 'image/jpeg' } },
      { ...base, headers: { ...base.headers, etag: `"${'f'.repeat(64)}"` } },
      { ...base, headers: { ...base.headers, contentLength: bytes.byteLength - 1 } },
      {
        ...base,
        body: new Uint8Array(bytes.length).fill(7),
      },
    ]
    for (const result of variants) {
      const fixture = rpc({ read: vi.fn(async () => result) as never })
      await expect(fixture.call(request)).resolves.toMatchObject({
        result: { ok: false, status: 500, code: 'artifact_unavailable' },
      })
    }

    for (const result of [
      { ...base, status: 206 as const, body: Uint8Array.from(bytes.slice(0, 4)) },
      {
        ...base,
        status: 206 as const,
        headers: { ...base.headers, contentLength: 4, contentRange: `bytes 1-4/${artifact.size}` },
        body: Uint8Array.from(bytes.slice(0, 4)),
      },
    ]) {
      const fixture = rpc({ read: vi.fn(async () => result) as never })
      await expect(fixture.call({ ...request, range: 'bytes=0-3' })).resolves.toMatchObject({
        result: { ok: false, status: 500, code: 'artifact_unavailable' },
      })
    }
  })

  it('accepts only the fixed primitive failure status/code/message tuple', async () => {
    for (const result of [
      {
        ok: false,
        status: 404,
        code: 'artifact_forbidden',
        message: 'Artifact access is denied.',
      },
      {
        ok: false,
        status: 403,
        code: 'artifact_forbidden',
        message: 'Bearer sk-forged-message',
      },
    ]) {
      const fixture = rpc({ read: vi.fn(async () => result) as never })
      const response = await fixture.call(request)
      expect(response).toMatchObject({
        result: { ok: false, status: 500, code: 'artifact_unavailable' },
      })
      expect(JSON.stringify(response)).not.toContain('forged')
    }
  })

  it('passes a reclaimed screenshot through as 410 with the fixed tuple only', async () => {
    const reclaimed = {
      ok: false,
      status: 410,
      code: 'artifact_reclaimed',
      message: 'Artifact was removed by the retention policy.',
    }
    const fixture = rpc({ read: vi.fn(async () => reclaimed) as never })
    await expect(fixture.call(request)).resolves.toMatchObject({
      result: { ok: false, status: 410, code: 'artifact_reclaimed' },
    })
    const forged = rpc({ read: vi.fn(async () => ({ ...reclaimed, status: 404 })) as never })
    await expect(forged.call(request)).resolves.toMatchObject({
      result: { ok: false, status: 500, code: 'artifact_unavailable' },
    })
  })

  it('fails closed when an injected read implementation mismatches status and content range', async () => {
    for (const result of [
      {
        ok: true as const,
        status: 200 as const,
        artifact,
        headers: {
          acceptRanges: 'bytes' as const,
          contentLength: bytes.byteLength,
          contentType: artifact.mime,
          etag: `"${artifact.sha256}"`,
          contentRange: `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}`,
        },
        body: bytes,
      },
      {
        ok: true as const,
        status: 206 as const,
        artifact,
        headers: {
          acceptRanges: 'bytes' as const,
          contentLength: bytes.byteLength,
          contentType: artifact.mime,
          etag: `"${artifact.sha256}"`,
        },
        body: bytes,
      },
    ]) {
      const fixture = rpc({ read: vi.fn(async () => result) as never })
      await expect(fixture.call(request)).resolves.toMatchObject({
        result: { ok: false, status: 500, code: 'artifact_unavailable' },
      })
    }
  })

  it('snapshots RPC capabilities and rejects accessors, proxies and invalid timeouts', () => {
    const endpoint = new LocalEndpoint({ clock: () => 1, principalId: 'owner-a' })
    const read = vi.fn()
    const resolve = vi.fn()
    const getter = vi.fn(() => read)
    const accessor = { scope: { resolve }, scopeTimeoutMs: 1_000 } as Record<string, unknown>
    Object.defineProperty(accessor, 'read', { enumerable: true, get: getter })
    expect(() => registerArtifactRead(endpoint, accessor as never)).toThrow(TypeError)
    expect(getter).not.toHaveBeenCalled()
    expect(() =>
      registerArtifactRead(endpoint, {
        read: new Proxy(read, {}),
        scope: { resolve },
        scopeTimeoutMs: 1_000,
      } as never),
    ).toThrow(TypeError)
    for (const scopeTimeoutMs of [0, 60_001, Number.POSITIVE_INFINITY])
      expect(() =>
        registerArtifactRead(endpoint, { read, scope: { resolve }, scopeTimeoutMs } as never),
      ).toThrow(TypeError)
    for (const readTimeoutMs of [0, 60_001, Number.POSITIVE_INFINITY])
      expect(() =>
        registerArtifactRead(endpoint, {
          read,
          scope: { resolve },
          scopeTimeoutMs: 1_000,
          readTimeoutMs,
        } as never),
      ).toThrow(TypeError)
  })
})
