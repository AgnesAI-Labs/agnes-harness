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
