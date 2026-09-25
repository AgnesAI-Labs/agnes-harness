import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type LockedPackageOperationReceipt,
  type LockedPackageOperationReceiptPort,
  reconcileLockedPackageOperation,
} from '../src/computer-use/locked-package.js'
import {
  activateLockedPackage as activateLockedPackageWithReceipt,
  canonicalLockedPackagePayload,
  confirmLockedPackageLkg,
  type LockedPackageManifest,
  parseLockedPackageManifest,
  rollbackLockedPackage,
} from '../src/index.js'

const roots: string[] = []
let operationSequence = 0

class MemoryReceiptPort implements LockedPackageOperationReceiptPort {
  readonly receipts = new Map<string, LockedPackageOperationReceipt>()
  fencing = 0
  failCommitAfterWrite = false
  failCommitBeforeWrite = false

  async read(operationId: string) {
    return this.receipts.get(operationId) ?? null
  }

  async prepare(receipt: Omit<LockedPackageOperationReceipt, 'fencing' | 'phase'>) {
    const existing = this.receipts.get(receipt.operationId)
    if (existing) return existing
    const prepared: LockedPackageOperationReceipt = {
      ...receipt,
      phase: 'prepared',
      fencing: `fence-${++this.fencing}`,
    }
    this.receipts.set(receipt.operationId, prepared)
    return prepared
  }

  async commit(input: { operationId: string; fencing: string }) {
    const existing = this.receipts.get(input.operationId)
    if (!existing || existing.fencing !== input.fencing) throw new Error('host fencing mismatch')
    if (this.failCommitBeforeWrite) {
      this.failCommitBeforeWrite = false
      throw new Error('secret-host-error')
    }
    const committed: LockedPackageOperationReceipt = { ...existing, phase: 'committed' }
    this.receipts.set(input.operationId, committed)
    if (this.failCommitAfterWrite) {
      this.failCommitAfterWrite = false
      throw new Error('secret-host-error')
    }
    return committed
  }
}

class AliasingReceiptPort extends MemoryReceiptPort {
  mutationBlocked = false

  override async prepare(receipt: Omit<LockedPackageOperationReceipt, 'fencing' | 'phase'>) {
    try {
      receipt.result.directory = 'attacker-controlled'
    } catch {
      this.mutationBlocked = true
    }
    return super.prepare(receipt)
  }
}

const receiptPort = new MemoryReceiptPort()
const operation = (receipts: LockedPackageOperationReceiptPort = receiptPort) => ({
  operationId: `operation-${++operationSequence}`,
  receipts,
})

const activateLockedPackage = (
  input: Omit<Parameters<typeof activateLockedPackageWithReceipt>[0], 'operation'> & {
    operation?: Parameters<typeof activateLockedPackageWithReceipt>[0]['operation']
  },
) => activateLockedPackageWithReceipt({ ...input, operation: input.operation ?? operation() })

// Synthetic filesystem input only. It is not provider, platform, signature, or release evidence.
async function fixture(content = '# reviewed skill\n') {
  const root = await mkdtemp(join(tmpdir(), 'agnes-locked-package-'))
  roots.push(root)
  const source = join(root, 'source')
  const store = join(root, 'store')
  await mkdir(join(source, 'skill'), { recursive: true })
  createPrivateDirectorySync(store)
  await writeFile(join(source, 'skill/SKILL.md'), content)
  const archive = new TextEncoder().encode(`synthetic locked archive\n${content}`)
  const fileSha256 = createHash('sha256').update(content).digest('hex')
  const packageSha256 = createHash('sha256')
    .update(`skill/SKILL.md\0${fileSha256}\0${Buffer.byteLength(content)}\n`)
    .digest('hex')
  const manifest: LockedPackageManifest = {
    schemaVersion: 1,
    packageId: 'agnes-computer-use-skill',
    version: '0.1.0',
    packageSha256,
    provenance: {
      source: 'https://github.com/NousResearch/hermes-agent',
      revision: 'f'.repeat(40),
      artifactSha256: createHash('sha256').update(archive).digest('hex'),
    },
    signature: {
      algorithm: 'ed25519',
      keyId: 'agnes-release-1',
      value: Buffer.alloc(64, 1).toString('base64'),
    },
    compatibility: {
      agnesApiVersions: ['1.0'],
      platforms: ['darwin-arm64'],
      osVersions: ['15.6'],
    },
    files: [{ path: 'skill/SKILL.md', sha256: fileSha256, size: Buffer.byteLength(content) }],
  }
  return { root, source, store, manifest, archive }
}

const environment = { agnesApiVersion: '1.0', platform: 'darwin-arm64', osVersion: '15.6' }
const verifySignature = vi.fn(async ({ keyId }: { keyId: string }) => ({
  verified: true as const,
  keyId,
  publisher: 'agnes-release',
  evidenceId: 'sigstore-proof-1',
}))
const stored = (storeDirectory: string) => ({
  storeDirectory,
  environment,
  verifySignature,
  operation: operation(),
})
const artifact = (sourceArchiveBytes: Uint8Array) => ({ sourceArchiveBytes })

afterEach(async () => {
  verifySignature.mockClear()
  receiptPort.receipts.clear()
  receiptPort.failCommitAfterWrite = false
  receiptPort.failCommitBeforeWrite = false
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// Store activation deliberately fails closed on Windows until a trusted directory-handle
// implementation exists, so cases that need a working store run only where activation is supported.
const storeIt = it.skipIf(process.platform === 'win32')

describe('locked Computer Use package activation', () => {
  storeIt('verifies, stages and atomically selects a candidate without claiming it is LKG', async () => {
    const { source, store, manifest, archive } = await fixture()
    const record = await activateLockedPackage({
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment,
      verifySignature,
      now: () => new Date('2026-09-17T00:00:00.000Z'),
    })
    expect(record).toMatchObject({
      packageSha256: manifest.packageSha256,
      activatedAt: '2026-09-17T00:00:00.000Z',
    })
    const state = JSON.parse(await readFile(join(store, 'activation.json'), 'utf8'))
    expect(state).toMatchObject({ active: record, lkg: null })
    expect(await readFile(join(store, 'versions', record.directory, 'skill/SKILL.md'), 'utf8')).toContain(
      'reviewed skill',
    )
    expect(verifySignature).toHaveBeenCalledTimes(2)
  })

  storeIt('requires an explicit confirmation before rollback can select LKG', async () => {
    const first = await fixture('first\n')
    const one = await activateLockedPackage({
      ...first,
      sourceDirectory: first.source,
      storeDirectory: first.store,
      ...artifact(first.archive),
      environment,
      verifySignature,
    })
    await expect(rollbackLockedPackage(stored(first.store))).rejects.toThrow('no last-known-good')
    await confirmLockedPackageLkg(stored(first.store))

    const secondRoot = join(first.root, 'second')
    await mkdir(join(secondRoot, 'skill'), { recursive: true })
    await writeFile(join(secondRoot, 'skill/SKILL.md'), 'second\n')
    const secondArchive = new TextEncoder().encode('synthetic locked archive\nsecond\n')
    const sha = createHash('sha256').update('second\n').digest('hex')
    const secondManifest = {
      ...first.manifest,
      version: '0.2.0',
      provenance: {
        ...first.manifest.provenance,
        artifactSha256: createHash('sha256').update(secondArchive).digest('hex'),
      },
      files: [{ path: 'skill/SKILL.md', sha256: sha, size: 7 }],
      packageSha256: createHash('sha256').update(`skill/SKILL.md\0${sha}\0${7}\n`).digest('hex'),
    }
    await activateLockedPackage({
      sourceDirectory: secondRoot,
      storeDirectory: first.store,
      manifest: secondManifest,
      ...artifact(secondArchive),
      environment,
      verifySignature,
    })
    expect((await rollbackLockedPackage(stored(first.store))).directory).toBe(one.directory)
  })

  it.each([
    [
      'unknown manifest field',
      (manifest: Record<string, unknown>) => Object.assign(manifest, { token: 'secret' }),
    ],
    [
      'path escape',
      (manifest: Record<string, unknown>) => {
        const entry = (manifest.files as object[])[0]
        if (entry) Object.assign(entry, { path: '../SKILL.md' })
      },
    ],
    [
      'credential URL',
      (manifest: Record<string, unknown>) =>
        Object.assign(manifest.provenance as object, { source: 'https://token@example.test/pkg' }),
    ],
    [
      'unverified OS',
      (manifest: Record<string, unknown>) =>
        Object.assign(manifest.compatibility as object, { osVersions: ['14.0'] }),
    ],
  ])('fails closed for %s without invoking trusted activation', async (_name, mutate) => {
    const { source, store, manifest, archive } = await fixture()
    mutate(manifest as unknown as Record<string, unknown>)
    await expect(
      activateLockedPackage({
        sourceDirectory: source,
        storeDirectory: store,
        manifest,
        ...artifact(archive),
        environment,
        verifySignature,
      }),
    ).rejects.toThrow(/locked package/)
    expect(verifySignature).not.toHaveBeenCalled()
    await expect(readFile(join(store, 'activation.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  storeIt('rejects missing signature evidence, digest mutation, symlinks and extra files', async () => {
    const missing = await fixture()
    await expect(
      activateLockedPackage({
        sourceDirectory: missing.source,
        storeDirectory: missing.store,
        manifest: missing.manifest,
        ...artifact(missing.archive),
        environment,
        verifySignature: async () => ({ verified: true, keyId: 'wrong', publisher: 'p', evidenceId: 'e' }),
      }),
    ).rejects.toThrow('signature evidence')

    const changed = await fixture()
    await writeFile(join(changed.source, 'skill/SKILL.md'), 'tampered\n')
    await expect(
      activateLockedPackage({
        ...changed,
        sourceDirectory: changed.source,
        storeDirectory: changed.store,
        ...artifact(changed.archive),
        environment,
        verifySignature,
      }),
    ).rejects.toThrow('digest or size')

    const linked = await fixture()
    await rm(join(linked.source, 'skill/SKILL.md'))
    await symlink(join(missing.source, 'skill/SKILL.md'), join(linked.source, 'skill/SKILL.md'))
    await expect(
      activateLockedPackage({
        ...linked,
        sourceDirectory: linked.source,
        storeDirectory: linked.store,
        ...artifact(linked.archive),
        environment,
        verifySignature,
      }),
    ).rejects.toThrow('symlinks')

    const extra = await fixture()
    await writeFile(join(extra.source, 'unexpected'), 'x')
    await expect(
      activateLockedPackage({
        ...extra,
        sourceDirectory: extra.source,
        storeDirectory: extra.store,
        ...artifact(extra.archive),
        environment,
        verifySignature,
      }),
    ).rejects.toThrow('do not match')
  })

  storeIt('rejects a symlinked versions directory before publishing outside the store', async () => {
    const { root, source, store, manifest, archive } = await fixture()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(store, 'versions'))
    await expect(
      activateLockedPackage({
        sourceDirectory: source,
        storeDirectory: store,
        manifest,
        ...artifact(archive),
        environment,
        verifySignature,
      }),
    ).rejects.toThrow(/real directory|unsafe directory link/)
    expect(await readFile(join(source, 'skill/SKILL.md'), 'utf8')).toContain('reviewed skill')
  })

  storeIt('will not confirm a candidate whose stored bytes changed after activation', async () => {
    const { source, store, manifest, archive } = await fixture()
    const record = await activateLockedPackage({
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment,
      verifySignature,
    })
    await writeFile(join(store, 'versions', record.directory, 'skill/SKILL.md'), 'changed after activation\n')
    await expect(confirmLockedPackageLkg(stored(store))).rejects.toThrow(/size limit|digest or size/)
    const state = JSON.parse(await readFile(join(store, 'activation.json'), 'utf8'))
    expect(state.lkg).toBeNull()
  })

  it('uses a stable canonical payload and rejects non-NFC and resource excess', async () => {
    const { manifest } = await fixture()
    expect(createHash('sha256').update(canonicalLockedPackagePayload(manifest)).digest('hex')).toBe(
      '3da38b6b60512d275d390bb5e2f6f02735df911a9faa151d0b28ea8252d83c79',
    )
    expect(() =>
      parseLockedPackageManifest({
        ...manifest,
        compatibility: { ...manifest.compatibility, osVersions: ['e\u0301'] },
      }),
    ).toThrow(/invalid value/)
    expect(() =>
      parseLockedPackageManifest({
        ...manifest,
        files: Array.from({ length: 129 }, (_, index) => ({
          path: `skill/file-${index}`,
          sha256: 'a'.repeat(64),
          size: 1,
        })),
      }),
    ).toThrow(/files exceeds its item limit/)
    expect(() =>
      parseLockedPackageManifest({
        ...manifest,
        files: [{ ...manifest.files[0], size: 192 * 1024 + 1 }],
      }),
    ).toThrow(/file size/)
    expect(() =>
      parseLockedPackageManifest({
        ...manifest,
        provenance: { ...manifest.provenance, source: `https://example.test/${'a'.repeat(2100)}` },
      }),
    ).toThrow(/length limit/)
    expect(() =>
      parseLockedPackageManifest({
        ...manifest,
        compatibility: {
          ...manifest.compatibility,
          platforms: Array.from({ length: 65 }, (_, index) => `platform-${index}`),
        },
      }),
    ).toThrow(/platforms exceeds its item limit/)
  })

  storeIt('holds a fail-closed cross-process lock across verification and publication', async () => {
    const { source, store, manifest, archive } = await fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let calls = 0
    const blockingVerifier = async ({ keyId }: { keyId: string }) => {
      calls += 1
      if (calls === 1) {
        entered()
        await gate
      }
      return { verified: true as const, keyId, publisher: 'agnes-release', evidenceId: 'proof' }
    }
    const first = activateLockedPackage({
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment,
      verifySignature: blockingVerifier,
    })
    // Wait for the verifier to be entered, but surface an early rejection instead of hanging on it.
    await Promise.race([started, first])
    await expect(
      activateLockedPackage({
        sourceDirectory: source,
        storeDirectory: store,
        manifest,
        ...artifact(archive),
        environment,
        verifySignature,
      }),
    ).rejects.toThrow('activation is busy')
    release()
    await first
  })

  storeIt('rejects forged nested state, changed trust, and a symlinked selected package', async () => {
    const { root, source, store, manifest, archive } = await fixture()
    const record = await activateLockedPackage({
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment,
      verifySignature,
    })
    const statePath = join(store, 'activation.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    state.active.signature.unexpected = true
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
    await expect(confirmLockedPackageLkg(stored(store))).rejects.toThrow(/missing or unknown fields/)
    delete state.active.signature.unexpected
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
    await expect(
      confirmLockedPackageLkg({
        ...stored(store),
        environment: { ...environment, osVersion: 'unreviewed' },
      }),
    ).rejects.toThrow(/compatibility is unverified/)
    await expect(
      confirmLockedPackageLkg({
        ...stored(store),
        verifySignature: async ({ keyId }) => ({
          verified: true,
          keyId,
          publisher: 'different-publisher',
          evidenceId: 'different-proof',
        }),
      }),
    ).rejects.toThrow(/metadata does not match/)

    const packagePath = join(store, 'versions', record.directory)
    const moved = join(root, 'moved-package')
    await rename(packagePath, moved)
    await symlink(moved, packagePath)
    await expect(confirmLockedPackageLkg(stored(store))).rejects.toThrow(/real directory|escapes/)
  })

  storeIt('keeps the prior active record when a destination collision aborts publication', async () => {
    const { source, store, manifest, archive } = await fixture()
    const active = await activateLockedPackage({
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment,
      verifySignature,
    })
    await expect(
      activateLockedPackage({
        sourceDirectory: source,
        storeDirectory: store,
        manifest,
        ...artifact(archive),
        environment,
        verifySignature,
      }),
    ).resolves.toEqual(active)
    const state = JSON.parse(await readFile(join(store, 'activation.json'), 'utf8'))
    expect(state.active).toEqual(active)
  })

  storeIt(
    'hashes archive bytes internally and reconciles a crash after destination publication',
    async () => {
      const { source, store, manifest, archive } = await fixture()
      await expect(
        activateLockedPackage({
          sourceDirectory: source,
          storeDirectory: store,
          manifest,
          sourceArchiveBytes: new TextEncoder().encode('different archive bytes'),
          environment,
          verifySignature,
        }),
      ).rejects.toThrow('source artifact digest does not match')
      expect(verifySignature).not.toHaveBeenCalled()
      await expect(
        activateLockedPackage({
          sourceDirectory: source,
          storeDirectory: store,
          manifest,
          sourceArchiveBytes: new Uint8Array(8 * 1024 * 1024 + 1),
          environment,
          verifySignature,
        }),
      ).rejects.toThrow(/archive exceeds the size limit/)

      const active = await activateLockedPackage({
        sourceDirectory: source,
        storeDirectory: store,
        manifest,
        ...artifact(archive),
        environment,
        verifySignature,
      })
      await rm(join(store, 'activation.json'))
      await mkdir(join(store, '.staging-interrupted', 'skill'), { recursive: true })
      await writeFile(join(store, '.staging-interrupted', 'skill/SKILL.md'), 'partial')
      const recovered = await activateLockedPackage({
        sourceDirectory: source,
        storeDirectory: store,
        manifest,
        ...artifact(archive),
        environment,
        verifySignature,
        now: () => new Date(active.activatedAt),
      })
      expect(recovered).toEqual(active)
      await expect(readFile(join(store, '.staging-interrupted', 'skill/SKILL.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    },
  )

  storeIt('reconciles a durable prepared receipt after the state mutation without replaying it', async () => {
    const { source, store, manifest, archive } = await fixture()
    const receipts = new MemoryReceiptPort()
    const durableOperation = operation(receipts)
    receipts.failCommitBeforeWrite = true

    await expect(
      activateLockedPackageWithReceipt({
        sourceDirectory: source,
        storeDirectory: store,
        manifest,
        ...artifact(archive),
        environment,
        verifySignature,
        operation: durableOperation,
        now: () => new Date('2026-09-17T01:02:03.000Z'),
      }),
    ).rejects.toThrow('outcome is unknown')

    const prepared = receipts.receipts.get(durableOperation.operationId)
    expect(prepared).toMatchObject({ kind: 'activate', phase: 'prepared', fencing: 'fence-1' })
    const persisted = JSON.parse(await readFile(join(store, 'activation.json'), 'utf8'))
    expect(persisted.active).toEqual(prepared?.result)

    await expect(
      reconcileLockedPackageOperation({ storeDirectory: store, operation: durableOperation }),
    ).resolves.toEqual({ historyOnly: true, outcome: 'committed', record: prepared?.result })
    expect(receipts.receipts.get(durableOperation.operationId)).toMatchObject({ phase: 'committed' })

    verifySignature.mockClear()
    await expect(
      activateLockedPackageWithReceipt({
        sourceDirectory: source,
        storeDirectory: store,
        manifest,
        ...artifact(archive),
        environment,
        verifySignature,
        operation: durableOperation,
      }),
    ).resolves.toEqual(prepared?.result)
    expect(verifySignature).toHaveBeenCalledTimes(1)
  })

  storeIt('snapshots and freezes receipt proposals before invoking the Host port', async () => {
    const { source, store, manifest, archive } = await fixture()
    const receipts = new AliasingReceiptPort()
    const record = await activateLockedPackageWithReceipt({
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment,
      verifySignature,
      operation: operation(receipts),
    })
    expect(receipts.mutationBlocked).toBe(true)
    expect(record.directory).not.toBe('attacker-controlled')
    const state = JSON.parse(await readFile(join(store, 'activation.json'), 'utf8'))
    expect(state.active).toEqual(record)
  })

  storeIt('binds receipts to the canonical store and activate request', async () => {
    const first = await fixture('binding one\n')
    const second = await fixture('binding two\n')
    const receipts = new MemoryReceiptPort()
    const durableOperation = operation(receipts)
    await activateLockedPackageWithReceipt({
      sourceDirectory: first.source,
      storeDirectory: first.store,
      manifest: first.manifest,
      ...artifact(first.archive),
      environment,
      verifySignature,
      operation: durableOperation,
    })

    await expect(
      reconcileLockedPackageOperation({ storeDirectory: second.store, operation: durableOperation }),
    ).rejects.toThrow('does not match the mutation')
    await expect(
      activateLockedPackageWithReceipt({
        sourceDirectory: second.source,
        storeDirectory: first.store,
        manifest: second.manifest,
        ...artifact(second.archive),
        environment,
        verifySignature,
        operation: durableOperation,
      }),
    ).rejects.toThrow('does not match the mutation')
  })

  storeIt('re-verifies stored bytes on the committed fast path', async () => {
    const { source, store, manifest, archive } = await fixture()
    const durableOperation = operation()
    const record = await activateLockedPackageWithReceipt({
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment,
      verifySignature,
      operation: durableOperation,
    })
    await writeFile(join(store, 'versions', record.directory, 'skill/SKILL.md'), 'tampered fast path\n')
    await expect(
      activateLockedPackageWithReceipt({
        sourceDirectory: source,
        storeDirectory: store,
        manifest,
        ...artifact(archive),
        environment,
        verifySignature,
        operation: durableOperation,
      }),
    ).rejects.toThrow(/digest or size|size limit/)
  })

  it('rejects receipt-port accessors without invoking or exposing them', async () => {
    const { source, store, manifest, archive } = await fixture()
    let operationGetterCalls = 0
    const hostileOperation = { operationId: 'hostile-operation' } as Record<string, unknown>
    Object.defineProperty(hostileOperation, 'receipts', {
      enumerable: true,
      get() {
        operationGetterCalls += 1
        throw new Error('sk-secret-operation-getter')
      },
    })
    const operationError = await activateLockedPackageWithReceipt({
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment,
      verifySignature,
      operation: hostileOperation as never,
    }).catch((cause: unknown) => cause)
    expect(operationError).toBeInstanceOf(Error)
    expect((operationError as Error).message).not.toContain('sk-secret-operation-getter')
    expect(operationGetterCalls).toBe(0)

    let getterCalls = 0
    const receipts = {
      prepare: async () => {
        throw new Error('unused')
      },
      commit: async () => {
        throw new Error('unused')
      },
    } as unknown as Record<string, unknown>
    Object.defineProperty(receipts, 'read', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('sk-secret-getter')
      },
    })
    const error = await activateLockedPackageWithReceipt({
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment,
      verifySignature,
      operation: operation(receipts as unknown as LockedPackageOperationReceiptPort),
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('sk-secret-getter')
    expect(getterCalls).toBe(0)
  })

  storeIt('snapshots environment, verifier, timeout, and clock before the first await', async () => {
    const { source, store, manifest, archive } = await fixture()
    const mutableEnvironment = { ...environment }
    const originalVerifier = vi.fn(async ({ keyId }: { keyId: string }) => ({
      verified: true as const,
      keyId,
      publisher: 'agnes-release',
      evidenceId: 'snapshot-proof',
    }))
    const args: Parameters<typeof activateLockedPackageWithReceipt>[0] = {
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment: mutableEnvironment,
      verifySignature: originalVerifier,
      verificationTimeoutMs: 1000,
      now: () => new Date('2026-09-17T03:04:05.000Z'),
      operation: operation(),
    }
    const activation = activateLockedPackageWithReceipt(args)
    mutableEnvironment.osVersion = 'hostile-after-await'
    args.verifySignature = async () => {
      throw new Error('sk-secret-late-verifier')
    }
    args.verificationTimeoutMs = 0
    args.now = () => {
      throw new Error('sk-secret-late-clock')
    }
    await expect(activation).resolves.toMatchObject({ activatedAt: '2026-09-17T03:04:05.000Z' })
    expect(originalVerifier).toHaveBeenCalled()
  })

  it('rejects proxy prototypes and callable proxy methods without invoking traps', async () => {
    const { source, store, manifest, archive } = await fixture()
    let prototypeTrapCalls = 0
    const hostilePrototype = new Proxy(
      {
        read: async () => null,
        prepare: async () => {
          throw new Error('unused')
        },
        commit: async () => {
          throw new Error('unused')
        },
      },
      {
        getOwnPropertyDescriptor() {
          prototypeTrapCalls += 1
          throw new Error('sk-secret-prototype-trap')
        },
      },
    )
    const prototypeError = await activateLockedPackageWithReceipt({
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment,
      verifySignature,
      operation: operation(Object.create(hostilePrototype) as LockedPackageOperationReceiptPort),
    }).catch((cause: unknown) => cause)
    expect(prototypeError).toBeInstanceOf(Error)
    expect((prototypeError as Error).message).not.toContain('sk-secret-prototype-trap')
    expect(prototypeTrapCalls).toBe(0)

    let callableTrapCalls = 0
    const callable = new Proxy(async () => null, {
      apply() {
        callableTrapCalls += 1
        throw new Error('sk-secret-callable-trap')
      },
    })
    const callableError = await activateLockedPackageWithReceipt({
      sourceDirectory: source,
      storeDirectory: store,
      manifest,
      ...artifact(archive),
      environment,
      verifySignature,
      operation: operation({
        read: callable as LockedPackageOperationReceiptPort['read'],
        prepare: async () => {
          throw new Error('unused')
        },
        commit: async () => {
          throw new Error('unused')
        },
      }),
    }).catch((cause: unknown) => cause)
    expect(callableError).toBeInstanceOf(Error)
    expect((callableError as Error).message).not.toContain('sk-secret-callable-trap')
    expect(callableTrapCalls).toBe(0)
  })

  storeIt('records fenced receipts for confirm and rollback and rejects operation-id reuse', async () => {
    const first = await fixture('first durable\n')
    const activateOperation = operation()
    const firstRecord = await activateLockedPackageWithReceipt({
      sourceDirectory: first.source,
      storeDirectory: first.store,
      manifest: first.manifest,
      ...artifact(first.archive),
      environment,
      verifySignature,
      operation: activateOperation,
    })
    const confirmOperation = operation()
    await confirmLockedPackageLkg({ ...stored(first.store), operation: confirmOperation })
    expect(receiptPort.receipts.get(confirmOperation.operationId)).toMatchObject({
      kind: 'confirm-lkg',
      phase: 'committed',
      result: firstRecord,
    })

    await expect(
      rollbackLockedPackage({ ...stored(first.store), operation: confirmOperation }),
    ).rejects.toThrow('does not match the mutation')

    const rollbackOperation = operation()
    await expect(
      rollbackLockedPackage({ ...stored(first.store), operation: rollbackOperation }),
    ).resolves.toEqual(firstRecord)
    expect(receiptPort.receipts.get(rollbackOperation.operationId)).toMatchObject({
      kind: 'rollback',
      phase: 'committed',
      result: firstRecord,
    })
  })

  storeIt('redacts receipt-port failures and reports a missing operation without mutation', async () => {
    const { source, store, manifest, archive } = await fixture()
    const receipts = new MemoryReceiptPort()
    const durableOperation = operation(receipts)
    receipts.failCommitAfterWrite = true
    await expect(
      activateLockedPackageWithReceipt({
        sourceDirectory: source,
        storeDirectory: store,
        manifest,
        ...artifact(archive),
        environment,
        verifySignature,
        operation: durableOperation,
      }),
    ).rejects.toThrowError(expect.not.stringContaining('secret-host-error'))
    await expect(
      reconcileLockedPackageOperation({ storeDirectory: store, operation: operation(receipts) }),
    ).resolves.toEqual({ historyOnly: true, outcome: 'not-found' })
  })

  storeIt('rejects noncanonical persisted JSON, unsafe lock files and non-private stores', async () => {
    const first = await fixture()
    const record = await activateLockedPackage({
      sourceDirectory: first.source,
      storeDirectory: first.store,
      manifest: first.manifest,
      ...artifact(first.archive),
      environment,
      verifySignature,
    })
    const manifestPath = join(first.store, 'versions', record.directory, 'locked-package.manifest.json')
    const text = await readFile(manifestPath, 'utf8')
    await writeFile(manifestPath, text.replace('{\n', '{\n  "schemaVersion": 1,\n'))
    await expect(confirmLockedPackageLkg(stored(first.store))).rejects.toThrow(/canonical JSON/)

    const invalid = await fixture()
    await writeFile(join(invalid.store, 'activation.json'), Uint8Array.from([0xff]))
    await expect(confirmLockedPackageLkg(stored(invalid.store))).rejects.toThrow()

    const linked = await fixture()
    const outside = join(linked.root, 'outside-lock')
    await writeFile(outside, '')
    await symlink(outside, join(linked.store, '.computer-use-package-lock.sqlite'))
    await expect(
      activateLockedPackage({
        sourceDirectory: linked.source,
        storeDirectory: linked.store,
        manifest: linked.manifest,
        ...artifact(linked.archive),
        environment,
        verifySignature,
      }),
    ).rejects.toThrow(/lock is unsafe/)

    const publicStore = await fixture()
    if (process.platform !== 'win32') {
      await chmod(publicStore.store, 0o755)
      await expect(
        activateLockedPackage({
          sourceDirectory: publicStore.source,
          storeDirectory: publicStore.store,
          manifest: publicStore.manifest,
          ...artifact(publicStore.archive),
          environment,
          verifySignature,
        }),
      ).rejects.toThrow(/trusted private ownership/)
    }
  })

  it('requires the canonical 64-byte signature and the canonical Skill entry', async () => {
    const { manifest } = await fixture()
    expect(() =>
      parseLockedPackageManifest({
        ...manifest,
        signature: { ...manifest.signature, value: manifest.signature.value.replace(/==$/, '') },
      }),
    ).toThrow(/signature value/)
    expect(() =>
      parseLockedPackageManifest({
        ...manifest,
        files: [{ ...manifest.files[0], path: 'skill/README.md' }],
      }),
    ).toThrow(/skill\/SKILL.md/)
  })

  it('rejects accessors and custom prototypes without invoking manifest getters', async () => {
    const { manifest } = await fixture()
    let getterCalls = 0
    const accessor = Object.create(null) as Record<string, unknown>
    for (const [key, value] of Object.entries(manifest)) accessor[key] = value
    Object.defineProperty(accessor, 'packageId', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'unsafe'
      },
    })
    expect(() => parseLockedPackageManifest(accessor)).toThrow(/unsafe property descriptors/)
    expect(getterCalls).toBe(0)

    const custom = Object.assign(Object.create({ inherited: true }) as object, manifest)
    expect(() => parseLockedPackageManifest(custom)).toThrow(/plain object/)
    expect(() => parseLockedPackageManifest(new Proxy(manifest, {}))).toThrow(/must be an object/)

    let fileGetterCalls = 0
    const files = [...manifest.files]
    Object.defineProperty(files, '0', {
      enumerable: true,
      get() {
        fileGetterCalls += 1
        return manifest.files[0]
      },
    })
    expect(() => parseLockedPackageManifest({ ...manifest, files })).toThrow(/unsafe or sparse entries/)
    expect(fileGetterCalls).toBe(0)
    expect(() => parseLockedPackageManifest({ ...manifest, files: new Proxy(manifest.files, {}) })).toThrow(
      /files must be an array/,
    )
  })

  storeIt('bounds signature verification and rejects hostile evidence without invoking getters', async () => {
    const hostile = await fixture()
    let evidenceGetterCalls = 0
    await expect(
      activateLockedPackage({
        sourceDirectory: hostile.source,
        storeDirectory: hostile.store,
        manifest: hostile.manifest,
        ...artifact(hostile.archive),
        environment,
        verifySignature: async () => {
          const evidence = {
            verified: true,
            publisher: 'agnes-release',
            evidenceId: 'proof',
          } as Record<string, unknown>
          Object.defineProperty(evidence, 'keyId', {
            enumerable: true,
            get() {
              evidenceGetterCalls += 1
              return hostile.manifest.signature.keyId
            },
          })
          return evidence as never
        },
      }),
    ).rejects.toThrow(/unsafe property descriptors/)
    expect(evidenceGetterCalls).toBe(0)

    const timed = await fixture()
    await expect(
      activateLockedPackage({
        sourceDirectory: timed.source,
        storeDirectory: timed.store,
        manifest: timed.manifest,
        ...artifact(timed.archive),
        environment,
        verifySignature: async () => new Promise<never>(() => undefined),
        verificationTimeoutMs: 5,
      }),
    ).rejects.toThrow(/verification timed out/)
    await expect(
      activateLockedPackage({
        sourceDirectory: timed.source,
        storeDirectory: timed.store,
        manifest: timed.manifest,
        ...artifact(timed.archive),
        environment,
        verifySignature,
      }),
    ).resolves.toMatchObject({ packageId: timed.manifest.packageId })
  })

  it('fails closed without native Windows security and does not misreport SQLite corruption as busy', async () => {
    const windows = await fixture()
    const platform =
      process.platform === 'win32' ? undefined : vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      await expect(
        activateLockedPackage({
          sourceDirectory: windows.source,
          storeDirectory: windows.store,
          manifest: windows.manifest,
          ...artifact(windows.archive),
          environment,
          verifySignature,
        }),
      ).rejects.toThrow(/trusted Windows directory-handle implementation/)
    } finally {
      platform?.mockRestore()
    }

    const corrupt = await fixture()
    const lock = join(corrupt.store, '.computer-use-package-lock.sqlite')
    await writeFile(lock, 'not a sqlite database', { mode: 0o600 })
    const error = await activateLockedPackage({
      sourceDirectory: corrupt.source,
      storeDirectory: corrupt.store,
      manifest: corrupt.manifest,
      ...artifact(corrupt.archive),
      environment,
      verifySignature,
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain('activation is busy')
  })

  it('does not expose rejected credential material in errors', () => {
    expect(() =>
      parseLockedPackageManifest({
        schemaVersion: 1,
        packageId: 'pkg',
        version: '1',
        packageSha256: 'a'.repeat(64),
        provenance: {
          source: 'https://sk-secret@example.test/pkg?token=also-secret',
          revision: 'f'.repeat(40),
          artifactSha256: 'b'.repeat(64),
        },
        signature: { algorithm: 'ed25519', keyId: 'key', value: Buffer.alloc(64, 1).toString('base64') },
        compatibility: { agnesApiVersions: ['1'], platforms: ['x'], osVersions: ['1'] },
        files: [{ path: 'a', sha256: 'c'.repeat(64), size: 1 }],
      }),
    ).toThrowError(expect.not.stringContaining('sk-secret'))
  })
})
