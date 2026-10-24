import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemorySessionWorkspaces } from '@agnes/daemon-foundation/storage/lister'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import { type HostSession, resolveWorkspaceDirectory } from '@agnes/host'
import { afterEach, describe, expect, it } from 'vitest'
import { createLocalEndpoint } from '../src/local/index.js'
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
          result: {
            agentCapabilities: {
              sessionCapabilities?: { additionalDirectories?: object }
              _meta: { 'ai.agnes.harness': { forkAdditionalDirectories?: boolean } }
            }
          }
        }
        expect(reply.result.agentCapabilities.sessionCapabilities?.additionalDirectories !== undefined).toBe(
          guarded,
        )
        expect(reply.result.agentCapabilities._meta['ai.agnes.harness'].forkAdditionalDirectories).toBe(
          guarded ? true : undefined,
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

describe('session.fork additionalDirectories', () => {
  async function forkFixture() {
    const f = await fixture(true)
    const [one, two] = [temp(), temp()]
    for (const dir of [one, two]) await f.workspaces.add(dir)
    let opened: HostSession | undefined
    const createSession = f.host.host.createSession.bind(f.host.host)
    const host = new Proxy(f.host.host, {
      get: (target, property, receiver) =>
        property === 'createSession'
          ? async (opts: Parameters<typeof createSession>[0]) => {
              const created = await createSession(opts)
              opened ??= created
              return created
            }
          : Reflect.get(target, property, receiver),
    })
    const endpoint = createLocalEndpoint(host, {
      clock: () => Date.now(),
      pollMs: 5,
      workspaces: f.workspaces,
    })
    await endpoint.handle(init)
    const created = (await endpoint.handle(
      request(10, 'session/new', { cwd: f.host.dataDir, mcpServers: [], additionalDirectories: [one] }),
    )) as { result: { sessionId: string } }
    const parent = created.result.sessionId
    const session = opened as HostSession | undefined
    if (!session) throw new Error('session was not captured')
    const prompt = (text: string) => ({
      actor: session.d.actor,
      content: [{ type: 'text' as const, text }],
      kind: 'prompt' as const,
    })
    await session.enqueue('next-turn', prompt('first'))
    expect(await session.acceptInput()).toBe(true)
    await session.endTurn('completed')
    const [ended] = await session.scan({ type: 'turn/end', order: 'desc', limit: 1 })
    if (!ended) throw new Error('missing completed turn boundary')
    let id = 100
    const fork = (params: Record<string, unknown>) =>
      endpoint.handle(
        request(id++, '_agnes/v1/session.fork', { sessionId: parent, at: ended.seq, ...params }),
      ) as Promise<{ result?: { sessionId: string }; error?: { data?: { code?: string } } }>
    return {
      ...f,
      one,
      two,
      parent,
      fork,
      session,
      prompt,
      endpoint,
      close: async () => {
        await endpoint.close()
        await f.close()
      },
    }
  }

  it('gives the child the parent directories plus the new one and leaves the parent alone', async () => {
    const f = await forkFixture()
    try {
      const plain = await f.fork({ childKey: 'agnes:fork:plain' })
      expect((await f.workspaces.restoreBinding(plain.result?.sessionId ?? '')).extraRoots).toEqual([f.one])
      const grown = await f.fork({ childKey: 'agnes:fork:grown', additionalDirectories: [f.two, f.one] })
      const child = grown.result?.sessionId ?? ''
      expect((await f.workspaces.restoreBinding(child)).extraRoots).toEqual([f.one, f.two].sort())
      expect((await f.workspaces.restoreBinding(f.parent)).extraRoots).toEqual([f.one])
    } finally {
      await f.close()
    }
  })

  it('carries the directories through a journaled submit as well', async () => {
    const f = await forkFixture()
    try {
      const [ended] = await f.session.scan({ type: 'turn/end', order: 'desc', limit: 1 })
      const reply = (await f.endpoint.handle(
        request(50, '_agnes/v1/submit', {
          clientId: 'extra-dirs-test',
          commandId: 'fork-with-dirs',
          kind: 'fork',
          payload: {
            sessionId: f.parent,
            at: ended?.seq,
            childKey: 'agnes:fork:submitted',
            additionalDirectories: [f.two],
          },
        }),
      )) as { error?: unknown }
      expect(reply.error).toBeUndefined()
      expect((await f.workspaces.restoreBinding('agnes:fork:submitted')).extraRoots).toEqual(
        [f.one, f.two].sort(),
      )
    } finally {
      await f.close()
    }
  })

  it('refuses what the daemon cannot vouch for and creates no child', async () => {
    const f = await forkFixture()
    try {
      const many = await Promise.all(Array.from({ length: 8 }, async () => temp()))
      for (const dir of many) await f.workspaces.add(dir)
      const cases: Array<[string, string[], string]> = [
        ['unregistered', [f.unregistered], 'WORKSPACE_NOT_FOUND'],
        ['relative', ['relative/dir'], 'EXTRA_DIRECTORY_REFUSED'],
        ['protected', [f.protectedDir], 'EXTRA_DIRECTORY_REFUSED'],
        ['more than eight in all', many, 'EXTRA_DIRECTORY_REFUSED'],
      ]
      for (const [name, dirs, code] of cases)
        await expect(f.fork({ additionalDirectories: dirs }), name).resolves.toMatchObject({
          error: { data: { code } },
        })
      const listed = (await f.endpoint.handle(request(99, '_agnes/v1/session.list', {}))) as {
        result: { items: Array<{ sessionId: string }> }
      }
      expect(listed.result.items.map((item) => item.sessionId)).toEqual([f.parent])
    } finally {
      await f.close()
    }
  })

  it('is refused while the parent runs a turn', async () => {
    const f = await forkFixture()
    try {
      await f.session.enqueue('next-turn', f.prompt('second'))
      expect(await f.session.acceptInput()).toBe(true)
      await expect(f.fork({ additionalDirectories: [f.two] })).resolves.toMatchObject({
        error: { data: { code: 'SESSION_BUSY' } },
      })
    } finally {
      await f.close()
    }
  })
})
