import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LockedPackageOperationReceipt, LockedPackageOperationReceiptPort } from '@agnes/base'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSqliteStorage,
  type SqliteStorage,
  type TableHandle,
  type TableStore,
} from '../../src/adapters/storage-sqlite.js'
import { createSqliteLockedPackageOperationReceiptPort } from '../../src/computer-use/locked-package-receipts-sqlite.js'

const OWNER = '@agnes/host/locked-package-operation-receipts'
const roots: string[] = []
const hash = (digit: string) => digit.repeat(64)

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'agnes-locked-package-receipts-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function open(root: string): SqliteStorage {
  return createSqliteStorage({ file: join(root, 'sessions.db'), tablesDir: join(root, 'tables') })
}

function prepared(operationId = 'operation-a'): Omit<LockedPackageOperationReceipt, 'fencing' | 'phase'> {
  return {
    schemaVersion: 1,
    operationId,
    kind: 'activate',
    storeBindingSha256: hash('1'),
    requestSha256: hash('2'),
    beforeStateSha256: hash('3'),
    afterStateSha256: hash('4'),
    result: {
      schemaVersion: 1,
      packageId: 'computer-use-driver',
      version: '1.0.0',
      packageSha256: hash('5'),
      manifestSha256: hash('6'),
      directory: 'computer-use-driver-1.0.0',
      activatedAt: '2026-09-17T00:00:00.000Z',
      signature: { keyId: 'publisher-key', publisher: 'publisher', evidenceId: 'evidence-1' },
      provenance: {
        source: 'https://example.com/driver',
        revision: '7'.repeat(40),
        artifactSha256: hash('8'),
      },
      compatibility: {
        agnesApiVersions: ['v1'],
        platforms: ['darwin-arm64'],
        osVersions: ['26.0'],
      },
    },
  }
}

describe('Host locked-package durable operation receipts', () => {
  it('implements the Base receipt port and survives prepared/committed crash reopen', async () => {
    const root = temp()
    let storage = open(root)
    const first: LockedPackageOperationReceiptPort = createSqliteLockedPackageOperationReceiptPort(storage)
    const receipt = await first.prepare(prepared())
    expect(receipt).toMatchObject({ operationId: 'operation-a', phase: 'prepared' })
    await storage.close()

    storage = open(root)
    const reopened: LockedPackageOperationReceiptPort = createSqliteLockedPackageOperationReceiptPort(storage)
    expect(await reopened.read('operation-a')).toEqual(receipt)
    const committed = await reopened.commit({ operationId: 'operation-a', fencing: receipt.fencing })
    expect(committed).toEqual({ ...receipt, phase: 'committed' })
    expect(await reopened.commit({ operationId: 'operation-a', fencing: receipt.fencing })).toEqual(committed)
    await storage.close()

    storage = open(root)
    expect(await createSqliteLockedPackageOperationReceiptPort(storage).read('operation-a')).toEqual(
      committed,
    )
    await storage.close()
  })

  it('makes prepare idempotent but fails closed on conflicting operationId reuse', async () => {
    const storage = open(temp())
    try {
      const receipts = createSqliteLockedPackageOperationReceiptPort(storage)
      const first = await receipts.prepare(prepared())
      expect(await receipts.prepare(prepared())).toEqual(first)
      await expect(receipts.prepare({ ...prepared(), afterStateSha256: hash('9') })).rejects.toThrow(
        'E_LOCKED_PACKAGE_RECEIPT_CONFLICT',
      )
      expect(await receipts.read('operation-a')).toEqual(first)
    } finally {
      await storage.close()
    }
  })

  it('serializes concurrent prepare and fences commit with the allocated token', async () => {
    const root = temp()
    const leftStorage = open(root)
    const rightStorage = open(root)
    try {
      const left = createSqliteLockedPackageOperationReceiptPort(leftStorage)
      const right = createSqliteLockedPackageOperationReceiptPort(rightStorage)
      const [a, b] = await Promise.all([left.prepare(prepared()), right.prepare(prepared())])
      expect(a).toEqual(b)
      await expect(right.commit({ operationId: a.operationId, fencing: 'wrong-fence' })).rejects.toThrow(
        'E_LOCKED_PACKAGE_RECEIPT_FENCE',
      )
      expect((await left.read(a.operationId))?.phase).toBe('prepared')
      expect(await right.commit({ operationId: a.operationId, fencing: a.fencing })).toMatchObject({
        phase: 'committed',
      })
    } finally {
      await leftStorage.close()
      await rightStorage.close()
    }
  })

  it('re-attests main, temporary schema, and the sole version before every operation', async () => {
    const root = temp()
    const storage = open(root)
    const receipts = createSqliteLockedPackageOperationReceiptPort(storage)
    const raw = storage.tables(OWNER).table('locked_package_operation_receipts')
    raw.exec('CREATE INDEX locked_package_receipts_extra ON locked_package_receipts (kind)')
    await expect(receipts.read('missing')).rejects.toThrow('E_LOCKED_PACKAGE_RECEIPT_SCHEMA')
    await storage.close()

    const tempRoot = temp()
    const tempStorage = open(tempRoot)
    const tempReceipts = createSqliteLockedPackageOperationReceiptPort(tempStorage)
    const tempRaw = tempStorage.tables(OWNER).table('locked_package_operation_receipts')
    tempRaw.exec(
      `CREATE TEMP TRIGGER locked_package_receipts_temp_mutate
       AFTER UPDATE ON locked_package_receipts
       BEGIN DELETE FROM locked_package_receipts; END`,
    )
    await expect(tempReceipts.prepare(prepared())).rejects.toThrow('E_LOCKED_PACKAGE_RECEIPT_SCHEMA')
    expect(tempRaw.get('SELECT operation_id FROM locked_package_receipts')).toBeUndefined()
    await tempStorage.close()

    const versionRoot = temp()
    const versionStorage = open(versionRoot)
    const versionReceipts = createSqliteLockedPackageOperationReceiptPort(versionStorage)
    versionStorage
      .tables(OWNER)
      .table('locked_package_operation_receipts')
      .run('UPDATE locked_package_receipt_meta SET version = 2 WHERE id = 1')
    await expect(versionReceipts.read('missing')).rejects.toThrow('E_LOCKED_PACKAGE_RECEIPT_SCHEMA')
    await versionStorage.close()

    const literalRoot = temp()
    const literalStorage = open(literalRoot)
    const literalRaw = literalStorage.tables(OWNER).table('locked_package_operation_receipts')
    literalRaw.exec(
      'CREATE TABLE locked_package_receipt_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)',
    )
    literalRaw.exec(
      'CREATE TABLE locked_package_receipts (' +
        'operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 128), ' +
        "kind TEXT NOT NULL CHECK (kind IN ('ACTIVATE','confirm-lkg','rollback')), " +
        "phase TEXT NOT NULL CHECK (phase IN ('prepared','committed')), " +
        'fencing TEXT NOT NULL CHECK (length(fencing) BETWEEN 1 AND 128), ' +
        'store_binding_sha256 TEXT NOT NULL CHECK (length(store_binding_sha256) = 64), ' +
        'request_sha256 TEXT CHECK (request_sha256 IS NULL OR length(request_sha256) = 64), ' +
        'before_state_sha256 TEXT NOT NULL CHECK (length(before_state_sha256) = 64), ' +
        'after_state_sha256 TEXT NOT NULL CHECK (length(after_state_sha256) = 64), ' +
        'result_json TEXT NOT NULL CHECK (length(result_json) BETWEEN 2 AND 32768))',
    )
    literalRaw.exec(
      'CREATE UNIQUE INDEX locked_package_receipts_fencing ON locked_package_receipts (fencing)',
    )
    literalRaw.run('INSERT INTO locked_package_receipt_meta (id, version) VALUES (1, 1)')
    expect(() => createSqliteLockedPackageOperationReceiptPort(literalStorage)).toThrow(
      'E_LOCKED_PACKAGE_RECEIPT_SCHEMA',
    )
    await literalStorage.close()
  })

  it('admits exactly 4096 receipts, rejects 4097, and refuses overflow on reopen', async () => {
    const root = temp()
    let storage = open(root)
    createSqliteLockedPackageOperationReceiptPort(storage)
    const raw = storage.tables(OWNER).table('locked_package_operation_receipts')
    const resultJson = JSON.stringify(prepared().result)
    raw.run(
      `WITH RECURSIVE rows(n) AS (
         VALUES(0) UNION ALL SELECT n + 1 FROM rows WHERE n < 4095
       )
       INSERT INTO locked_package_receipts
       (operation_id, kind, phase, fencing, store_binding_sha256, request_sha256,
        before_state_sha256, after_state_sha256, result_json)
       SELECT 'operation-' || n, 'activate', 'prepared', 'fence-' || n, ?, ?, ?, ?, ? FROM rows`,
      [hash('1'), hash('2'), hash('3'), hash('4'), resultJson],
    )
    const capped = createSqliteLockedPackageOperationReceiptPort(storage)
    await expect(capped.prepare(prepared('overflow'))).rejects.toThrow('E_LOCKED_PACKAGE_RECEIPT_LIMIT')
    raw.run(
      `INSERT INTO locked_package_receipts
       (operation_id, kind, phase, fencing, store_binding_sha256, request_sha256,
        before_state_sha256, after_state_sha256, result_json)
       VALUES ('overflow', 'activate', 'prepared', 'overflow-fence', ?, ?, ?, ?, ?)`,
      [hash('1'), hash('2'), hash('3'), hash('4'), resultJson],
    )
    await storage.close()

    storage = open(root)
    expect(() => createSqliteLockedPackageOperationReceiptPort(storage)).toThrow(
      'E_LOCKED_PACKAGE_RECEIPT_CORRUPT',
    )
    await storage.close()
  })

  it('captures plain capabilities and never reflects hostile values or SQLite errors', async () => {
    const root = temp()
    const storage = open(root)
    const tables = storage.tables.bind(storage)
    const accessor = Object.create(null) as { tables: SqliteStorage['tables'] }
    const getter = vi.fn(() => tables)
    Object.defineProperty(accessor, 'tables', { enumerable: true, get: getter })
    expect(() => createSqliteLockedPackageOperationReceiptPort(accessor)).toThrow(
      'E_LOCKED_PACKAGE_RECEIPT_CAPABILITY',
    )
    expect(getter).not.toHaveBeenCalled()
    expect(() => createSqliteLockedPackageOperationReceiptPort(new Proxy(storage, {}))).toThrow(
      'E_LOCKED_PACKAGE_RECEIPT_CAPABILITY',
    )
    const hostileSecret = 'Bearer sk-hostile-thrown-proxy'
    const getPrototypeOf = vi.fn(() => {
      throw new Error(hostileSecret)
    })
    const hostileThrownValue = new Proxy(Object.create(null) as object, { getPrototypeOf })
    expect(() =>
      createSqliteLockedPackageOperationReceiptPort({
        tables() {
          throw hostileThrownValue
        },
      }),
    ).toThrow('E_LOCKED_PACKAGE_RECEIPT_OPEN_FAILED')
    expect(getPrototypeOf).not.toHaveBeenCalled()

    const snapshotStorage = open(temp())
    const genuineStore = snapshotStorage.tables(OWNER)
    let exposedTable: TableHandle | undefined
    const tableStore: TableStore = {
      table(name) {
        exposedTable = { ...genuineStore.table(name) }
        return exposedTable
      },
    }
    const storageFacade: Pick<SqliteStorage, 'tables'> = {
      tables() {
        return tableStore
      },
    }
    const snapshotted = createSqliteLockedPackageOperationReceiptPort(storageFacade)
    storageFacade.tables = () => {
      throw new Error('Bearer sk-replaced-storage')
    }
    tableStore.table = () => {
      throw new Error('Bearer sk-replaced-table-store')
    }
    if (!exposedTable) throw new Error('test setup failed')
    exposedTable.exec = () => {
      throw new Error('Bearer sk-replaced-exec')
    }
    exposedTable.run = () => {
      throw new Error('Bearer sk-replaced-run')
    }
    exposedTable.all = () => {
      throw new Error('Bearer sk-replaced-all')
    }
    exposedTable.get = () => {
      throw new Error('Bearer sk-replaced-get')
    }
    exposedTable.transaction = () => {
      throw new Error('Bearer sk-replaced-transaction')
    }
    expect(await snapshotted.prepare(prepared('snapshotted-operation'))).toMatchObject({
      operationId: 'snapshotted-operation',
      phase: 'prepared',
    })
    await snapshotStorage.close()

    const receipts = createSqliteLockedPackageOperationReceiptPort(storage)
    const secret = 'user:Bearer-sk-do-not-leak'
    await expect(
      receipts.prepare({
        ...prepared(),
        result: {
          ...prepared().result,
          provenance: { ...prepared().result.provenance, source: `https://${secret}@example.com/driver` },
        },
      }),
    ).rejects.toThrow('E_LOCKED_PACKAGE_RECEIPT_INPUT')
    expect(JSON.stringify(await receipts.read('operation-a'))).not.toContain(secret)
    await storage.close()
    for (const file of readdirSync(join(root, 'tables'))) {
      expect(readFileSync(join(root, 'tables', file)).includes(Buffer.from(secret))).toBe(false)
    }
  })
})
