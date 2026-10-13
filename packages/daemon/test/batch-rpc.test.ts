import type { BatchStatus } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { signSourceAuth, sourceAuthCanonical } from '../src/local/auth.js'
import type { BatchPort } from '../src/local/ports.js'
import { openTestHost } from './host.js'

const initialize = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
}
const status: BatchStatus = {
  batchId: 'b0123456789ab',
  status: 'running',
  dir: 'images',
  outDir: 'agh-batch/b0123456789ab',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  counts: { total: 1, pending: 1, running: 0, done: 0, invalid: 0, failed: 0, skipped: 0, cancelled: 0 },
  spentCredits: 0,
}

describe('batch RPC', () => {
  it('forwards start, status, cancel and list with the connection principal', async () => {
    const opened = await openTestHost()
    const batch: BatchPort = {
      start: vi.fn(async () => status),
      status: vi.fn(async () => status),
      cancel: vi.fn(async () => ({ ...status, status: 'cancelled' as const })),
      list: vi.fn(async () => [status]),
    }
    const endpoint = opened.endpoint({ batch })
    await endpoint.handle(initialize)
    const spec = { dir: 'images', prompt: 'Count {{name}}' }
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 2,
        method: '_agnes/v1/batch.start',
        params: { cwd: opened.dataDir, spec },
      }),
    ).resolves.toMatchObject({ result: { batchId: 'b0123456789ab' } })
    expect(batch.start).toHaveBeenCalledWith({ principalId: expect.any(String), cwd: opened.dataDir, spec })
    await endpoint.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/batch.status',
      params: { batchId: 'b0123456789ab', export: true },
    })
    expect(batch.status).toHaveBeenCalledWith({
      principalId: expect.any(String),
      batchId: 'b0123456789ab',
      export: true,
    })
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 4,
        method: '_agnes/v1/batch.cancel',
        params: { batchId: 'b0123456789ab' },
      }),
    ).resolves.toMatchObject({ result: { status: 'cancelled' } })
    await expect(
      endpoint.handle({ jsonrpc: '2.0', id: 5, method: '_agnes/v1/batch.list', params: {} }),
    ).resolves.toMatchObject({
      result: { items: [{ batchId: 'b0123456789ab' }] },
    })
    await endpoint.close()
    await opened.close()
  })

  it('fails closed without a batch engine and rejects malformed params before the engine', async () => {
    const opened = await openTestHost()
    const endpoint = opened.endpoint()
    await endpoint.handle(initialize)
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 2,
        method: '_agnes/v1/batch.status',
        params: { batchId: 'b0123456789ab' },
      }),
    ).resolves.toMatchObject({ error: { code: -32006 } })
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 3,
        method: '_agnes/v1/batch.status',
        params: { batchId: '../x' },
      }),
    ).resolves.toMatchObject({ error: expect.anything() })
    await endpoint.close()
    await opened.close()
  })

  it('serves the local owner only: remote connections are refused and are not told the methods exist', async () => {
    const methods = [
      ['_agnes/v1/batch.start', { cwd: '/w', spec: { dir: 'images', prompt: 'x' } }],
      ['_agnes/v1/batch.status', { batchId: 'b0123456789ab' }],
      ['_agnes/v1/batch.cancel', { batchId: 'b0123456789ab' }],
      ['_agnes/v1/batch.list', {}],
    ] as const
    const families = async (endpoint: ReturnType<Awaited<ReturnType<typeof openTestHost>>['endpoint']>) =>
      (
        (await endpoint.handle({ jsonrpc: '2.0', id: 90, method: '_agnes/v1/apis.list', params: {} })) as {
          result: { families: Array<{ name: string; methods: string[] }> }
        }
      ).result.families
    // A remote connection authenticated by a signed source credential (as a channel bridge is).
    const now = 1_700_000_000_000
    const secret = ['batch', 'source', 'fixture'].join('-')
    const clientId = 'u1'
    const timestamp = Math.floor(now / 1000)
    const nonce = 'b'.repeat(32)
    const unsignedParams = { ...initialize.params, _meta: { 'ai.agnes.harness': { clientId } } }
    const auth = {
      kind: 'source-auth' as const,
      timestamp,
      nonce,
      signature: signSourceAuth(secret, timestamp, nonce, sourceAuthCanonical(clientId, unsignedParams)),
    }
    {
      const opened = await openTestHost()
      const batch: BatchPort = {
        start: vi.fn(async () => status),
        status: vi.fn(async () => status),
        cancel: vi.fn(async () => status),
        list: vi.fn(async () => [status]),
      }
      const endpoint = opened.endpoint({
        batch,
        // Deliberately stale: the verified credential decides, not this construction-time label.
        identity: { principalId: 'channel:u1', authKind: 'local', credentialKind: 'local' },
        auth: {
          config: { transport: 'ws', sourceAuthKeys: () => [{ secret, keyId: 'batch-source-key' }] },
          nonces: { consume: () => true },
          clock: () => now,
        },
      })
      await endpoint.handle({
        ...initialize,
        params: { ...unsignedParams, _meta: { 'ai.agnes.harness': { clientId, auth } } },
      })
      expect(endpoint.conn).toMatchObject({ authKind: 'source-auth', credentialKind: 'channel' })
      let id = 10
      for (const [method, params] of methods)
        await expect(endpoint.handle({ jsonrpc: '2.0', id: id++, method, params })).resolves.toMatchObject({
          error: { code: -32006 },
        })
      expect(batch.start).not.toHaveBeenCalled()
      expect(batch.status).not.toHaveBeenCalled()
      expect(batch.cancel).not.toHaveBeenCalled()
      expect(batch.list).not.toHaveBeenCalled()
      expect((await families(endpoint)).map((family) => family.name)).not.toContain('batch')
      await endpoint.close()
      await opened.close()
    }
    // The loopback Web listener authenticates as the local owner too, but it is not the local socket.
    {
      const opened = await openTestHost()
      const batch: BatchPort = {
        start: vi.fn(async () => status),
        status: vi.fn(async () => status),
        cancel: vi.fn(async () => status),
        list: vi.fn(async () => [status]),
      }
      const endpoint = opened.endpoint({
        batch,
        auth: {
          config: { transport: 'ws', localWeb: true },
          nonces: { consume: () => true },
          clock: Date.now,
        },
      })
      await endpoint.handle(initialize)
      expect(endpoint.conn).toMatchObject({ authKind: 'local' })
      let id = 30
      for (const [method, params] of methods)
        await expect(endpoint.handle({ jsonrpc: '2.0', id: id++, method, params })).resolves.toMatchObject({
          error: { code: -32006 },
        })
      expect(batch.list).not.toHaveBeenCalled()
      expect((await families(endpoint)).map((family) => family.name)).not.toContain('batch')
      await endpoint.close()
      await opened.close()
    }
    // The local owner sees the family only when the daemon runs a batch engine.
    const opened = await openTestHost()
    const withEngine = opened.endpoint({
      batch: { start: vi.fn(), status: vi.fn(), cancel: vi.fn(), list: vi.fn() } as unknown as BatchPort,
    })
    await withEngine.handle(initialize)
    expect((await families(withEngine)).find((family) => family.name === 'batch')?.methods).toEqual(
      methods.map(([method]) => method),
    )
    const without = opened.endpoint()
    await without.handle(initialize)
    expect((await families(without)).map((family) => family.name)).not.toContain('batch')
    await withEngine.close()
    await without.close()
    await opened.close()
  })

  it('names the connection principal, never one from the request', async () => {
    const opened = await openTestHost()
    const batch: BatchPort = {
      start: vi.fn(async () => status),
      status: vi.fn(async () => status),
      cancel: vi.fn(async () => status),
      list: vi.fn(async () => []),
    }
    const endpoint = opened.endpoint({ batch })
    await endpoint.handle(initialize)
    // Unknown fields (a principal among them) are refused by the schema before the engine is asked.
    await expect(
      endpoint.handle({
        jsonrpc: '2.0',
        id: 2,
        method: '_agnes/v1/batch.status',
        params: { batchId: 'b0123456789ab', principalId: 'someone-else' },
      }),
    ).resolves.toMatchObject({ error: expect.anything() })
    expect(batch.status).not.toHaveBeenCalled()
    await endpoint.handle({ jsonrpc: '2.0', id: 3, method: '_agnes/v1/batch.list', params: {} })
    expect(batch.list).toHaveBeenCalledWith({ principalId: 'local' })
    await endpoint.close()
    await opened.close()
  })
})
