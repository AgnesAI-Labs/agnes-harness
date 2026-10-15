import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createClient, createOwnedStore, memoryJournal } from '@agnes/sdk'
import { ownedSnapshots, SessionExecutor, type Store, startManagedBatch } from '../../src/index.js'

const config = JSON.parse(process.argv[2] ?? '{}') as {
  root: string
  socket: string
  stage?: string
  resume?: boolean
}
const id = 'b123456abcdef'
const database = new DatabaseSync(join(config.root, 'batch.sqlite'))
database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
const raw = createOwnedStore(database, 'batch')
const checkpoint = async (stage: string) => {
  if (config.stage !== stage) return
  process.send?.({ stage })
  await new Promise<void>(() => {})
}
const store: Store = {
  scan: (input) => raw.scan(input),
  async transaction(work) {
    let fenced = false
    const result = await raw.transaction((tx) =>
      work({
        ...tx,
        put(key, value, revision) {
          tx.put(key, value, revision)
          if (key.startsWith('operation/') && revision === null) fenced = true
        },
      }),
    )
    if (fenced) await checkpoint('fence')
    return result
  },
}
const signal = new AbortController()
const client = createClient({
  transport: { kind: 'unix', path: config.socket },
  journal: memoryJournal(),
  timeouts: { request: 30_000 },
})
await client.initialize()
const native = new SessionExecutor(client, store, signal.signal)
const managed = await startManagedBatch(
  {
    instanceId: 'batchWorker',
    incarnation: 'crash-test',
    scopeId: 'test',
    listeners: {},
    store,
    signal: signal.signal,
    async ready() {},
    onShutdown() {},
  },
  {
    workspaceRoot: join(config.root, 'workspace'),
    artifacts: ownedSnapshots(join(config.root, 'owned')),
    executor: {
      sessionBacked: true,
      authority: native.authority,
      lookup: (key) => native.lookup(key),
      cancel: (key) => native.cancel(key),
      async dispatch(input) {
        await checkpoint('outbox')
        const receipt = await native.dispatch(input)
        if (config.stage === 'terminal') {
          await native.drain()
          await checkpoint('terminal')
        }
        return receipt
      },
    },
  },
)
if (!config.resume)
  await managed.service.start({
    id,
    dir: 'inputs',
    spec: {
      prompt: 'Item {{ordinal}}',
      budget: 1,
      itemBudget: 0.5,
      concurrency: 1,
      itemTimeoutMs: 60_000,
      maxRepairs: 0,
      failureLimit: 5,
    },
  })
process.on('message', (message) => {
  if (message === 'disconnect') void client.close()
})
for (;;) {
  await managed.tick()
  const status = await managed.service.status(id)
  if (status.status !== 'running') {
    if (status.status === 'completed') await checkpoint('settled')
    process.send?.({ stage: 'recovered', status })
    await client.close()
    await native.drain()
    await managed.stop('exit')
    database.close()
    process.disconnect?.()
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 20))
}
