import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { MemorySessionWorkspaces } from '@agnes/daemon-foundation/storage/lister'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import { createLocalEndpoint } from '@agnes/daemon-rpc/local/index'
import { resolveWorkspaceDirectory } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { createSandboxSeam } from '@agnes/host-infrastructure/sandbox-seam'
import type { InferenceEvent, JsonValue, Provider } from '@agnes/protocol'
import { createClient, createOwnedStore, memoryJournal } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { BatchEngine, BatchService, ownedSnapshots, Repository, SessionExecutor } from '../src/index.js'
import { id, spec } from './fakes.js'

const tool = (name: string, args: Record<string, JsonValue>): InferenceEvent[] => [
  { type: 'toolcall_end', call: { toolUseId: '', name, args, ordinal: 0 }, via: 'native' },
  {
    type: 'usage',
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    credits: 0,
    creditSource: 'estimated',
  },
  { type: 'done', reason: 'toolUse' },
]
it('runs two visible SDK item sessions, denies cross-item reads, and never resends after owned-store reopen', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agh-batch-native-')))
  const workspace = join(root, 'workspace'),
    area = join(root, 'owned')
  await mkdir(workspace)
  await mkdir(area)
  await mkdir(join(workspace, 'inputs'))
  await writeFile(join(workspace, 'inputs/a.txt'), 'alpha-only')
  await writeFile(join(workspace, 'inputs/b.txt'), 'beta-only')
  let other = '',
    refused = false,
    held = false,
    calls = 0
  const first = new ScriptedProvider({
    models: [
      fakeModel({
        id: 'm1',
        route: 'gw',
        maxTokens: 100,
        cost: { input: 0, output: 2500, cacheRead: 0, cacheWrite: 0 },
      }),
    ],
    scripts: [
      tool('tool_describe', { name: 'read' }),
      tool('read', { path: 'a.txt' }),
      (req) => {
        expect(JSON.stringify(req.messages)).toContain('alpha-only')
        return tool('read', { path: other })
      },
      (req) => {
        expect(JSON.stringify(req.messages)).toContain('E_FS_DENIED')
        expect(JSON.stringify(req.messages)).not.toContain('beta-only')
        refused = true
        return [
          { type: 'text_delta', delta: '{"ok":true}' },
          {
            type: 'usage',
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            credits: 0.1,
            creditSource: 'estimated',
          },
          { type: 'done', reason: 'stop' },
        ]
      },
    ],
    onExhausted: 'error',
  })
  const provider: Provider = {
    models: () => first.models(),
    async *infer(req, options) {
      calls++
      if (req.sessionKey.endsWith(':1')) {
        yield* first.infer(req, options)
        return
      }
      held = true
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve()
        else options.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield { type: 'done', reason: 'stop' }
    },
  }
  const { host } = await createTestHost({
    dataDir: join(root, 'host'),
    provider,
    disableSessionTitle: true,
    sandboxSeam: createSandboxSeam(),
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
  })
  const workspaces = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    resolveWorkspaceDirectory,
    Date.now,
  )
  const endpoint = createLocalEndpoint(host, { workspaces, pollMs: 5 })
  let client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
  const lifetime = new AbortController()
  let database = new DatabaseSync(join(area, 'progress.sqlite'))
  try {
    let store = createOwnedStore(database, 'batch')
    const executor = new SessionExecutor(client, store, lifetime.signal)
    const engine = new BatchEngine(new Repository(store), executor)
    const service = new BatchService({
      workspaceRoot: workspace,
      engine,
      artifacts: ownedSnapshots(area),
      signal: lifetime.signal,
    })
    await service.start({
      id,
      dir: 'inputs',
      spec: {
        ...spec,
        itemTimeoutMs: 60_000,
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    })
    const originals = await engine.repo.page(id)
    other = originals[1]!.input.path!
    expect(originals.every((row) => !row.input.receipt && !row.input.artifact)).toBe(true)
    await engine.tick(id)
    await vi.waitFor(
      async () => {
        await service.tick()
        expect(await engine.repo.status(id)).toMatchObject({ successes: 1, spent: 0.1 })
        expect(held).toBe(true)
      },
      { timeout: 10_000 },
    )
    expect(refused).toBe(true)
    const sessions = await client.session.list({ limit: 10 })
    expect(sessions.items.map((row) => row.title)).toEqual(
      expect.arrayContaining([`batch ${id} · a.txt`, `batch ${id} · b.txt`]),
    )
    expect(await readFile(join(workspace, 'agh-batch', id, 'results.jsonl'), 'utf8')).toContain('"ok":true')
    expect(await readFile(join(workspace, 'agh-batch', id, 'summary.md'), 'utf8')).toContain(
      'Status: running',
    )
    // Drop the connection with an accepted prompt unresolved, then reopen only the owned database.
    await client.close()
    await executor.drain()
    database.close()
    database = new DatabaseSync(join(area, 'progress.sqlite'))
    store = createOwnedStore(database, 'batch')
    client = createClient({
      transport: { kind: 'inproc', endpoint: createLocalEndpoint(host, { workspaces, pollMs: 5 }) },
      journal: memoryJournal(),
    })
    await client.initialize()
    expect((await client.workspace.list()).items).toHaveLength(2)
    const recovered = new BatchEngine(
      new Repository(store),
      new SessionExecutor(client, store, lifetime.signal),
    )
    const before = calls
    expect(await recovered.resume(id)).toMatchObject({ status: 'unknown', successes: 1, uncertain: 1 })
    expect(await recovered.resume(id)).toMatchObject({ status: 'unknown', successes: 1, uncertain: 1 })
    expect(calls).toBe(before)
    expect(await recovered.cancel(id)).toMatchObject({
      status: 'unknown',
      reserved: expect.closeTo(1, 9),
      spent: 0.1,
    })
    expect(calls).toBe(before)
    expect((await recovered.repo.page(id))[1]).toMatchObject({
      state: 'unknown',
      attempts: [{ key: `${id}/2/0` }],
    })
  } finally {
    lifetime.abort()
    await client.close()
    await endpoint.close()
    await host.close()
    database.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

it.each(['repair', 'multi-step'] as const)(
  'binds real concurrent SDK %s turns to the remaining item and batch ceilings',
  async (mode) => {
    const provider = new ScriptedProvider({
      models: [
        fakeModel({
          id: 'm1',
          route: 'gw',
          maxTokens: 100,
          cost: { input: 0, output: 2500, cacheRead: 0, cacheWrite: 0 },
        }),
      ],
      scripts: [
        [
          ...(mode === 'repair'
            ? [{ type: 'text_delta' as const, delta: 'invalid' }]
            : tool('tool_describe', { name: 'read' }).slice(0, 1)),
          {
            type: 'usage',
            tokens: { input: 1, output: 80, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            credits: 0.2,
            creditSource: 'estimated',
          },
          { type: 'done', reason: mode === 'repair' ? 'stop' : 'toolUse' },
        ],
      ],
      onExhausted: 'error',
    })
    const { nativeFixture } = await import('./native-fixture.js')
    const f = await nativeFixture(provider)
    try {
      await f.service.start({
        id,
        dir: 'inputs',
        spec: {
          ...spec,
          budget: 0.3,
          itemBudget: 0.25,
          itemTimeoutMs: 60_000,
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        },
      })
      await f.engine.tick(id)
      await vi.waitFor(
        async () => {
          await f.engine.tick(id)
          expect((await f.engine.repo.status(id)).settled).toBe(2)
        },
        { timeout: 10_000 },
      )
      const manifest = await f.engine.repo.status(id)
      expect(manifest.spent).toBeCloseTo(0.2)
      expect(manifest.reserved).toBe(0)
      expect(manifest.spent).toBeLessThanOrEqual(manifest.spec.budget)
      const items = await f.engine.repo.page(id)
      expect(items.every((item) => item.attempts.reduce((sum, a) => sum + a.charged, 0) <= 0.25)).toBe(true)
      expect(provider.calls).toHaveLength(1)
      expect(provider.calls[0]!.sampling?.maxTokens).toBe(100)
      // A rejected zero-call turn still has authoritative zero billing; no fabricated free success.
      expect(items[1]).toMatchObject({
        state: 'failed',
        attempts: [{ charged: 0, ceiling: expect.closeTo(0.05) }],
      })
      if (mode === 'repair')
        expect(items[0]!.attempts.map((a) => a.ceiling)).toEqual([0.25, expect.closeTo(0.05)])
      expect((await f.client.session.list({ limit: 10 })).items).toHaveLength(2)
    } finally {
      await f.close()
    }
  },
  20_000,
)
