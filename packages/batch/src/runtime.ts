import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ProfileManagedInit } from '@agnes/extension-api'
import { createClient, createOwnedStore, memoryJournal } from '@agnes/sdk'
import { BatchError } from './contracts.js'
import { startManagedBatch } from './managed.js'
import { ownedSnapshots, SessionExecutor } from './native.js'

/** Explicit reviewed local configuration; no bearer or model credential belongs here. */
export const BATCH_CONFIG_SCHEMA = {
  type: 'object' as const,
  properties: {
    workspaceRoot: { type: 'string' as const, maxLength: 4096 },
    ownedArea: { type: 'string' as const, maxLength: 4096 },
    socketPath: { type: 'string' as const, maxLength: 4096 },
    serverIdentity: {
      type: 'object' as const,
      properties: {
        pid: { type: 'integer' as const, minimum: 1 },
        processStartId: { type: 'string' as const, minLength: 1 },
      },
      required: ['pid', 'processStartId'],
      additionalProperties: false as const,
    },
  },
  additionalProperties: false as const,
}
export async function startProfileBatch(init: ProfileManagedInit) {
  const config = init.config
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    typeof config.workspaceRoot !== 'string' ||
    !isAbsolute(config.workspaceRoot) ||
    typeof config.ownedArea !== 'string' ||
    !isAbsolute(config.ownedArea) ||
    typeof config.socketPath !== 'string' ||
    !config.socketPath
  )
    throw new BatchError(
      'E_BATCH_CONFIGURATION',
      'Configure batchWorker with workspaceRoot, ownedArea and the current profile local socketPath',
    )
  init.assertCurrent()
  const root = resolve(config.workspaceRoot),
    area = resolve(config.ownedArea)
  const contains = (base: string, path: string) => {
    const rel = relative(base, path)
    return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  }
  if ((await realpath(root)) !== root || contains(root, area) || contains(area, root))
    throw new BatchError('E_BATCH_PATH')
  const owner = init.store.transaction(() => {
    const existing = init.store.get('batch-owner')
    if (existing !== undefined) {
      if (typeof existing !== 'string' || !/^[a-f0-9-]{36}$/u.test(existing))
        throw new BatchError('E_BATCH_STORE')
      return existing
    }
    const identity = randomUUID()
    init.store.set('batch-owner', identity)
    return identity
  })
  const owned = join(area, owner)
  await mkdir(owned, { recursive: true, mode: 0o700 })
  if ((await realpath(owned)) !== owned) throw new BatchError('E_BATCH_PATH')
  const databasePath = join(owned, 'batch.sqlite')
  try {
    await (await open(databasePath, 'wx', 0o600)).close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  try {
    if ((await lstat(databasePath)).isSymbolicLink()) throw new BatchError('E_BATCH_PATH')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
  const client = createClient({
    transport: {
      kind: 'unix',
      path: config.socketPath,
      ...(config.serverIdentity
        ? { serverIdentity: config.serverIdentity as { pid: number; processStartId: string } }
        : {}),
    },
    auth: { kind: 'local' },
    journal: memoryJournal('batch'),
  })
  try {
    await client.initialize()
    const store = createOwnedStore(database, 'batch')
    const executor = new SessionExecutor(client, store, init.signal)
    let running: Awaited<ReturnType<typeof startManagedBatch>> | undefined
    running = await startManagedBatch(
      {
        instanceId: 'batchWorker',
        incarnation: 'profile-managed',
        scopeId: 'current-profile',
        listeners: init.listeners,
        store,
        signal: init.signal,
        ready: async () => {
          init.assertCurrent()
          init.ready()
        },
        onShutdown(handler) {
          init.onShutdown(async (reason) => {
            const result = await handler(reason, AbortSignal.timeout(5000))
            await client.close().catch(() => {})
            await executor.drain()
            await running?.drain()
            database.close()
            return result
          })
        },
      },
      { workspaceRoot: root, executor, artifacts: ownedSnapshots(owned) },
    )
    return running.service
  } catch (error) {
    await client.close().catch(() => {})
    database.close()
    throw error
  }
}
