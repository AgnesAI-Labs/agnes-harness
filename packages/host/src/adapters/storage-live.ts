import { mkdirSync, realpathSync } from 'node:fs'
import { CoreError } from '@agnes/core'
import type { PersistenceProvider } from '@agnes/extension-api'
import { HostError } from '../errors.js'
import type { HostPersistence } from './storage-provider.js'
import type { TableHandle } from './storage-sqlite.js'

type ProcessStore = {
  storage: HostPersistence
  identity: string
  references: number
  closing?: Promise<void>
}
const processStores = new Map<string, Promise<ProcessStore>>()

/** Code generations in one process share live persistence; the last Host releases the resource. */
export async function retainProcessStore(
  dataDir: string,
  provider: PersistenceProvider,
  open: () => Promise<HostPersistence>,
): Promise<HostPersistence> {
  mkdirSync(dataDir, { recursive: true })
  const directory = realpathSync(dataDir)
  const identity = JSON.stringify([provider.id, provider.version, provider.capabilities])
  let pending = processStores.get(directory)
  if (!pending) {
    pending = open().then((storage) => ({ storage, identity, references: 0 }))
    processStores.set(directory, pending)
    void pending.catch(() => {
      if (processStores.get(directory) === pending) processStores.delete(directory)
    })
  }
  const entry = await pending
  if (entry.identity !== identity)
    throw new HostError('E_SEAM_INIT', 'persistence changes require a process restart')
  if (entry.closing) {
    await entry.closing
    return retainProcessStore(dataDir, provider, open)
  }
  entry.references++
  let closing: Promise<void> | undefined
  const assertOpen = (): void => {
    if (closing) throw new CoreError('E_CLOSED', 'Host persistence handle is closed')
  }
  // Plain wrappers support frozen provider ports and keep locally closed handles fenced.
  const guarded = <T extends object>(port: T, keys: readonly (keyof T)[]): T =>
    Object.fromEntries(
      keys.map((key) => [
        key,
        (...args: unknown[]) => {
          assertOpen()
          const value: unknown = Reflect.get(port, key, port)
          if (typeof value !== 'function') throw new TypeError('invalid persistence port method')
          return Reflect.apply(value, port, args)
        },
      ]),
    ) as T
  const guardedTable = (table: TableHandle): TableHandle => ({
    name: table.name,
    exec(sql) {
      assertOpen()
      return table.exec(sql)
    },
    run(sql, params) {
      assertOpen()
      return table.run(sql, params)
    },
    all(sql, params) {
      assertOpen()
      return table.all(sql, params)
    },
    get(sql, params) {
      assertOpen()
      return table.get(sql, params)
    },
    transaction(fn) {
      assertOpen()
      return table.transaction(fn)
    },
    schema() {
      assertOpen()
      return table.schema()
    },
  })
  const storage = entry.storage
  const sqlite = storage.sqlite
  const view = {
    ...storage,
    metadata: {
      namespace(owner: string, name: string) {
        assertOpen()
        return guarded(storage.metadata.namespace(owner, name), [
          'get',
          'set',
          'delete',
          'entries',
          'transaction',
        ])
      },
    },
    crashReclaim: guarded(storage.crashReclaim, ['listExpired', 'claimForReclaim']),
    ...(sqlite
      ? {
          sqlite: {
            dialect: 'sqlite' as const,
            tables(owner: string) {
              assertOpen()
              return {
                table(name: string) {
                  assertOpen()
                  return guardedTable(sqlite.tables(owner).table(name))
                },
              }
            },
          },
        }
      : {}),
    close() {
      if (!closing) {
        closing = Promise.resolve().then(async () => {
          entry.references--
          if (entry.references === 0) {
            entry.closing = storage.close()
            try {
              await entry.closing
            } finally {
              if (processStores.get(directory) === pending) processStores.delete(directory)
            }
          }
        })
      }
      return closing
    },
  }
  for (const [key, value] of Object.entries(storage))
    if (typeof value === 'function' && key !== 'close')
      Object.defineProperty(view, key, {
        enumerable: true,
        value: (...args: unknown[]) => {
          try {
            assertOpen()
            if (key === 'tables') {
              const tables = Reflect.apply(value, storage, args) as import('./storage-sqlite.js').TableStore
              return {
                table(name: string) {
                  assertOpen()
                  return guardedTable(tables.table(name))
                },
              }
            }
            return Reflect.apply(value, storage, args)
          } catch (error) {
            if (key === 'childControlFormat' || key === 'assertWritableFormat' || key === 'tables')
              throw error
            return Promise.reject(error)
          }
        },
      })
  return view
}
