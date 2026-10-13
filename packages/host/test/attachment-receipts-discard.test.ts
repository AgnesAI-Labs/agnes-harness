import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attachmentReceiptFor, createAttachmentStore } from '../src/attachment-store.js'
import type { Host } from '../src/host.js'
import { createTestHost } from '../testkit/index.js'

const roots: string[] = []
const hosts: Host[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const fresh = () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-receipts-')))
  roots.push(root)
  return root
}

describe('upload receipts of a discarded session', () => {
  it('are removed from every marker, and only that session loses its receipt', async () => {
    let now = 1_000
    const store = createAttachmentStore({ dataDir: fresh(), clock: () => now })
    const one = await store.put(new TextEncoder().encode('one'), {
      kind: 'user-attachment',
      mimeType: 'text/plain',
    })
    const two = await store.put(new TextEncoder().encode('two'), {
      kind: 'user-attachment',
      mimeType: 'text/plain',
    })
    await store.markUserAttachment(one, { mimeType: 'text/plain', receiptFor: 'gone' })
    await store.markUserAttachment(one, { mimeType: 'text/plain', receiptFor: 'kept' })
    await store.markUserAttachment(two, { mimeType: 'text/plain', receiptFor: 'gone' })
    now = 500_000
    expect(await store.forgetReceipts?.('gone')).toBe(2)
    expect((await store.userAttachment(one.sha256))?.receipts).toEqual([attachmentReceiptFor('kept')])
    expect((await store.userAttachment(two.sha256))?.receipts).toEqual([])
    // Forgetting a receipt is no sighting: the attachment sweep's clock is not reset.
    expect((await store.userAttachment(two.sha256))?.lastSeenMs).toBe(1_000)
    expect(await store.forgetReceipts?.('gone')).toBe(0)
  })

  it('are not inherited by a new session bound to the same key', async () => {
    const root = fresh()
    const { host } = await createTestHost({ dataDir: root, storeAttachmentsByReference: true })
    hosts.push(host)
    const key = 'agnes:local:default:import:dm:reused'
    const first = await host.createSession({ cwd: root, key })
    const store = createAttachmentStore({ dataDir: root })
    const bytes = new TextEncoder().encode('uploaded to the first session')
    const object = await store.put(bytes, { kind: 'user-attachment', mimeType: 'application/zip' })
    await store.markUserAttachment(object, { mimeType: 'application/zip', receiptFor: key })
    await first.discardNewSession()
    // As the import does after rolling a target back.
    await first.close().catch(() => undefined)
    expect((await store.userAttachment(object.sha256))?.receipts).toEqual([])

    const second = await host.createSession({ cwd: root, key })
    await expect(
      second.enqueue('next-turn', {
        actor: second.d.actor,
        content: [
          {
            type: 'file',
            mimeType: 'application/zip',
            name: 'a.zip',
            attachment: { sha256: object.sha256, bytes: object.bytes },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE', detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' } })
    await second.close()
  })
})
