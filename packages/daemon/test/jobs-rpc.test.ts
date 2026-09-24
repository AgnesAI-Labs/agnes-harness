import { describe, expect, it, vi } from 'vitest'
import { signSourceAuth, sourceAuthCanonical } from '../src/local/auth.js'
import type { DirectoryPort, JobsPort } from '../src/local/ports.js'
import { openTestHost } from './host.js'

const initialize = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  },
}

describe('jobs RPC forwarding', () => {
  it('forwards enqueue, poll, and cancel through JobsPort', async () => {
    const opened = await openTestHost()
    const enqueue = vi.fn(async () => ({ jobId: 'j1' }))
    const poll = vi.fn(async () => ({
      jobId: 'j1',
      status: 'waiting' as const,
      attempts: 0,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }))
    const cancel = vi.fn(async () => undefined)
    let jobSession = ''
    const jobs: JobsPort = { enqueue, sessionKey: async () => jobSession, poll, cancel }
    const endpoint = opened.endpoint({ jobs })
    await endpoint.handle(initialize)
    const created = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: opened.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    jobSession = created.result.sessionId

    const spec = {
      idempotencyKey: 'j1',
      sessionKey: jobSession,
      payload: { prompt: 'go' },
      schedule: { kind: 'once' },
    }
    await expect(
      endpoint.handle({ jsonrpc: '2.0', id: 3, method: '_agnes/v1/jobs.enqueue', params: spec }),
    ).resolves.toMatchObject({ result: { jobId: 'j1' } })
    expect(enqueue).toHaveBeenCalledWith(spec, { local: true })
    await expect(
      endpoint.handle({ jsonrpc: '2.0', id: 4, method: '_agnes/v1/jobs.poll', params: { jobId: 'j1' } }),
    ).resolves.toMatchObject({ result: { jobId: 'j1', status: 'waiting' } })
    await expect(
      endpoint.handle({ jsonrpc: '2.0', id: 5, method: '_agnes/v1/jobs.cancel', params: { jobId: 'j1' } }),
    ).resolves.toMatchObject({ result: {} })
    expect(cancel).toHaveBeenCalledWith('j1')
    await endpoint.close()
    await opened.close()
  })

  it('fails closed when no jobs service is installed', async () => {
    const opened = await openTestHost()
    const endpoint = opened.endpoint()
    await endpoint.handle(initialize)
    await expect(
      endpoint.handle({ jsonrpc: '2.0', id: 2, method: '_agnes/v1/jobs.poll', params: { jobId: 'j1' } }),
    ).resolves.toMatchObject({ error: { code: -32006 } })
    await endpoint.close()
    await opened.close()
  })

  it('looks up durable artifact jobs across registered sessions', async () => {
    const opened = await openTestHost()
    const first = opened.endpoint()
    await first.handle(initialize)
    const created = (await first.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: opened.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const sessionId = created.result.sessionId
    await first.close()
    const seeded = await opened.host.createSession({ key: sessionId, cwd: opened.dataDir })
    await seeded.append([
      seeded.ev('artifact/job', { jobId: 'artifact-1', status: 'queued' }, { register: 'artifact/job' }),
    ])
    await seeded.close()

    const endpoint = opened.endpoint()
    await endpoint.handle(initialize)
    await endpoint.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/load',
      params: { sessionId, cwd: opened.dataDir, mcpServers: [] },
    })
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 3,
        method: '_agnes/v1/artifact.job.status',
        params: { jobId: 'artifact-1' },
      }),
    ).resolves.toMatchObject({ result: { jobId: 'artifact-1', status: 'queued' } })
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 4,
        method: '_agnes/v1/artifact.job.status',
        params: { jobId: 'missing' },
      }),
    ).resolves.toMatchObject({ error: { code: -32003, data: { jobId: 'missing' } } })
    await endpoint.close()
    await opened.close()
  })
})

describe('directory RPC forwarding', () => {
  const entries = [{ kind: 'user' as const, id: 'u1', name: 'Ada', syncedAt: '2026-09-11T00:00:00Z' }]

  it('forwards only for a server-authenticated enterprise credential', async () => {
    const opened = await openTestHost()
    const now = 1_700_000_000_000
    const secret = 'directory-source-secret'
    const clientId = 'u1'
    const timestamp = Math.floor(now / 1000)
    const nonce = 'a'.repeat(32)
    const unsignedParams = {
      ...initialize.params,
      _meta: { 'ai.agnes.harness': { clientId } },
    }
    const auth = {
      kind: 'source-auth' as const,
      timestamp,
      nonce,
      signature: signSourceAuth(secret, timestamp, nonce, sourceAuthCanonical(clientId, unsignedParams)),
    }
    const upsert = vi.fn(async () => ({ upserted: 1, deleted: 0 }))
    const directory: DirectoryPort = { upsert }
    const enqueue = vi.fn(async () => ({ jobId: 'source-job' }))
    const endpoint = opened.endpoint({
      directory,
      jobs: {
        enqueue,
        sessionKey: async () => undefined,
        poll: async () => {
          throw new Error('unused')
        },
        cancel: async () => undefined,
      },
      // Deliberately stale: authorization must come from authGate's verified ConnectionState.
      identity: { principalId: 'channel:u1', authKind: 'local', credentialKind: 'local' },
      auth: {
        config: { transport: 'ws', sourceAuthKeys: () => [{ secret, keyId: 'jobs-source-key' }] },
        nonces: { consume: () => true },
        clock: () => now,
      },
    })
    await endpoint.handle({
      ...initialize,
      params: {
        ...unsignedParams,
        _meta: { 'ai.agnes.harness': { clientId, auth } },
      },
    })
    expect(endpoint.conn).toMatchObject({ authKind: 'source-auth', credentialKind: 'channel' })

    const listing = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/apis.list',
      params: {},
    })) as { result: { families: Array<{ methods: string[] }> } }
    const methods = listing.result.families.flatMap((family) => family.methods)
    expect(methods).toContain('_agnes/v1/directory.upsert')
    expect(methods).not.toContain('_agnes/v1/jobs.enqueue')

    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 4,
        method: '_agnes/v1/directory.upsert',
        params: { entries },
      }),
    ).resolves.toMatchObject({ result: { upserted: 1, deleted: 0 } })
    expect(upsert).toHaveBeenCalledWith(entries)
    const owned = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'session/new',
      params: { cwd: opened.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    await endpoint.handle({
      jsonrpc: '2.0',
      id: 6,
      method: '_agnes/v1/jobs.enqueue',
      params: {
        idempotencyKey: 'source-job',
        sessionKey: owned.result.sessionId,
        payload: { prompt: 'go' },
        schedule: { kind: 'once' },
      },
    })
    await endpoint.handle({
      jsonrpc: '2.0',
      id: 7,
      method: '_agnes/v1/submit',
      params: {
        clientId,
        commandId: 'source-submit',
        kind: 'jobs.enqueue',
        payload: {
          idempotencyKey: 'source-submit',
          sessionKey: owned.result.sessionId,
          payload: { prompt: 'go' },
          schedule: { kind: 'once' },
        },
      },
    })
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue).toHaveBeenNthCalledWith(1, expect.anything(), { local: false })
    expect(enqueue).toHaveBeenNthCalledWith(2, expect.anything(), { local: false })
    await endpoint.close()
    await opened.close()
  })

  it('fails closed for local credentials or a missing enterprise sink', async () => {
    for (const options of [
      { directory: { upsert: vi.fn(async () => ({ upserted: 0, deleted: 0 })) } },
      {
        directory: { upsert: vi.fn(async () => ({ upserted: 0, deleted: 0 })) },
        // A construction-time label cannot override the credential initialize actually verified.
        identity: {
          principalId: 'claimed-channel',
          authKind: 'source-auth' as const,
          credentialKind: 'channel' as const,
        },
      },
      {
        identity: { principalId: 'sso:u1', authKind: 'jwt' as const, credentialKind: 'sso' as const },
      },
    ]) {
      const opened = await openTestHost()
      const endpoint = opened.endpoint(options)
      await endpoint.handle(initialize)
      await expect(
        endpoint.handle({
          jsonrpc: '2.0',
          id: 2,
          method: '_agnes/v1/directory.upsert',
          params: { entries },
        }),
      ).resolves.toMatchObject({ error: { code: -32006 } })
      const listing = (await endpoint.handle({
        jsonrpc: '2.0',
        id: 3,
        method: '_agnes/v1/apis.list',
        params: {},
      })) as { result: { families: Array<{ methods: string[] }> } }
      expect(listing.result.families.flatMap((family) => family.methods)).not.toContain(
        '_agnes/v1/directory.upsert',
      )
      await endpoint.close()
      await opened.close()
    }
  })
})

describe('extension UI response RPC', () => {
  it('records the authenticated actor and is durably idempotent by requestSeq', async () => {
    const opened = await openTestHost()
    const endpoint = opened.endpoint({
      identity: { principalId: 'channel:u9', authKind: 'source-auth', credentialKind: 'channel' },
    })
    await endpoint.handle(initialize)
    const created = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: opened.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const params = {
      sessionId: created.result.sessionId,
      requestSeq: 7,
      action: 'accept',
      data: { choice: 'safe' },
    }
    const first = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/ext.ui.response',
      params,
    })) as { result: { seq: number } }
    expect(first).toMatchObject({ result: { seq: expect.any(Number) } })
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 4,
        method: '_agnes/v1/ext.ui.response',
        params,
      }),
    ).resolves.toMatchObject({ result: { seq: first.result.seq } })
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 5,
        method: '_agnes/v1/ext.ui.response',
        params: { ...params, action: 'decline' },
      }),
    ).resolves.toMatchObject({ error: { code: -32011 } })

    await endpoint.close()
    const reopened = await opened.host.createSession({ key: created.result.sessionId, cwd: opened.dataDir })
    const rows = await reopened.scan({ type: 'x/agnes/ui-response', limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor: { id: 'channel:u9' },
      origin: 'principal',
      trust: 'untrusted',
      ignorable: true,
      data: { requestSeq: 7, action: 'accept', data: { choice: 'safe' } },
    })
    await reopened.close()
    await opened.close()
  })

  it('serializes concurrent retries instead of appending the same response twice', async () => {
    const opened = await openTestHost()
    const endpoint = opened.endpoint()
    await endpoint.handle(initialize)
    const created = (await endpoint.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: opened.dataDir, mcpServers: [] },
    })) as { result: { sessionId: string } }
    const request = {
      jsonrpc: '2.0' as const,
      method: '_agnes/v1/ext.ui.response',
      params: {
        sessionId: created.result.sessionId,
        requestSeq: 8,
        action: 'accept',
        data: { choice: 'safe' },
      },
    }

    const [first, retry] = (await Promise.all([
      endpoint.handle({ ...request, id: 3 }),
      endpoint.handle({ ...request, id: 4 }),
    ])) as [{ result: { seq: number } }, { result: { seq: number } }]
    expect(retry.result.seq).toBe(first.result.seq)

    await endpoint.close()
    const reopened = await opened.host.createSession({ key: created.result.sessionId, cwd: opened.dataDir })
    expect(await reopened.scan({ type: 'x/agnes/ui-response', limit: 10 })).toHaveLength(1)
    await reopened.close()
    await opened.close()
  })
})
