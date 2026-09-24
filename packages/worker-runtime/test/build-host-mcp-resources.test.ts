import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { HostOptions } from '@agnes/host'
import { afterEach, expect, it, vi } from 'vitest'

const captured = vi.hoisted(() => ({ options: undefined as HostOptions | undefined }))
vi.mock('@agnes/host', async () => {
  const actual = await vi.importActual<typeof import('@agnes/host')>('@agnes/host')
  return {
    ...actual,
    createHost: vi.fn(async (_profile, options) => {
      captured.options = options
      throw new Error('capture-default')
    }),
  }
})

import { runWorker, type WorkerHostSkillResources } from '../src/main.js'

const roots: string[] = []
afterEach(async () => {
  captured.options = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

for (const mode of ['empty', 'disabled', 'untrusted'] as const) {
  for (const custom of [true, false]) {
    it(`gives Host no MCP input for a ${mode} snapshot in ${custom ? 'custom' : 'default'} Host assembly`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'mc1-'))
      roots.push(root)
      const profile = join(root, 'profile.json'),
        snapshot = join(root, 'snapshot.json')
      await mkdir(join(root, 'cache'))
      await writeFile(
        profile,
        JSON.stringify({
          name: 'local-dev',
          dataDir: root,
          cacheDir: join(root, 'cache'),
          adapters: { secrets: { kind: 'env' } },
          packages: [],
          hash: `sha256-${'0'.repeat(64)}`,
          preset: {
            mcp: { servers: [{ id: 'legacy', transport: 'stdio', cmd: ['/never-connect-legacy'] }] },
          },
        }),
      )
      await writeFile(
        snapshot,
        JSON.stringify({
          version: 1,
          mcpAuthority: 'resource-control',
          skills: { control: { desired: [], trust: [] } },
          mcp:
            mode === 'empty'
              ? []
              : [
                  {
                    definition: {
                      serverId: 'blocked',
                      displayName: 'Blocked',
                      transport: { kind: 'stdio', executable: '/never-connect-managed', args: [] },
                      secretBinding: { kind: 'none' },
                      toolPolicy: { allow: ['echo'] },
                    },
                    revision: 'a'.repeat(64),
                    desired: mode === 'disabled' ? 'disabled' : 'enabled',
                    trust: mode === 'untrusted' ? 'untrusted' : 'trusted',
                  },
                ],
        }),
      )
      let resources: WorkerHostSkillResources | undefined
      await expect(
        runWorker(
          {
            AGNES_WORKER_TOKEN: 'tok',
            AGNES_SUPERVISOR_SOCKET: '/tmp/mc1.sock',
            AGNES_WORKER_KEY: '@shared',
            AGNES_PROFILE_FILE: profile,
            AGNES_WORKER_GENERATION: '1',
            AGNES_WORKER_ROOT: root,
            AGH_HOME: root,
            HOME: root,
            AGNES_RESOURCE_SNAPSHOT: snapshot,
          },
          { connect: async () => new PassThrough(), gate: null },
          custom
            ? {
                buildHost: async (_profile, _prompter, input) => {
                  resources = input
                  throw new Error('capture-custom')
                },
              }
            : {},
        ),
      ).rejects.toThrow(custom ? 'capture-custom' : 'capture-default')
      const options = (custom ? resources : captured.options) as Record<string, unknown> | undefined
      // Whatever the snapshot says (empty, disabled, untrusted), Host never receives MCP input: MCP
      // servers are the session worker's own Host rows (design §3.9, D124), and there is no legacy
      // preset path left for an absent authority marker to fall back to (D113).
      expect(options).toBeDefined()
      expect(options).not.toHaveProperty('mcpResources')
      expect(options).not.toHaveProperty('mcpResourceAuthority')
    })
  }
}
