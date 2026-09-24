import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { expect, it, vi } from 'vitest'
import * as network from '../../src/adapters/public-fetch/network.js'
import { createTestHost } from '../../testkit/index.js'

it.each([false, true])(
  'real Host web_fetch respects authorization (denied=%s)',
  async (denied) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<h1>Public fixture</h1><p>网页正文</p>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const dns = vi
      .spyOn(network, 'resolvePublicAddresses')
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const dataDir = mkdtempSync(join(tmpdir(), 'agnes-web-fetch-'))
    const url = `http://fixture.invalid:${(server.address() as AddressInfo).port}/article`
    const provider = new ScriptedProvider({
      models: [fakeModel({ route: 'gw', id: 'm1' })],
      scripts: [
        (request) => {
          expect(request.tools.map((tool) => tool.name)).toContain('web_fetch')
          return [
            {
              type: 'toolcall_end',
              call: { toolUseId: '', name: 'web_fetch', args: { url }, ordinal: 0 },
              via: 'native',
            },
            { type: 'done', reason: 'toolUse' },
          ]
        },
        (request) => {
          expect(JSON.stringify(request)).toContain(denied ? 'no public read' : 'Public fixture')
          return [
            { type: 'text_delta', delta: 'read page' },
            { type: 'done', reason: 'stop' },
          ]
        },
      ],
      onExhausted: 'error',
    })
    let closeHost: (() => Promise<void>) | undefined
    try {
      const { host } = await createTestHost({
        dataDir,
        env: {},
        provider,
        disableSessionTitle: true,
        ...(denied
          ? {
              seams: {
                principals: {
                  authorize: async (_actor, _action, target) => ({
                    decisionId: 'deny-fetch',
                    effect: target.id === 'web_fetch' ? ('deny' as const) : ('allow' as const),
                    reason: 'no public read',
                  }),
                },
              },
            }
          : {}),
        packageDirs: { '@agnes/base': fileURLToPath(new URL('../../../base', import.meta.url)) },
      })
      closeHost = () => host.close()
      const session = await host.createSession({ cwd: dataDir })
      await session.enqueue('next-turn', {
        content: [{ type: 'text', text: `Read ${url}` }],
        actor: session.d.actor,
        kind: 'prompt',
      })
      expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
        reason: 'completed',
      })
      const rows = await session.scan({ fromSeq: 1, toSeq: session.lastSeq })
      const results = rows.filter((row) => row.type === 'tool/result')
      if (denied) {
        expect(JSON.stringify(results)).toContain('AUTHZ_DENIED')
        expect(dns).not.toHaveBeenCalled()
      } else {
        expect(JSON.stringify(results)).toContain('网页正文')
        expect(JSON.stringify(results)).toContain('untrusted')
        expect(dns).toHaveBeenCalledOnce()
      }
      expect(provider.calls).toHaveLength(2)
    } finally {
      await closeHost?.()
      dns.mockRestore()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      // Verified task-owned temporary directory, never a caller-provided path.
      if (dataDir.startsWith(join(tmpdir(), 'agnes-web-fetch-')))
        rmSync(dataDir, { recursive: true, force: true })
    }
  },
  30_000,
)
