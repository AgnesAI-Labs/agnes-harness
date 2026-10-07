import { ARTIFACT_READ_RPC_MAX_BYTES } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { downloadArtifact } from '../src/artifact-download.js'
import type { HostAgnesClient } from '../src/services.js'

afterEach(() => vi.restoreAllMocks())
it('downloads bounded authorized ranges, checks identity/digest, and releases the object URL', async () => {
  const bytes = new Uint8Array(ARTIFACT_READ_RPC_MAX_BYTES + 7).fill(120)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const base64 = (data: Uint8Array) => btoa(Array.from(data, (b) => String.fromCharCode(b)).join(''))
  const artifact = { sha256: sha256, size: bytes.length, mime: 'text/html' }
  const call = vi.fn(async (_method, args: { range: string }) => {
    const [, from, through] = /^bytes=(\d+)-(\d+)$/.exec(args.range)!
    const start = Number(from),
      end = Number(through) + 1
    return {
      ok: true,
      status: 206,
      artifact,
      contentLength: end - start,
      contentRange: `bytes ${start}-${end - 1}/${bytes.length}`,
      base64: base64(bytes.subarray(start, end)),
    }
  })
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:deliverable')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const client = { call } as unknown as Pick<HostAgnesClient, 'call'>
  const loaded = await downloadArtifact(client, 'session', 'main', artifact)
  expect(call.mock.calls.map((row) => row[1])).toEqual([
    { sessionId: 'session', laneId: 'main', artifact, range: `bytes=0-${ARTIFACT_READ_RPC_MAX_BYTES - 1}` },
    {
      sessionId: 'session',
      laneId: 'main',
      artifact,
      range: `bytes=${ARTIFACT_READ_RPC_MAX_BYTES}-${bytes.length - 1}`,
    },
  ])
  expect((create.mock.calls[0]?.[0] as Blob | undefined)?.type).toBe('application/octet-stream')
  loaded.release()
  expect(revoke).toHaveBeenCalledWith('blob:deliverable')
  call.mockImplementation(async () => ({
    ok: true,
    status: 206,
    artifact,
    contentLength: ARTIFACT_READ_RPC_MAX_BYTES,
    contentRange: `bytes 0-${ARTIFACT_READ_RPC_MAX_BYTES - 1}/${bytes.length}`,
    base64: base64(new Uint8Array(ARTIFACT_READ_RPC_MAX_BYTES).fill(121)),
  }))
  await expect(downloadArtifact(client, 'session', 'main', artifact)).rejects.toThrow('identity mismatch')
  const small = { ...artifact, size: 1 }
  call.mockImplementation(
    async () => ({ ok: true, status: 200, artifact: small, contentLength: 1, base64: 'eA==' }) as never,
  )
  await expect(downloadArtifact(client, 'session', 'main', small)).rejects.toThrow('digest mismatch')
  expect(create).toHaveBeenCalledTimes(1)
})
