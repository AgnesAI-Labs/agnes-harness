import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ContentBlock } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAttachmentStore } from '../src/attachment-store.js'
import type { Host } from '../src/host.js'
import { createTestHost, type TestHostOptions } from '../testkit/index.js'

const roots: string[] = []
const hosts: Host[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const zip = Buffer.from('PK\u0003\u0004 a small archive')
const sha = createHash('sha256').update(zip).digest('hex')
const inlineFile = {
  type: 'file' as const,
  mimeType: 'application/zip',
  name: 'a.zip',
  data: zip.toString('base64'),
}

async function open(over: Partial<TestHostOptions> = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-attach-assemble-')))
  roots.push(root)
  const { host } = await createTestHost({ dataDir: root, ...over })
  hosts.push(host)
  const session = await host.createSession({ cwd: root, key: 'attach-test' })
  const queued = () =>
    (session.latest('inbox') as { items: Array<{ content: ContentBlock[] }> } | undefined)?.items ?? []
  return { root, host, session, queued }
}

describe('host attachment admission', () => {
  it('stores inline attachments by reference when the profile asks for it', async () => {
    const { root, session, queued } = await open({ storeAttachmentsByReference: true })
    await session.enqueue('next-turn', { actor: session.d.actor, content: [inlineFile] })
    expect(queued()[0]?.content).toEqual([
      {
        type: 'file',
        mimeType: 'application/zip',
        name: 'a.zip',
        attachment: { sha256: sha, bytes: zip.byteLength },
      },
    ])
    expect(existsSync(join(root, 'artifacts', 'sha256', sha.slice(0, 2), sha))).toBe(true)
    const store = createAttachmentStore({ dataDir: root })
    expect(await store.userAttachment(sha)).toMatchObject({ bytes: zip.byteLength, receipts: [] })
  })

  it('accepts a reference this session uploaded and refuses one it did not', async () => {
    const { root, session, queued } = await open({ storeAttachmentsByReference: true })
    const store = createAttachmentStore({ dataDir: root })
    const mine = Buffer.from('uploaded here')
    const theirs = Buffer.from('uploaded elsewhere')
    for (const [bytes, owner] of [
      [mine, session.key],
      [theirs, 'another-session'],
    ] as const) {
      const object = await store.put(bytes, { kind: 'user-attachment', mimeType: 'application/zip' })
      await store.markUserAttachment(object, { mimeType: 'application/zip', receiptFor: owner })
    }
    const ref = (bytes: Buffer) => ({
      type: 'file' as const,
      mimeType: 'application/zip',
      name: 'r.zip',
      attachment: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength },
    })
    await expect(
      session.enqueue('next-step', { actor: session.d.actor, content: [ref(theirs)], kind: 'steer' }),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE', detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' } })
    expect(queued()).toEqual([])
    await session.enqueue('next-step', { actor: session.d.actor, content: [ref(mine)], kind: 'steer' })
    expect(queued()[0]?.content).toEqual([ref(mine)])
  })

  it('keeps attachments inline when the profile turns storage off', async () => {
    const { root, session, queued } = await open({ storeAttachmentsByReference: false })
    await session.enqueue('next-turn', { actor: session.d.actor, content: [inlineFile] })
    expect(queued()[0]?.content).toEqual([inlineFile])
    expect(existsSync(join(root, 'artifacts', 'sha256', sha.slice(0, 2), sha))).toBe(false)
  })

  it('keeps attachments inline when another package owns the artifacts seam', async () => {
    const { root, session, queued } = await open({
      storeAttachmentsByReference: true,
      profileInputs: { user: { name: 'local-dev', seams: { artifacts: '@agnes/code' } } },
      packages: {
        '@agnes/code': {
          seams: {
            artifacts: async () => ({
              put: async () => {
                throw new Error('not used')
              },
              get: async () => {
                throw new Error('not used')
              },
            }),
          },
        },
      },
    })
    await session.enqueue('next-turn', { actor: session.d.actor, content: [inlineFile] })
    expect(queued()[0]?.content).toEqual([inlineFile])
    expect(existsSync(join(root, 'artifacts', 'sha256', sha.slice(0, 2), sha))).toBe(false)
  })

  it('puts back bytes a sweep had set aside when its process died, as the host starts', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-attach-assemble-')))
    roots.push(root)
    const store = createAttachmentStore({ dataDir: root })
    const object = await store.put(zip, { kind: 'user-attachment', mimeType: 'application/zip' })
    await store.markUserAttachment(object, { mimeType: 'application/zip' })
    const objectPath = join(root, 'artifacts', 'sha256', sha.slice(0, 2), sha)
    const sweeping = join(root, 'artifacts', 'sweeping')
    mkdirSync(sweeping, { recursive: true })
    renameSync(objectPath, join(sweeping, `${sha}.0b7c6f1e-0000-4000-8000-000000000000`))
    // A ledger is there from an earlier start: only a sweep that found one sets bytes aside.
    new DatabaseSync(join(root, 'sessions.db')).close()
    const { host } = await createTestHost({ dataDir: root, storeAttachmentsByReference: false })
    hosts.push(host)
    await vi.waitFor(() => expect(existsSync(objectPath)).toBe(true))
    expect(readdirSync(sweeping)).toEqual([])
  })
})
