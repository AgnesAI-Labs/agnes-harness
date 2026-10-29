import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LockedPackageOperationReceipt, LockedPackageOperationReceiptPort } from '@agnes/base'
import { sqlitePersistenceProvider } from '@agnes/host-infrastructure/adapters/storage-provider'
import { afterEach, describe, expect, it } from 'vitest'
import { createMetadataLockedPackageOperationReceiptPort } from '../../src/computer-use/locked-package-receipts-sqlite.js'

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

async function openMetadata(root: string) {
  const s = await sqlitePersistenceProvider.open({ dataDir: root })
  if (!s.metadata) throw new Error('metadata port missing')
  return { metadata: s.metadata, close: () => s.close() }
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
    let storage = await openMetadata(root)
    const first: LockedPackageOperationReceiptPort = createMetadataLockedPackageOperationReceiptPort(
      storage.metadata,
    )
    const receipt = await first.prepare(prepared())
    expect(receipt).toMatchObject({ operationId: 'operation-a', phase: 'prepared' })
    await storage.close()

    storage = await openMetadata(root)
    const reopened: LockedPackageOperationReceiptPort = createMetadataLockedPackageOperationReceiptPort(
      storage.metadata,
    )
    expect(await reopened.read('operation-a')).toEqual(receipt)
    const committed = await reopened.commit({ operationId: 'operation-a', fencing: receipt.fencing })
    expect(committed).toEqual({ ...receipt, phase: 'committed' })
    expect(await reopened.commit({ operationId: 'operation-a', fencing: receipt.fencing })).toEqual(committed)
    await storage.close()

    storage = await openMetadata(root)
    expect(
      await createMetadataLockedPackageOperationReceiptPort(storage.metadata).read('operation-a'),
    ).toEqual(committed)
    await storage.close()
  })

  it('makes prepare idempotent but fails closed on conflicting operationId reuse', async () => {
    const storage = await openMetadata(temp())
    try {
      const receipts = createMetadataLockedPackageOperationReceiptPort(storage.metadata)
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
    const leftStorage = await openMetadata(root)
    const rightStorage = await openMetadata(root)
    try {
      const left = createMetadataLockedPackageOperationReceiptPort(leftStorage.metadata)
      const right = createMetadataLockedPackageOperationReceiptPort(rightStorage.metadata)
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

  it('admits exactly 4096 receipts and rejects 4097', async () => {
    const storage = await openMetadata(temp())
    try {
      const receipts = createMetadataLockedPackageOperationReceiptPort(storage.metadata)
      const ns = storage.metadata.namespace(OWNER, 'receipts')
      const resultJson = JSON.stringify(prepared().result)
      ns.transaction(() => {
        for (let n = 0; n < 4095; n++)
          ns.set(`receipt:operation-${n}`, {
            operation_id: `operation-${n}`,
            kind: 'activate',
            phase: 'prepared',
            fencing: `fence-${n}`,
            store_binding_sha256: hash('1'),
            request_sha256: hash('2'),
            before_state_sha256: hash('3'),
            after_state_sha256: hash('4'),
            result_json: resultJson,
          })
      })
      expect(await receipts.prepare(prepared('last'))).toMatchObject({
        operationId: 'last',
        phase: 'prepared',
      })
      await expect(receipts.prepare(prepared('overflow'))).rejects.toThrow('E_LOCKED_PACKAGE_RECEIPT_LIMIT')
      expect(await receipts.read('overflow')).toBeNull()
    } finally {
      await storage.close()
    }
  })

  it('refuses a receipt store of another version before every operation', async () => {
    const storage = await openMetadata(temp())
    try {
      const receipts = createMetadataLockedPackageOperationReceiptPort(storage.metadata)
      const receipt = await receipts.prepare(prepared())
      storage.metadata.namespace(OWNER, 'receipts').set('version', 2)
      await expect(receipts.read(receipt.operationId)).rejects.toThrow('E_LOCKED_PACKAGE_RECEIPT_SCHEMA')
      await expect(receipts.prepare(prepared('other'))).rejects.toThrow('E_LOCKED_PACKAGE_RECEIPT_SCHEMA')
      expect(() => createMetadataLockedPackageOperationReceiptPort(storage.metadata)).toThrow(
        'E_LOCKED_PACKAGE_RECEIPT_SCHEMA',
      )
    } finally {
      await storage.close()
    }
  })

  it('refuses credentialed provenance without persisting it', async () => {
    const root = temp()
    const storage = await openMetadata(root)
    const receipts = createMetadataLockedPackageOperationReceiptPort(storage.metadata)
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

it('persists and fences non-SQL receipts, and refuses malformed metadata', async () => {
  const { persistenceProvider } = await import(
    new URL('../../../../examples/persistence/src/index.ts', import.meta.url).href
  )
  const { createMetadataLockedPackageOperationReceiptPort } = await import(
    '../../src/computer-use/locked-package-receipts-sqlite.js'
  )
  const root = temp()
  const first = await persistenceProvider.open({ dataDir: root })
  const receipts = createMetadataLockedPackageOperationReceiptPort(first.metadata)
  const receipt = await receipts.prepare(prepared())
  expect(await receipts.prepare(prepared())).toEqual(receipt)
  await expect(receipts.prepare({ ...prepared(), afterStateSha256: hash('9') })).rejects.toThrow(
    'E_LOCKED_PACKAGE_RECEIPT_CONFLICT',
  )
  await expect(receipts.commit({ operationId: receipt.operationId, fencing: 'wrong-fence' })).rejects.toThrow(
    'E_LOCKED_PACKAGE_RECEIPT_FENCE',
  )
  await first.close()
  const second = await persistenceProvider.open({ dataDir: root })
  try {
    const restored = createMetadataLockedPackageOperationReceiptPort(second.metadata)
    expect(await restored.read(receipt.operationId)).toEqual(receipt)
    expect(await restored.commit({ operationId: receipt.operationId, fencing: receipt.fencing })).toEqual({
      ...receipt,
      phase: 'committed',
    })
    const ns = second.metadata.namespace(OWNER, 'receipts')
    ns.set('receipt:corrupt', {})
    await expect(restored.read(receipt.operationId)).rejects.toThrow('E_LOCKED_PACKAGE_RECEIPT_CORRUPT')
  } finally {
    await second.close()
  }
})
