import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import { artifactsLocal } from '../src/seam.js'

const SHA_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'

afterEach(() => vi.useRealTimers())

describe('artifacts-local put/get', () => {
  it('stores content-addressed under dataDir/artifacts/sha256/<2>/<hex> and reads it back', async () => {
    const init = fakeSeamInit()
    const seam = await artifactsLocal(init)
    const bytes = new TextEncoder().encode('hello')
    const ref = await seam.put(bytes, { mime: 'text/plain' })
    expect(ref).toEqual({ sha256: SHA_HELLO, size: 5, mime: 'text/plain' })
    expect(
      await init.adapters.dataFs.stat(`${init.profile.dataDir}/artifacts/sha256/2c/${ref.sha256}`),
    ).toMatchObject({ kind: 'file', size: 5 })
    expect(new TextDecoder().decode(await seam.get(ref))).toBe('hello')
  })

  it('put is idempotent and get of unknown ref throws', async () => {
    const init = fakeSeamInit()
    const seam = await artifactsLocal(init)
    // Counted, not inferred from the file being there afterwards: writing the same bytes over the
    // same path twice leaves an identical store, so only the call itself shows the skip happened.
    const writes: string[] = []
    const write = init.adapters.dataFs.write.bind(init.adapters.dataFs)
    init.adapters.dataFs.write = async (p, d) => {
      writes.push(p)
      return write(p, d)
    }
    const a = await seam.put(new Uint8Array([1, 2, 3]))
    const b = await seam.put(new Uint8Array([1, 2, 3]))
    expect(a).toEqual(b)
    expect(writes).toHaveLength(1)
    expect(init.data.size).toBe(1)
    await expect(seam.get({ sha256: 'f'.repeat(64), size: 1, mime: 'x' })).rejects.toThrow(/not found/)
  })

  it('defaults the mime type rather than leaving the ref short a required field', async () => {
    const init = fakeSeamInit()
    const seam = await artifactsLocal(init)
    expect((await seam.put(new Uint8Array([7]))).mime).toBe('application/octet-stream')
  })

  it('persists immutable Computer Use retention metadata without classifying other artifacts', async () => {
    vi.useFakeTimers().setSystemTime(123_456)
    const init = fakeSeamInit()
    const seam = await artifactsLocal(init)
    const screenshot = await seam.put(new TextEncoder().encode('screen'), {
      mime: 'image/png',
      name: 'computer-use-screenshot.png',
    })
    const metadata = `${init.profile.dataDir}/artifacts/computer-use-meta/${screenshot.sha256.slice(0, 2)}/${screenshot.sha256}.json`
    expect(JSON.parse(new TextDecoder().decode(await init.adapters.dataFs.read(metadata)))).toEqual({
      schemaVersion: 1,
      sha256: screenshot.sha256,
      size: screenshot.size,
      createdAtMs: 123_456,
    })
    vi.setSystemTime(999_999)
    await seam.put(new TextEncoder().encode('screen'), {
      mime: 'image/png',
      name: 'computer-use-screenshot.png',
    })
    expect(JSON.parse(new TextDecoder().decode(await init.adapters.dataFs.read(metadata)))).toMatchObject({
      createdAtMs: 123_456,
    })
    const ordinary = await seam.put(new TextEncoder().encode('ordinary'), {
      mime: 'image/png',
      name: 'image.png',
    })
    expect([...init.data.keys()].some((path) => path.endsWith(`${ordinary.sha256}.json`))).toBe(false)
  })

  it('hands screenshot bytes and classification metadata only to the Host private writer', async () => {
    vi.useFakeTimers().setSystemTime(321_000)
    const init = fakeSeamInit()
    const writes: Array<{ kind: 'artifact' | 'metadata'; sha256: string; bytes: Uint8Array }> = []
    init.privateArtifactStore = {
      async put(sha256, bytes) {
        writes.push({ kind: 'artifact', sha256, bytes })
      },
      async putComputerUseMetadata(sha256, bytes) {
        writes.push({ kind: 'metadata', sha256, bytes })
      },
    }
    const seam = await artifactsLocal(init)
    const ref = await seam.put(new TextEncoder().encode('screen'), {
      mime: 'image/png',
      name: 'computer-use-screenshot.png',
    })
    expect(writes.map(({ kind, sha256 }) => ({ kind, sha256 }))).toEqual([
      { kind: 'metadata', sha256: ref.sha256 },
      { kind: 'artifact', sha256: ref.sha256 },
    ])
    expect(JSON.parse(new TextDecoder().decode(writes[0]?.bytes))).toEqual({
      schemaVersion: 1,
      sha256: ref.sha256,
      size: ref.size,
      createdAtMs: 321_000,
    })
    expect(init.data.size).toBe(0)
  })

  it('does not expose screenshot bytes when private classification fails', async () => {
    const init = fakeSeamInit()
    const put = vi.fn(async () => undefined)
    init.privateArtifactStore = {
      put,
      async putComputerUseMetadata() {
        throw new Error('metadata unavailable')
      },
    }
    const seam = await artifactsLocal(init)

    await expect(
      seam.put(new TextEncoder().encode('screen'), {
        mime: 'image/png',
        name: 'computer-use-screenshot.png',
      }),
    ).rejects.toThrow('metadata unavailable')
    expect(put).not.toHaveBeenCalled()
  })

  it('writes into dataDir, which the workspace file handle cannot reach', async () => {
    const init = fakeSeamInit({ workspaceRoot: '/work/proj', dataDir: '/home/u/.agh' })
    const seam = await artifactsLocal(init)
    await seam.put(new TextEncoder().encode('hello'))
    // The store is in the data directory and nowhere else.
    expect([...init.data.keys()]).toEqual([`/home/u/.agh/artifacts/sha256/2c/${SHA_HELLO}`])
    expect(init.mem.size).toBe(0)
    // And this is why: the workspace handle refuses the path the seam just wrote to.
    await expect(init.adapters.fs.read(`/home/u/.agh/artifacts/sha256/2c/${SHA_HELLO}`)).rejects.toThrow(
      /E_FS_DENIED/,
    )
  })

  it('re-throws a read failure that is not a missing file, rather than calling it not found', async () => {
    const init = fakeSeamInit()
    const seam = await artifactsLocal(init)
    const ref = await seam.put(new TextEncoder().encode('hello'))
    const boom = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    init.adapters.dataFs.read = () => Promise.reject(boom)
    // A disk that is failing is not an artifact that was never stored; a caller told "not found"
    // would produce the bytes again instead of stopping.
    await expect(seam.get(ref)).rejects.toThrow(/EACCES/)
  })

  it('rejects malformed artifact identities before reading the data store', async () => {
    const init = fakeSeamInit()
    const seam = await artifactsLocal(init)
    let reads = 0
    const read = init.adapters.dataFs.read.bind(init.adapters.dataFs)
    init.adapters.dataFs.read = async (...args) => {
      reads += 1
      return read(...args)
    }

    await expect(
      seam.get({ sha256: `../${'a'.repeat(61)}`, size: 1, mime: 'application/octet-stream' }),
    ).rejects.toThrow(/invalid artifact ref/)
    await expect(
      seam.get({ sha256: 'A'.repeat(64), size: 1, mime: 'application/octet-stream' }),
    ).rejects.toThrow(/invalid artifact ref/)
    await expect(
      seam.get({ sha256: 'a'.repeat(64), size: -1, mime: 'application/octet-stream' }),
    ).rejects.toThrow(/invalid artifact ref/)
    expect(reads).toBe(0)
  })

  it('recomputes digest and size so corrupt or swapped bytes cannot satisfy a ref', async () => {
    const init = fakeSeamInit()
    const seam = await artifactsLocal(init)
    const ref = await seam.put(new TextEncoder().encode('hello'))
    const path = `${init.profile.dataDir}/artifacts/sha256/2c/${ref.sha256}`

    init.data.set(path, new TextEncoder().encode('jello'))
    await expect(seam.get(ref)).rejects.toThrow(`artifact integrity mismatch: ${ref.sha256}`)

    init.data.set(path, new TextEncoder().encode('hello'))
    await expect(seam.get({ ...ref, size: ref.size + 1 })).rejects.toThrow(
      `artifact size mismatch: ${ref.sha256}`,
    )
  })

  it('rejects a replaced file with the wrong size before allocating it through read', async () => {
    const init = fakeSeamInit()
    const seam = await artifactsLocal(init)
    const ref = await seam.put(new TextEncoder().encode('hello'))
    const path = `${init.profile.dataDir}/artifacts/sha256/2c/${ref.sha256}`
    init.data.set(path, new Uint8Array(1024 * 1024))
    let reads = 0
    const read = init.adapters.dataFs.read.bind(init.adapters.dataFs)
    init.adapters.dataFs.read = async (...args) => {
      reads += 1
      return read(...args)
    }

    await expect(seam.get(ref)).rejects.toThrow(`artifact size mismatch: ${ref.sha256}`)
    expect(reads).toBe(0)
  })

  it('rejects accessor-backed ref identity without evaluating it or reading storage', async () => {
    const init = fakeSeamInit()
    const seam = await artifactsLocal(init)
    const ref = await seam.put(new TextEncoder().encode('hello'))
    let evaluated = false
    let reads = 0
    const read = init.adapters.dataFs.read.bind(init.adapters.dataFs)
    init.adapters.dataFs.read = async (...args) => {
      reads += 1
      return read(...args)
    }
    const unstable = {
      get sha256() {
        evaluated = true
        return ref.sha256
      },
      size: ref.size,
      mime: ref.mime,
    }

    await expect(seam.get(unstable)).rejects.toThrow(/identity fields must be own data properties/)
    expect(evaluated).toBe(false)
    expect(reads).toBe(0)
  })

  it('refuses the job half instead of answering with an id nothing is running', async () => {
    const seam = await artifactsLocal(fakeSeamInit())
    await expect(seam.submitJob({ idempotencyKey: 'k', payload: null })).rejects.toThrow(
      /artifact jobs are not implemented/,
    )
    await expect(seam.poll('j1')).rejects.toThrow(/artifact jobs are not implemented/)
    await expect(seam.cancel('j1')).rejects.toThrow(/artifact jobs are not implemented/)
  })
})

it('keeps independent, durable scoped upload receipts and fails closed on damaged roots', async () => {
  const { createAttachmentStore } = await import('../src/attachments.js')
  const values = new Map<string, unknown>()
  const metadata: import('@agnes/extension-api').PersistenceMetadataNamespace = {
    get: (key) => structuredClone(values.get(key)),
    set: (key, value) => {
      values.set(key, structuredClone(value))
    },
    delete: (key) => {
      values.delete(key)
    },
    entries: () => [...values].map(([key, value]) => ({ key, value: structuredClone(value) })),
    transaction: (fn) => fn(),
  }
  const init = fakeSeamInit()
  init.adapters.storage.namespace = () => metadata
  const seam = await artifactsLocal(init)
  expect(seam.attachments).toBeDefined()
  const store = seam.attachments ?? createAttachmentStore(metadata, seam)
  const scope = { sessionKey: 'session', lane: 'main' }
  const signal = new AbortController().signal
  const bytes = new TextEncoder().encode('receipt original')
  const first = await store.store(scope, bytes, 'text/plain', signal)
  const second = await store.store(scope, bytes, 'text/plain', signal)
  expect(first.artifact).toEqual(second.artifact)
  expect(first.id).not.toBe(second.id)
  const cold = createAttachmentStore(metadata, seam)
  expect(await cold.authorize(scope, first, signal)).toBe(true)
  for (const other of [
    { sessionKey: 'foreign', lane: 'main' },
    { sessionKey: 'session', lane: 'other' },
  ]) {
    expect(await cold.authorize(other, first, signal)).toBe(false)
    await expect(cold.discard(other, first.id)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_AUTHORIZED' })
  }
  expect(
    await cold.authorize(
      scope,
      { ...first, artifact: { ...first.artifact, size: bytes.length - 1 } },
      signal,
    ),
  ).toBe(false)
  expect(
    await cold.authorize(
      scope,
      { ...first, artifact: { ...first.artifact, mime: 'application/pdf' } },
      signal,
    ),
  ).toBe(false)
  await cold.discard(scope, first.id)
  expect(await cold.authorize(scope, first, signal)).toBe(false)
  expect(await cold.authorize(scope, second, signal)).toBe(true)
  expect(await cold.pendingRoots()).toEqual({ complete: true, roots: [second.artifact] })
  await cold.confirm(scope, second.id)
  await cold.confirm(scope, second.id)
  expect(await cold.pendingRoots()).toEqual({ complete: true, roots: [] })
  values.set('damaged', { artifact: { sha256: 'fake' } })
  expect(await cold.pendingRoots()).toEqual({ complete: false, roots: [] })
  await expect(cold.store(scope, bytes, 'text/plain', signal)).rejects.toMatchObject({
    code: 'ATTACHMENT_UNAVAILABLE',
  })
})

it('discards cancelled publication without consuming another receipt or retaining a failed quota reservation', async () => {
  const { createAttachmentStore } = await import('../src/attachments.js')
  const values = new Map<string, unknown>()
  const metadata: import('@agnes/extension-api').PersistenceMetadataNamespace = {
    get: (key) => structuredClone(values.get(key)),
    set: (key, value) => {
      values.set(key, structuredClone(value))
    },
    delete: (key) => {
      values.delete(key)
    },
    entries: () => [...values].map(([key, value]) => ({ key, value })),
    transaction: (fn) => fn(),
  }
  const seam = await artifactsLocal(fakeSeamInit())
  const abort = new AbortController()
  const store = createAttachmentStore(metadata, {
    put: async (...args) => {
      const ref = await seam.put(...args)
      abort.abort()
      return ref
    },
  })
  await expect(
    store.store({ sessionKey: 's', lane: 'main' }, new Uint8Array([1]), 'text/plain', abort.signal),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' })
  expect(await store.pendingRoots()).toEqual({ complete: true, roots: [] })
  const { createHash } = await import('node:crypto')
  const data = new Uint8Array([1, 2, 3])
  const artifact = { sha256: createHash('sha256').update(data).digest('hex'), size: 3, mime: 'text/plain' }
  const streamed = createAttachmentStore(metadata, seam, async (ref, source, signal) => {
    expect((await streamed.pendingRoots()).roots).toContainEqual(ref)
    for await (const chunk of source) {
      expect(chunk).toEqual(data)
      signal.throwIfAborted()
    }
  })
  async function* source() {
    yield data
  }
  const storeStream = streamed.storeStream
  if (!storeStream) throw new Error('Missing streaming capability')
  const scope = { sessionKey: 's', lane: 'main' }
  const signal = new AbortController().signal
  const receipt = await storeStream(scope, source(), artifact, signal)
  expect(await streamed.authorize(scope, receipt, signal)).toBe(true)
  const cancel = new AbortController()
  async function* cancelled() {
    yield data
    cancel.abort()
  }
  await expect(storeStream(scope, cancelled(), artifact, cancel.signal)).rejects.toMatchObject({
    code: 'ATTACHMENT_CANCELLED',
  })
  expect(await streamed.pendingRoots()).toEqual({ complete: true, roots: [artifact] })
  await streamed.discard(scope, receipt.id)
  expect(await streamed.pendingRoots()).toEqual({ complete: true, roots: [] })
})

it('caches model-specific renditions and thumbnails under independent receipt roots without modifying originals', async () => {
  const { createRequire } = await import('node:module')
  const { decodeSafeImageBytes, USER_MESSAGE_IMAGE_LIMITS } = await import('@agnes/protocol-validation')
  const sharp = createRequire(import.meta.url)('sharp') as typeof import('sharp')
  const namespaces = new Map<string, Map<string, unknown>>()
  const init = fakeSeamInit()
  init.adapters.storage.namespace = (name) => {
    let values = namespaces.get(name)
    if (!values) {
      values = new Map()
      namespaces.set(name, values)
    }
    const rows = values
    return {
      get: (key) => structuredClone(rows.get(key)),
      set: (key, value) => {
        rows.set(key, structuredClone(value))
      },
      delete: (key) => {
        rows.delete(key)
      },
      entries: () => [...rows].map(([key, value]) => ({ key, value: structuredClone(value) })),
      transaction: (fn) => fn(),
    }
  }
  const seam = await artifactsLocal(init)
  const store = seam.attachments!
  const source = await sharp({ create: { width: 128, height: 64, channels: 3, background: 'white' } })
    .png()
    .toBuffer()
  const original = await seam.put(source, { mime: 'image/png' })
  const scope = { sessionKey: 's', lane: 'main' },
    signal = new AbortController().signal
  const policy = { maxWidth: 32, maxHeight: 32, maxBytes: 4096, jpegQuality: 85 }
  const first = await store.imageVersion!(scope, original, policy, signal)
  expect(await store.imageVersion!(scope, original, policy, signal)).toEqual(first)
  expect(
    decodeSafeImageBytes(
      { bytes: await seam.get(first.artifact), mimeType: 'image/png' },
      USER_MESSAGE_IMAGE_LIMITS,
    ),
  ).toMatchObject({ width: 32, height: 16 })
  const other = await store.imageVersion!(scope, original, { ...policy, maxWidth: 16, maxHeight: 16 }, signal)
  expect(other.artifact.sha256).not.toBe(first.artifact.sha256)
  expect([...(await seam.get(original))]).toEqual([...source])
  expect((await store.pendingRoots()).roots).toEqual(expect.arrayContaining([first.artifact, other.artifact]))
  expect(await store.authorize({ sessionKey: 's', lane: 'foreign' }, first, signal)).toBe(false)
  await store.discard(scope, first.id)
  const refreshed = await store.imageVersion!(scope, original, policy, signal)
  expect(refreshed.id).not.toBe(first.id)
  expect(refreshed.artifact).toEqual(first.artifact)
})
