import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import lockValue from '../../src/computer-use/computer-use-driver-lock.json' with { type: 'json' }
import {
  type ComputerUseDriverLock,
  inspectComputerUseDriverLock,
} from '../../src/computer-use/driver-lock.js'
import { downloadLockedWindowsComputerUseDriver } from '../../src/computer-use/windows-driver-download.js'

const inspected = inspectComputerUseDriverLock(lockValue)
if (!inspected.ok) throw new Error('fixture lock is invalid')
const baseLock = inspected.lock

function fixture(bytes: Uint8Array): ComputerUseDriverLock {
  const architecture = process.arch === 'x64' ? 'x86_64' : process.arch
  const lock = structuredClone(baseLock) as ComputerUseDriverLock
  const artifact = lock.artifacts.find(
    (candidate) => candidate.platform === 'win32' && candidate.architectures.includes(architecture as never),
  ) as { size: number; sha256: string } | undefined
  if (!artifact) throw new Error('fixture lock has no current Windows artifact')
  artifact.size = bytes.byteLength
  artifact.sha256 = createHash('sha256').update(bytes).digest('hex')
  return lock
}

async function* body(...chunks: Uint8Array[]) {
  for (const chunk of chunks) yield chunk
}

describe('locked Windows Computer Use download', () => {
  it('streams the exact lock URL and returns only size/digest verified bytes', async () => {
    const expected = Buffer.from('locked driver archive')
    const transport = vi.fn(async () => ({
      statusCode: 200,
      contentLength: expected.length,
      body: body(expected.subarray(0, 5), expected.subarray(5)),
    }))
    await expect(
      downloadLockedWindowsComputerUseDriver(fixture(expected), { transport }).then(Array.from),
    ).resolves.toEqual(Array.from(expected))
    expect(transport).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/github\.com\/trycua\/cua\/releases\/download\//),
      expect.any(AbortSignal),
    )
  })

  it('follows one GitHub release-assets redirect and refuses every other redirect target', async () => {
    const expected = Buffer.from('1234')
    const lock = fixture(expected)
    const calls: string[] = []
    await expect(
      downloadLockedWindowsComputerUseDriver(lock, {
        transport: async (url) => {
          calls.push(url)
          return calls.length === 1
            ? {
                statusCode: 302,
                location:
                  'https://release-assets.githubusercontent.com/github-production-release-asset/1/locked?sig=x',
                body: body(),
              }
            : { statusCode: 200, body: body(expected) }
        },
      }).then(Array.from),
    ).resolves.toEqual(Array.from(expected))
    expect(calls).toHaveLength(2)
    await expect(
      downloadLockedWindowsComputerUseDriver(lock, {
        transport: async () => ({
          statusCode: 302,
          location: 'https://example.com/driver.zip?sig=x',
          body: body(),
        }),
      }),
    ).rejects.toThrow('outside GitHub release assets')
    await expect(
      downloadLockedWindowsComputerUseDriver(lock, {
        transport: async () => ({
          statusCode: 302,
          location:
            'https://release-assets.githubusercontent.com/github-production-release-asset/1/locked?sig=x',
          body: body(),
        }),
      }),
    ).rejects.toThrow('too many redirects')
  })

  it('refuses mismatched Content-Length and streaming overflow', async () => {
    const expected = Buffer.from('1234')
    const lock = fixture(expected)
    await expect(
      downloadLockedWindowsComputerUseDriver(lock, {
        transport: async () => ({ statusCode: 200, contentLength: 5, body: body(expected) }),
      }),
    ).rejects.toThrow('Content-Length')
    await expect(
      downloadLockedWindowsComputerUseDriver(lock, {
        transport: async () => ({ statusCode: 200, body: body(Buffer.from('12345')) }),
      }),
    ).rejects.toThrow('exceeds the locked size')
  })

  it('refuses same-size bytes whose digest differs', async () => {
    const expected = Buffer.from('1234')
    await expect(
      downloadLockedWindowsComputerUseDriver(fixture(expected), {
        transport: async () => ({ statusCode: 200, body: body(Buffer.from('5678')) }),
      }),
    ).rejects.toThrow('digest differs')
  })
})
