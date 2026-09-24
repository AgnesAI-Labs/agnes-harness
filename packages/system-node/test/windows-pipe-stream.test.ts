import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { type OwnedPipe, WindowsPipeStream } from '../src/windows-pipe-stream.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function fixture(overrides: Partial<OwnedPipe> = {}) {
  const owner: OwnedPipe = {
    read: vi.fn(async () => null),
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  }
  return { owner, stream: new WindowsPipeStream(owner) }
}

it('serializes bounded native writes and waits for release before emitting close', async () => {
  const writes: Buffer[] = []
  const first = deferred<void>()
  const release = deferred<void>()
  const { owner, stream } = fixture({
    write: vi.fn(async (bytes) => {
      writes.push(Buffer.from(bytes))
      if (writes.length === 1) await first.promise
    }),
    close: vi.fn(() => release.promise),
  })
  const payload = Buffer.alloc(2 * 65536 + 17, 0x61)
  const closed = once(stream, 'close')
  const onClose = vi.fn()
  stream.on('close', onClose)
  stream.end(payload)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toHaveLength(65536)
  expect(owner.close).not.toHaveBeenCalled()
  first.resolve()
  await vi.waitFor(() => expect(owner.close).toHaveBeenCalledOnce())
  expect(writes.map((bytes) => bytes.length)).toEqual([65536, 65536, 17])
  expect(Buffer.concat(writes)).toEqual(payload)
  expect(onClose).not.toHaveBeenCalled()
  release.resolve()
  await closed
  stream.destroy()
  expect(owner.close).toHaveBeenCalledOnce()
})

it('stops pulling at the readable high water mark', async () => {
  const read = deferred<Buffer | null>()
  const { owner, stream } = fixture({ read: vi.fn(() => read.promise) })
  stream.read(0)
  await vi.waitFor(() => expect(owner.read).toHaveBeenCalledOnce())
  read.resolve(Buffer.alloc(65536))
  await vi.waitFor(() => expect(stream.readableLength).toBe(65536))
  expect(owner.read).toHaveBeenCalledOnce()
  const closed = once(stream, 'close')
  stream.destroy()
  await closed
  expect(owner.close).toHaveBeenCalledOnce()
})

it('does not submit more chunks after cancellation of an in-flight write', async () => {
  const write = deferred<void>()
  const cancelled = new Error('cancelled')
  const { owner, stream } = fixture({
    write: vi.fn(() => write.promise),
    close: vi.fn(async () => {
      write.reject(cancelled)
    }),
  })
  stream.on('error', () => {})
  const completed = new Promise<Error | null | undefined>((resolve) =>
    stream.write(Buffer.alloc(131072), resolve),
  )
  const closed = new Promise<void>((resolve) => stream.once('close', resolve))
  stream.destroy()
  await closed
  expect(await completed).toBe(cancelled)
  expect(owner.write).toHaveBeenCalledOnce()
  expect(owner.close).toHaveBeenCalledOnce()
})

it.each(['sync-read', 'async-read', 'close'] as const)(
  'reports %s failures and releases once',
  async (kind) => {
    const failure = new Error(kind)
    const { owner, stream } = fixture(
      kind === 'close'
        ? {
            close: vi.fn(() => {
              throw failure
            }),
          }
        : {
            read: vi.fn(() => {
              if (kind === 'sync-read') throw failure
              return Promise.reject(failure)
            }),
          },
    )
    const error = once(stream, 'error')
    const closed = new Promise<void>((resolve) => stream.once('close', resolve))
    if (kind === 'close') stream.destroy()
    else stream.resume()
    expect((await error)[0]).toBe(failure)
    await closed
    expect(owner.close).toHaveBeenCalledOnce()
  },
)

it('rejects oversized native read results instead of bypassing the buffer contract', async () => {
  const { owner, stream } = fixture({ read: vi.fn(async () => Buffer.alloc(65537)) })
  const error = once(stream, 'error')
  const closed = new Promise<void>((resolve) => stream.once('close', resolve))
  stream.resume()
  expect((await error)[0].message).toBe('invalid Windows pipe read result')
  await closed
  expect(owner.close).toHaveBeenCalledOnce()
})

it('discards an outstanding read result after destruction', async () => {
  const read = deferred<Buffer | null>()
  const { owner, stream } = fixture({ read: vi.fn(() => read.promise) })
  const received = vi.fn()
  stream.on('data', received)
  await vi.waitFor(() => expect(owner.read).toHaveBeenCalledOnce())
  const closed = once(stream, 'close')
  stream.destroy()
  read.resolve(Buffer.from('late'))
  await closed
  expect(received).not.toHaveBeenCalled()
  expect(owner.close).toHaveBeenCalledOnce()
})
