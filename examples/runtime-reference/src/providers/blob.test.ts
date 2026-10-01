import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import { createConformanceHarness, SCENARIOS } from '@agnes/extension-api/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BlobContractPort } from '../../../../packages/extension-api/testkit/runtime/contracts/blob.js'
import { createReferenceRegistry } from '../index.js'
import { BLOB_PROVIDER, type BlobStore, openBlobStore, PIECE_BYTES } from './blob.js'
import { bindBlobContract, damage } from './blob-contract.js'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (size: number) => new Uint8Array(size).map((_, index) => (index * 13) % 256)

function ctx(authorizationRef = 'reader', signal = new AbortController().signal): CallContext {
  return {
    principalRef: 'user-1',
    scope: { kind: 'runtime', installationId: 'install-1', runtimeId: 'runtime-1' },
    bindingId: 'binding-1',
    invocationId: 'invocation-1',
    deadline: '2026-10-02T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef,
    signal,
  }
}

const refused = (outcome: Outcome<unknown>) => (outcome.ok ? null : outcome.error.detailCode)

function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.value
}

async function collect(stream: { chunks: AsyncIterable<Uint8Array> }): Promise<number[]> {
  const sizes: number[] = []
  for await (const chunk of stream.chunks) sizes.push(chunk.byteLength)
  return sizes
}

let directory: string
let path: string
let store: BlobStore

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'reference-blob-'))
  path = join(directory, 'blob.sqlite')
  store = openBlobStore(path, { authorizeRead: (context) => context.authorizationRef === 'reader' })
})

afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('reference blob store', () => {
  it('reads ranges across piece boundaries and streams one piece per pull', async () => {
    const bytes = bytesOf(PIECE_BYTES * 2 + 5)
    const ref = store.seed(bytes, 'application/pdf')
    expect(ref).toMatchObject({ bytes: bytes.byteLength, digest: sha(bytes), mediaType: 'application/pdf' })
    const across = must(await store.blobRead.readRange({ ref, offset: PIECE_BYTES - 2, length: 4 }, ctx()))
    expect(across).toEqual({
      bytes: bytes.subarray(PIECE_BYTES - 2, PIECE_BYTES + 2),
      offset: PIECE_BYTES - 2,
      totalBytes: bytes.byteLength,
      digest: sha(bytes.subarray(PIECE_BYTES - 2, PIECE_BYTES + 2)),
    })
    const stream = must(await store.blobRead.openRead({ ref, offset: 3 }, ctx()))
    expect(await collect(stream)).toEqual([PIECE_BYTES - 3, PIECE_BYTES, 5])
    expect(await stream.ended).toEqual({
      ok: true,
      value: { bytes: bytes.byteLength - 3, digest: sha(bytes.subarray(3)) },
    })
  })

  it('refuses every read without a Host read check, and a reference to another object', async () => {
    const ref = store.seed(bytesOf(4))
    const unchecked = openBlobStore(path)
    try {
      expect(refused(await unchecked.blobRead.readRange({ ref, offset: 0, length: 1 }, ctx()))).toBe(
        'blocked',
      )
    } finally {
      unchecked.close()
    }
    const other = store.seed(bytesOf(5))
    const forged = { ...ref, pinId: other.pinId }
    expect(refused(await store.blobRead.readRange({ ref: forged, offset: 0, length: 1 }, ctx()))).toBe(
      'not_found',
    )
    expect(refused(await store.blobRead.openRead({ ref: { ...ref, bytes: 5 }, offset: 0 }, ctx()))).toBe(
      'not_found',
    )
  })

  it('finds a damaged piece at the read that needs it', async () => {
    const bytes = bytesOf(PIECE_BYTES + 10)
    const ref = store.seed(bytes)
    const changed = bytes.slice()
    changed[PIECE_BYTES + 1] = (changed[PIECE_BYTES + 1] ?? 0) ^ 1
    damage(path, ref.blobId, changed)
    expect(must(await store.blobRead.readRange({ ref, offset: 0, length: 8 }, ctx())).bytes).toEqual(
      bytes.subarray(0, 8),
    )
    expect(refused(await store.blobRead.readRange({ ref, offset: PIECE_BYTES, length: 8 }, ctx()))).toBe(
      'integrity',
    )
  })

  it('keeps pinned objects across a reopen and refuses every call once closed', async () => {
    const bytes = bytesOf(9)
    const ref = store.seed(bytes)
    store.close()
    expect(() => store.seed(bytes)).toThrow('blob store is closed')
    expect(refused(await store.blobRead.readRange({ ref, offset: 0, length: 9 }, ctx()))).toBe('blocked')
    expect(existsSync(path)).toBe(true)
    store = openBlobStore(path, { authorizeRead: () => true })
    expect(must(await store.blobRead.readRange({ ref, offset: 0, length: 9 }, ctx())).digest).toBe(sha(bytes))
  })
})

describe('reference blob: conformance', () => {
  it('fills the blob slot of the reference registry', () => {
    const slot = createReferenceRegistry([BLOB_PROVIDER]).find((item) => item.contract === 'agh.blob')
    expect(slot?.provider).toEqual(BLOB_PROVIDER)
    expect(slot?.providerFile).toBe('examples/runtime-reference/src/providers/blob.ts')
    expect(existsSync(new URL(`../../../../${slot?.providerFile}`, import.meta.url))).toBe(true)
  })

  async function runContract(change: (port: BlobContractPort) => BlobContractPort) {
    const harness = createConformanceHarness()
    const bound = bindBlobContract(harness, 'reference-blob-conformance', { change })
    try {
      return await harness.run({
        contracts: ['agh.blob'],
        providers: [BLOB_PROVIDER.id],
        command: 'reference-blob-conformance',
        clock: { startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z' },
      })
    } finally {
      bound.close()
    }
  }

  it('passes select, normal, deny, cancel, recover and dispose', async () => {
    const report = await runContract((port) => port)
    expect(report.assertions.map((item) => [item.scenario, item.status])).toEqual(
      SCENARIOS.map((scenario) => [scenario, 'passed']),
    )
    expect(report.status).toBe('passed')
    expect(report.failures).toEqual([])
  })

  it('fails a scenario whose observations break the contract', async () => {
    const report = await runContract((port) => ({
      ...port,
      recover: async (context) => ({ ...(await port.recover(context)), after: { refused: 'not_found' } }),
    }))
    expect(report.assertions.filter((item) => item.status === 'failed').map((item) => item.scenario)).toEqual(
      ['recover'],
    )
    expect(report.status).toBe('failed')
  })
})
