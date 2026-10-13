import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { attachmentRefusal, uploadAttachment } from '../src/attachment-upload.js'
import { JsonRpcError } from '../src/errors.js'

const MIB = 1024 * 1024
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** A server holding uploads in memory that checks each chunk as the daemon does. */
function fakeServer(o: { failChunkAt?: number[] } = {}) {
  const uploads = new Map<string, { size: number; parts: Buffer[]; received: number }>()
  const calls: Array<{ operation: string; offset?: number; timeoutMs?: number | null }> = []
  const committed: Array<{ offset: number; bytes: number }> = []
  const failures = [...(o.failChunkAt ?? [])]
  const call = async <T>(method: string, params: unknown, c?: { timeoutMs?: number | null }): Promise<T> => {
    expect(method).toBe('_agnes/v1/attachment.upload')
    const p = params as Record<string, unknown> & { operation: string; uploadId: string }
    calls.push({
      operation: p.operation,
      ...(typeof p.offset === 'number' ? { offset: p.offset } : {}),
      ...(c && 'timeoutMs' in c ? { timeoutMs: c.timeoutMs } : {}),
    })
    const u = uploads.get(p.uploadId)
    switch (p.operation) {
      case 'start':
        if (!u) uploads.set(p.uploadId, { size: p.size as number, parts: [], received: 0 })
        return { offset: u?.received ?? 0 } as T
      case 'status':
        return { offset: u?.received ?? 0 } as T
      case 'chunk': {
        if (!u) throw new Error('no upload')
        const offset = p.offset as number
        if (failures[0] === offset) {
          failures.shift()
          throw new Error('connection lost')
        }
        if (offset !== u.received) throw new Error(`offset ${offset} != ${u.received}`)
        const bytes = Buffer.from(p.data as string, 'base64')
        expect(bytes.byteLength).toBeLessThanOrEqual(MIB)
        expect(sha(bytes)).toBe(p.sha256)
        u.parts.push(bytes)
        u.received += bytes.byteLength
        committed.push({ offset, bytes: bytes.byteLength })
        return { offset: u.received } as T
      }
      case 'finish': {
        if (!u) throw new Error('no upload')
        const all = Buffer.concat(u.parts)
        return {
          offset: all.length,
          attachment: {
            type: 'file',
            mimeType: 'a/b',
            name: 'a',
            attachment: { sha256: sha(all), bytes: all.length },
          },
        } as T
      }
      case 'cancel':
        uploads.delete(p.uploadId)
        return {} as T
      default:
        throw new Error(p.operation)
    }
  }
  return { call, calls, committed, uploads }
}

const payload = (size: number) => {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 13) & 0xff
  return bytes
}

describe('uploadAttachment', () => {
  it('sends 1 MiB chunks with their digest and reports monotonic progress', async () => {
    const server = fakeServer()
    const bytes = payload(2.5 * MIB)
    const progress: number[] = []
    const block = await uploadAttachment(
      server.call,
      's',
      { bytes: new Blob([bytes]), name: 'a', mimeType: 'a/b' },
      { onProgress: (sent, total) => progress.push(sent / total) },
    )
    expect(block).toMatchObject({ attachment: { sha256: sha(bytes), bytes: bytes.length } })
    expect(server.committed).toEqual([
      { offset: 0, bytes: MIB },
      { offset: MIB, bytes: MIB },
      { offset: 2 * MIB, bytes: 0.5 * MIB },
    ])
    expect(progress).toEqual([0.4, 0.8, 1])
    // The commit has no deadline: syncing a large object may outlast a request.
    expect(server.calls.at(-1)).toEqual({ operation: 'finish', timeoutMs: null })
  })

  it('resumes from the server’s offset after a failed chunk, sending every chunk exactly once', async () => {
    const server = fakeServer({ failChunkAt: [MIB] })
    const bytes = payload(3 * MIB)
    const progress: number[] = []
    const input = { bytes, name: 'a', mimeType: 'a/b' }
    const onProgress = (sent: number) => progress.push(sent)
    const failure = await uploadAttachment(server.call, 's', input, { onProgress }).catch((e: unknown) => e)
    const uploadId = (failure as { uploadId?: string }).uploadId
    expect(uploadId).toMatch(/^[0-9a-f-]{36}$/)
    const block = await uploadAttachment(server.call, 's', input, {
      onProgress,
      uploadId: uploadId as string,
    })
    expect(block).toMatchObject({ attachment: { sha256: sha(bytes) } })
    expect(server.committed.map((c) => c.offset)).toEqual([0, MIB, 2 * MIB])
    const resumed = server.calls.slice(server.calls.findIndex((c) => c.operation === 'status'))
    expect(resumed.map((c) => c.operation)).toEqual(['status', 'chunk', 'chunk', 'finish'])
    expect(progress).toEqual([MIB, MIB, 2 * MIB, 3 * MIB])
    for (let i = 1; i < progress.length; i++)
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1] as number)
  })

  it('tells the server to drop the upload when the signal aborts', async () => {
    const server = fakeServer()
    const abort = new AbortController()
    const failure = await uploadAttachment(
      server.call,
      's',
      { bytes: payload(3 * MIB), name: 'a', mimeType: 'a/b' },
      { signal: abort.signal, onProgress: () => abort.abort() },
    ).catch((e: unknown) => e)
    expect(abort.signal.aborted).toBe(true)
    expect(failure).toBeDefined()
    expect(server.calls.map((c) => c.operation)).toEqual(['start', 'chunk', 'cancel'])
    expect(server.uploads.size).toBe(0)
  })

  it('passes the thumbnail purpose through', async () => {
    const server = fakeServer()
    const seen: unknown[] = []
    await uploadAttachment(
      (m, p, c) => {
        seen.push(p)
        return server.call(m, p, c)
      },
      's',
      { bytes: payload(10), name: 't.jpg', mimeType: 'image/jpeg', purpose: 'thumbnail' },
    )
    expect(seen[0]).toMatchObject({ operation: 'start', purpose: 'thumbnail', size: 10 })
  })
})

describe('attachmentRefusal', () => {
  it('names an attachment refusal by its code, and nothing else', () => {
    const refused = new JsonRpcError({
      code: -32011,
      message: 'SEMANTIC_REJECTED',
      data: { code: 'ATTACHMENT_NOT_AUTHORIZED', reason: 'attachment-not-authorized' },
    })
    expect(attachmentRefusal(refused)).toBe('ATTACHMENT_NOT_AUTHORIZED')
    expect(
      attachmentRefusal(
        new JsonRpcError({ code: -32011, message: 'SEMANTIC_REJECTED', data: { code: 'UPLOAD_OFFSET' } }),
      ),
    ).toBe('UPLOAD_OFFSET')
    expect(
      attachmentRefusal(
        new JsonRpcError({ code: -32603, message: 'INTERNAL_ERROR', data: { code: 'INTERNAL' } }),
      ),
    ).toBeUndefined()
    expect(attachmentRefusal(new Error('x'))).toBeUndefined()
  })
})
