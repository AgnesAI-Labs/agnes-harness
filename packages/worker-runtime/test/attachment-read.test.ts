import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { Host, HostSession } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { handleCommand } from '../src/commands.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function openSession(): Promise<{ host: Host; session: HostSession; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-attachment-read-'))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const { host } = await createTestHost({
    dataDir,
    provider: new ScriptedProvider({ scripts: [] }),
    disableSessionTitle: true,
  })
  cleanup.push(() => host.close())
  const session = await host.createSession({ key: 'attachment-read', cwd: realpathSync.native(dataDir) })
  return { host, session, dataDir }
}

describe('worker attachmentRead command', () => {
  it('serves an old inline file in windows, reading its row once and the store copy after', async () => {
    const { host, session, dataDir } = await openSession()
    const original = Buffer.alloc(300_000)
    for (let i = 0; i < original.length; i++) original[i] = (i * 7) & 0xff
    const { seqs } = await session.append([
      session.ev('user/message', {
        content: [
          { type: 'file', mimeType: 'application/zip', name: 'a.zip', data: original.toString('base64') },
        ],
      }),
    ])
    const seq = seqs[0] as number
    let rowReads = 0
    const scan = session.d.log.scan.bind(session.d.log)
    session.d.log.scan = (q) => {
      if (q.type === 'user/message') rowReads++
      return scan(q)
    }
    const read = (params: Record<string, unknown>) =>
      handleCommand(session, { method: 'attachmentRead', params } as never, {
        host,
        aborts: new Map(),
      }) as Promise<{
        mimeType: string
        totalBytes: number
        base64: string
      }>
    const parts: Buffer[] = []
    for (let offset = 0; offset < original.length; offset += 100_000) {
      const page = await read({ seq, kind: 'file', index: 1, offset, length: 100_000 })
      expect(page).toMatchObject({ mimeType: 'application/zip', totalBytes: original.length })
      parts.push(Buffer.from(page.base64, 'base64'))
    }
    expect(Buffer.concat(parts).equals(original)).toBe(true)
    expect(rowReads).toBe(1)
    expect(
      readdirSync(join(dataDir, 'artifacts', 'user-attachment-cache')).filter((n) => n.endsWith('.json')),
    ).toHaveLength(1)
    await expect(
      read({ seq, kind: 'file', index: 1, offset: 0, length: 1024 * 1024 + 1 }),
    ).rejects.toMatchObject({
      data: { reason: 'invalid-attachment-window' },
    })
    await expect(
      read({ seq, kind: 'file', index: 1, offset: original.length + 1, length: 1 }),
    ).rejects.toMatchObject({
      data: { reason: 'offset-out-of-range' },
    })
    await expect(read({ seq, kind: 'image', index: 1, offset: 0, length: 1 })).rejects.toMatchObject({
      data: { reason: 'attachment-not-found' },
    })
  })
})
