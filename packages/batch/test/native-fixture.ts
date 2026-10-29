import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { MemorySessionWorkspaces } from '@agnes/daemon-foundation/storage/lister'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import { createLocalEndpoint } from '@agnes/daemon-rpc/local/index'
import { resolveWorkspaceDirectory } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { Provider } from '@agnes/protocol'
import { createClient, createOwnedStore, memoryJournal } from '@agnes/sdk'
import { BatchEngine, BatchService, ownedSnapshots, Repository, SessionExecutor } from '../src/index.js'

export async function nativeFixture(provider: Provider) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agh-batch-budget-')))
  const workspace = join(root, 'workspace'),
    area = join(root, 'owned')
  await mkdir(join(workspace, 'inputs'), { recursive: true })
  await mkdir(area)
  for (const name of ['a.txt', 'b.txt']) await writeFile(join(workspace, 'inputs', name), name)
  const { host } = await createTestHost({
    dataDir: join(root, 'host'),
    provider,
    seams: { billing: { projected: async () => ({ credits: 0.25, creditSource: 'estimated' }) } },
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
  })
  const workspaces = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    resolveWorkspaceDirectory,
    Date.now,
  )
  const endpoint = createLocalEndpoint(host, { workspaces, pollMs: 5 })
  const client = createClient({ transport: { kind: 'inproc', endpoint }, journal: memoryJournal() })
  const lifetime = new AbortController()
  const database = new DatabaseSync(join(area, 'progress.sqlite'))
  const store = createOwnedStore(database, 'batch')
  const executor = new SessionExecutor(client, store, lifetime.signal)
  const engine = new BatchEngine(new Repository(store), executor)
  const service = new BatchService({
    workspaceRoot: workspace,
    engine,
    artifacts: ownedSnapshots(area),
    signal: lifetime.signal,
  })
  return {
    engine,
    service,
    client,
    store,
    async close() {
      lifetime.abort()
      await client.close()
      await executor.drain()
      await endpoint.close()
      await host.close()
      database.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}
