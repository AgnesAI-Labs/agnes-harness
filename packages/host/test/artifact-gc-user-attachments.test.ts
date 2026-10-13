import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanComputerUseArtifactCandidates } from '../src/artifact-gc-candidate-scanner.js'
import { createAttachmentStore } from '../src/attachment-store.js'
import { createPrivateArtifactStore } from '../src/private-artifact-store.js'
import { createUserAttachmentPort } from '../src/user-attachments.js'

const roots: string[] = []
const platform = process.platform === 'win32' ? 'win32' : 'darwin'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function dataDir(): Promise<string> {
  const dir = resolve(await mkdtemp(join(tmpdir(), 'agnes-cu-gc-user-')))
  roots.push(dir)
  return dir
}

/** A screenshot as the Computer Use writer classifies it, created long ago so its age has passed. */
async function screenshot(dir: string, text: string) {
  const bytes = new TextEncoder().encode(text)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const store = createPrivateArtifactStore(dir, platform)
  await store.put(sha256, bytes)
  await store.putComputerUseMetadata(
    sha256,
    new TextEncoder().encode(
      `${JSON.stringify({ schemaVersion: 1, sha256, size: bytes.byteLength, createdAtMs: 1 }, null, 2)}\n`,
    ),
  )
  return { bytes, sha256 }
}

describe('Computer Use artifact collection and user attachments', () => {
  it('never offers bytes that are also a user attachment, and still offers its own screenshots', async () => {
    const dir = await dataDir()
    const shared = await screenshot(dir, 'screenshot the user also attached')
    const own = await screenshot(dir, 'an ordinary expired screenshot')
    const attachments = createAttachmentStore({ dataDir: dir })
    // The user attaches exactly the bytes of a screenshot: one object, two markers.
    const stored = await attachments.put(shared.bytes, { kind: 'user-attachment', mimeType: 'image/png' })
    expect(stored.sha256).toBe(shared.sha256)
    await attachments.markUserAttachment(stored, { mimeType: 'image/png' })

    const candidates = await scanComputerUseArtifactCandidates(dir)
    expect(candidates.map((candidate) => candidate.sha256)).toEqual([own.sha256])
  })

  it('writes nothing under the Computer Use metadata tree when user attachments are stored', async () => {
    const dir = await dataDir()
    const store = createAttachmentStore({ dataDir: dir })
    const port = createUserAttachmentPort({
      store,
      limits: {},
      storeByReference: true,
      cacheInline: true,
      diskFree: async () => 1024 ** 4,
    })
    const signal = new AbortController().signal
    await port.store(
      { bytes: new TextEncoder().encode('queued'), mimeType: 'text/plain', sessionKey: 's', sessionBytes: 0 },
      signal,
    )
    const staged = await store.stage({ kind: 'user-attachment', mimeType: 'application/zip' })
    await staged.write(new TextEncoder().encode('uploaded'))
    const uploaded = await staged.commit()
    await store.markUserAttachment(uploaded, { mimeType: 'application/zip', receiptFor: 's' })
    await port.cacheInline?.({
      sessionKey: 's',
      seq: 2,
      kind: 'file',
      index: 1,
      rowId: 'row-2',
      bytes: new TextEncoder().encode('cached'),
      mimeType: 'text/plain',
    })
    expect(existsSync(join(dir, 'artifacts', 'user-attachment-meta'))).toBe(true)
    expect(existsSync(join(dir, 'artifacts', 'computer-use-meta'))).toBe(false)
    await expect(scanComputerUseArtifactCandidates(dir)).resolves.toEqual([])
  })
})
