import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteStorage, type SqliteStorage } from '../../src/adapters/storage-sqlite.js'
import {
  createHostLockedPackageMutationRuntime,
  type HostLockedPackageMutationEngine,
  type HostLockedPackageMutationOptions,
} from '../../src/computer-use/locked-package-mutation-runtime.js'
import {
  createSqliteLockedPackageOperationReceiptPort,
  type HostLockedPackageActivationRecord,
} from '../../src/computer-use/locked-package-receipts-sqlite.js'

const roots: string[] = []
const hash = (digit: string): string => digit.repeat(64)
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-locked-package-runtime-'))
  roots.push(root)
  return root
}
const storage = (root: string): SqliteStorage =>
  createSqliteStorage({ file: join(root, 'sessions.db'), tablesDir: join(root, 'tables') })
const record: HostLockedPackageActivationRecord = {
  schemaVersion: 1,
  packageId: 'computer-use-driver',
  version: '1.0.0',
  packageSha256: hash('1'),
  manifestSha256: hash('2'),
  directory: 'computer-use-driver-1.0.0',
  activatedAt: '2026-09-17T00:00:00.000Z',
  signature: { keyId: 'publisher-key', publisher: 'publisher', evidenceId: 'evidence-1' },
  provenance: { source: 'https://example.com/driver', revision: '3'.repeat(40), artifactSha256: hash('4') },
  compatibility: { agnesApiVersions: ['v1'], platforms: ['linux-x64'], osVersions: ['6.0'] },
}
const engine = (activate = async (): Promise<HostLockedPackageActivationRecord> => record) =>
  ({
    activate,
    confirmLkg: async () => record,
    rollback: async () => record,
  }) satisfies HostLockedPackageMutationEngine
const scoped = (root: string, session: string, operation: string): string =>
  `lp-${createHash('sha256').update(realpathSync(root)).update('\0').update(session).update('\0').update(operation).digest('hex')}`
const storeBinding = (root: string): string =>
  createHash('sha256')
    .update(`agnes-locked-package-store\0${realpathSync(root)}`)
    .digest('hex')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Host locked-package mutation runtime', () => {
  it('keeps mutation blocked without trusted dependencies', async () => {
    const root = temp()
    const db = storage(root)
    try {
      const runtime = await createHostLockedPackageMutationRuntime(db)
      expect(runtime.status()).toEqual({
        activationReady: false,
        recoveryReady: false,
        blockers: [
          'store-directory-unavailable',
          'mutation-engine-unavailable',
          'environment-unavailable',
          'publisher-keyring-unavailable',
          'safe-extraction-unavailable',
          'trusted-directory-handle-unavailable',
        ],
      })
      await expect(
        runtime
          .session('session-a')
          .activate({ operationId: 'install-a', archiveBytes: new Uint8Array([1]) }),
      ).rejects.toMatchObject({ code: 'BLOCKED' })
      await runtime.close()
    } finally {
      await db.close()
    }
  })

  it('never admits pathname-only ports, even after ancestor replacement', async () => {
    const databaseRoot = temp()
    const root = temp()
    const db = storage(databaseRoot)
    const credential = 'Bearer secret-do-not-leak'
    const activate = vi.fn(async () => {
      throw new Error(credential)
    })
    const extractor = vi.fn(async () => ({ sourceDirectory: root, manifest: {}, release() {} }))
    const runtime = await createHostLockedPackageMutationRuntime(db, {
      storeDirectory: root,
      engine: engine(activate),
      environment: { agnesApiVersion: 'v1', platform: 'linux-x64', osVersion: '6.0' },
      verifySignature: async () => ({
        verified: true,
        keyId: 'publisher-key',
        publisher: 'publisher',
        evidenceId: 'evidence-1',
      }),
      extractor,
    })
    try {
      expect(runtime.status()).toMatchObject({
        activationReady: false,
        recoveryReady: true,
        blockers: ['trusted-directory-handle-unavailable'],
      })
      const moved = `${root}-moved`
      roots.push(moved)
      renameSync(root, moved)
      mkdirSync(root)
      await expect(
        runtime
          .session('session-a')
          .activate({ operationId: 'install-a', archiveBytes: new Uint8Array([1]) }),
      ).rejects.toMatchObject({ code: 'BLOCKED', message: expect.not.stringContaining(credential) })
      expect(extractor).not.toHaveBeenCalled()
      expect(activate).not.toHaveBeenCalled()
    } finally {
      await runtime.close()
      await db.close()
    }
  })

  it('reconciles committed/prepared receipts conservatively and per session', async () => {
    const root = temp()
    const db = storage(root)
    const receipts = createSqliteLockedPackageOperationReceiptPort(db)
    const committedId = scoped(root, 'session-a', 'same-operation')
    const preparedId = scoped(root, 'session-b', 'same-operation')
    for (const id of [committedId, preparedId]) {
      const prepared = await receipts.prepare({
        schemaVersion: 1,
        operationId: id,
        kind: 'activate',
        storeBindingSha256: storeBinding(root),
        requestSha256: hash('6'),
        beforeStateSha256: hash('7'),
        afterStateSha256: hash('8'),
        result: record,
      })
      if (id === committedId) await receipts.commit({ operationId: id, fencing: prepared.fencing })
    }
    try {
      const runtime = await createHostLockedPackageMutationRuntime(db, { storeDirectory: root })
      await expect(
        runtime.session('session-a').reconcile({ operationId: 'same-operation' }),
      ).resolves.toMatchObject({ outcome: 'committed' })
      await expect(
        runtime.session('session-b').reconcile({ operationId: 'same-operation' }),
      ).resolves.toMatchObject({ outcome: 'unknown' })
      await expect(
        runtime.session('session-c').reconcile({ operationId: 'same-operation' }),
      ).resolves.toEqual({ historyOnly: true, outcome: 'not-found' })
      const session = runtime.session('session-a')
      await runtime.close()
      await expect(session.reconcile({ operationId: 'x' })).rejects.toMatchObject({ code: 'CLOSED' })
    } finally {
      await db.close()
    }
  })

  it('rejects committed and prepared receipts bound to another store', async () => {
    const root = temp()
    const db = storage(root)
    const receipts = createSqliteLockedPackageOperationReceiptPort(db)
    for (const [session, committed] of [
      ['session-committed', true],
      ['session-prepared', false],
    ] as const) {
      const id = scoped(root, session, 'wrong-store')
      const prepared = await receipts.prepare({
        schemaVersion: 1,
        operationId: id,
        kind: 'activate',
        storeBindingSha256: hash('9'),
        requestSha256: hash('6'),
        beforeStateSha256: hash('7'),
        afterStateSha256: hash('8'),
        result: record,
      })
      if (committed) await receipts.commit({ operationId: id, fencing: prepared.fencing })
    }
    try {
      const runtime = await createHostLockedPackageMutationRuntime(db, { storeDirectory: root })
      for (const session of ['session-committed', 'session-prepared']) {
        await expect(
          runtime.session(session).reconcile({ operationId: 'wrong-store' }),
        ).rejects.toMatchObject({
          code: 'RECONCILE',
          message: 'locked package reconciliation is unavailable',
        })
        await expect(
          runtime.session(session).reconcile({ operationId: 'wrong-store' }),
        ).rejects.toMatchObject({ code: 'RECONCILE' })
      }
      await runtime.close()
    } finally {
      await db.close()
    }
  })

  it('still boots when receipt tables cannot open', async () => {
    const root = temp()
    const db = storage(root)
    const tables = db.tables.bind(db)
    Object.defineProperty(db, 'tables', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: () => {
        throw Object.assign(new Error('E_LOCKED_PACKAGE_RECEIPT_OPEN_FAILED'), {
          name: 'ReceiptStoreError',
        })
      },
    })
    try {
      const runtime = await createHostLockedPackageMutationRuntime(db)
      expect(runtime.status().activationReady).toBe(false)
      await expect(
        runtime
          .session('session-a')
          .activate({ operationId: 'install-a', archiveBytes: new Uint8Array([1]) }),
      ).rejects.toMatchObject({ code: 'BLOCKED' })
      await runtime.close()
    } finally {
      Object.defineProperty(db, 'tables', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: tables,
      })
      await db.close()
    }
  })

  it('rejects configuration accessors without invoking them', async () => {
    const db = storage(temp())
    try {
      const get = vi.fn(() => engine())
      const hostile = Object.defineProperty({}, 'engine', { enumerable: true, get })
      await expect(
        createHostLockedPackageMutationRuntime(db, hostile as HostLockedPackageMutationOptions),
      ).rejects.toMatchObject({ code: 'INVALID' })
      expect(get).not.toHaveBeenCalled()
    } finally {
      await db.close()
    }
  })
})
