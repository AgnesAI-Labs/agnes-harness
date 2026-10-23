import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemorySessionWorkspaces } from '@agnes/daemon-foundation/storage/lister'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import { resolveWorkspaceDirectory } from '@agnes/host'
import { afterEach, describe, expect, it } from 'vitest'
import { openTestHost } from './host.js'

const request = (id: number, method: string, params: unknown) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  params,
})
const init = request(1, 'initialize', {
  protocolVersion: 1,
  clientCapabilities: {},
  _meta: { 'ai.agnes.harness': { clientId: 'extra-dirs-test' } },
})

const temps: string[] = []
const temp = (): string => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-rpc-extra-')))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function fixture(guarded: boolean) {
  const host = await openTestHost()
  const lib = temp()
  const protectedDir = temp()
  const unregistered = temp()
  const file = join(lib, 'a-file.txt')
  writeFileSync(file, 'x')
  const workspaces = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    resolveWorkspaceDirectory,
    () => Date.now(),
    undefined,
    undefined,
    guarded ? { protectedRoots: [protectedDir] } : undefined,
  )
  await workspaces.add(host.dataDir)
  await workspaces.add(lib)
  await workspaces.add(protectedDir)
  const endpoint = host.endpoint({ workspaces })
  const initialized = await endpoint.handle(init)
  const create = (additionalDirectories: unknown, id = 10) =>
    endpoint.handle(
      request(id, 'session/new', { cwd: host.dataDir, mcpServers: [], additionalDirectories }),
    ) as Promise<{ result?: { sessionId: string }; error?: { data?: { code?: string } } }>
  return {
    host,
    lib,
    file,
    protectedDir,
    unregistered,
    workspaces,
    endpoint,
    initialized,
    create,
    close: async () => {
      await endpoint.close()
      await host.close()
    },
  }
}

describe('session/new additionalDirectories', () => {
  it('advertises the capability only when the catalog can admit extra directories', async () => {
    for (const guarded of [true, false]) {
      const f = await fixture(guarded)
      try {
        const reply = f.initialized as {
          result: { agentCapabilities: { sessionCapabilities?: { additionalDirectories?: object } } }
        }
        expect(reply.result.agentCapabilities.sessionCapabilities?.additionalDirectories !== undefined).toBe(
          guarded,
        )
      } finally {
        await f.close()
      }
    }
  })

  it('refuses a directory the daemon cannot vouch for and creates nothing', async () => {
    const f = await fixture(true)
    try {
      const cases: Array<[string, unknown, string]> = [
        ['unregistered', [f.unregistered], 'WORKSPACE_NOT_FOUND'],
        ['missing', [join(f.lib, 'missing')], 'EXTRA_DIRECTORY_REFUSED'],
        ['a file', [f.file], 'EXTRA_DIRECTORY_REFUSED'],
        ['relative', ['relative/dir'], 'EXTRA_DIRECTORY_REFUSED'],
        ['protected', [f.protectedDir], 'EXTRA_DIRECTORY_REFUSED'],
        ['an ancestor of a protected path', [join(f.protectedDir, '..')], 'EXTRA_DIRECTORY_REFUSED'],
        ['too many', Array.from({ length: 9 }, () => f.lib), 'EXTRA_DIRECTORY_REFUSED'],
      ]
      let id = 20
      for (const [name, dirs, code] of cases)
        await expect(f.create(dirs, id++), name).resolves.toMatchObject({ error: { data: { code } } })
      const listed = (await f.endpoint.handle(request(99, '_agnes/v1/session.list', { limit: 10 }))) as {
        result: { items: unknown[] }
      }
      expect(listed.result.items).toEqual([])
    } finally {
      await f.close()
    }
  })

  it('refuses extra directories outright when the daemon does not advertise the capability', async () => {
    const f = await fixture(false)
    try {
      await expect(f.create([f.lib])).resolves.toMatchObject({
        error: { data: { code: 'EXTRA_DIRECTORY_REFUSED' } },
      })
    } finally {
      await f.close()
    }
  })

  it('binds a registered directory to a fresh session, and load asserts the same list or none', async () => {
    const f = await fixture(true)
    try {
      const created = await f.create([f.lib, f.lib])
      const sessionId = created.result?.sessionId
      if (!sessionId) throw new Error(`session/new failed: ${JSON.stringify(created)}`)
      expect(sessionId).toContain(':dirs:')
      expect((await f.workspaces.restoreBinding(sessionId)).extraRoots).toEqual([f.lib])
      const load = (additionalDirectories?: string[], id = 30) =>
        f.endpoint.handle(
          request(id, 'session/load', {
            sessionId,
            cwd: f.host.dataDir,
            mcpServers: [],
            ...(additionalDirectories ? { additionalDirectories } : {}),
          }),
        )
      await expect(load([f.protectedDir], 31)).resolves.toMatchObject({
        error: { data: { code: 'ID_CONFLICT' } },
      })
      await expect(load([], 32)).resolves.not.toHaveProperty('error')
      await expect(load([f.lib], 33)).resolves.not.toHaveProperty('error')
    } finally {
      await f.close()
    }
  })
})
