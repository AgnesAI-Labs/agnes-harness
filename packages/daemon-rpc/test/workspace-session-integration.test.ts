import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
import { openTestHost, testWorkspaceCatalogAt } from './host.js'

const request = (id: number, method: string, params: unknown) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  params,
})

const init = request(1, 'initialize', {
  protocolVersion: 1,
  clientCapabilities: {},
  _meta: { 'ai.agnes.harness': { clientId: 'workspace-test' } },
})

describe('workspace session integration', () => {
  it('canonicalizes, binds, counts and filters one idempotent new session', async () => {
    const fixture = await openTestHost()
    const clock = () => Date.parse('2026-09-13T00:00:00.000Z')
    const endpoint = createLocalEndpoint(fixture.host, {
      clock,
      workspaces: await testWorkspaceCatalogAt(clock),
    })
    const other = join(fixture.dataDir, 'other')
    await mkdir(other)
    try {
      await endpoint.handle(init)
      const registered = await endpoint.handle(
        request(2, '_agnes/v1/workspace.add', { path: fixture.dataDir }),
      )
      const canonical = (registered as { result?: { workspace?: { path?: string } } }).result?.workspace?.path
      expect(canonical).toEqual(expect.any(String))
      if (!canonical) throw new Error('workspace.add did not return a canonical path')
      const params = {
        cwd: fixture.dataDir,
        mcpServers: [],
        _meta: { 'ai.agnes.harness': { sessionKey: 'agnes:workspace:request-1' } },
      }
      const first = await endpoint.handle(request(3, 'session/new', params))
      const retry = await endpoint.handle(request(4, 'session/new', params))
      expect(retry).toEqual({ ...first, id: 4 })

      const registeredOther = (await endpoint.handle(
        request(41, '_agnes/v1/workspace.add', { path: other }),
      )) as { result?: { workspace?: { path?: string } } }
      const canonicalOther = registeredOther.result?.workspace?.path
      if (!canonicalOther) throw new Error('second workspace.add did not return a canonical path')

      await expect(
        endpoint.handle(request(5, 'session/new', { ...params, cwd: other })),
      ).resolves.toMatchObject({
        error: { code: -32011, data: { code: 'ID_CONFLICT' } },
      })

      const listed = (await endpoint.handle(request(6, '_agnes/v1/workspace.list', {}))) as {
        result: { items: unknown[] }
      }
      expect(listed.result.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: canonical,
            lastUsedAt: '2026-09-13T00:00:00.000Z',
            sessionCount: 1,
            available: true,
          }),
          expect.objectContaining({
            path: canonicalOther,
            lastUsedAt: null,
            sessionCount: 0,
            available: true,
          }),
        ]),
      )
      await expect(
        endpoint.handle(request(7, '_agnes/v1/session.list', { q: { cwd: canonical }, limit: 10 })),
      ).resolves.toMatchObject({
        result: { items: [{ sessionId: 'agnes:workspace:request-1', cwd: canonical }] },
      })
      await expect(
        endpoint.handle(request(8, '_agnes/v1/session.list', { q: { cwd: other }, limit: 10 })),
      ).resolves.toMatchObject({ result: { items: [] } })
    } finally {
      await endpoint.close()
      await fixture.close()
    }
  })

  it('reports a missing directory without replacing it with the process cwd', async () => {
    const fixture = await openTestHost()
    const endpoint = fixture.endpoint()
    try {
      await endpoint.handle(init)
      await expect(
        endpoint.handle(request(2, '_agnes/v1/workspace.add', { path: join(fixture.dataDir, 'missing') })),
      ).resolves.toMatchObject({
        error: { code: -32011, data: { code: 'WORKSPACE_INVALID', reason: 'not-found' } },
      })
    } finally {
      await endpoint.close()
      await fixture.close()
    }
  })
})
