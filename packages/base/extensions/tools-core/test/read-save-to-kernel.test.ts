import { createHash } from 'node:crypto'
import { type AttachmentReadPort, type FsOps, ToolRegistry } from '@agnes/core'
import {
  actor,
  fakeProvider,
  fakeSeams,
  fencedFs,
  openSession,
  testFsPolicy,
  textTurn,
  toolTurn,
} from '@agnes/core/testkit'
import { describe, expect, it } from 'vitest'
import { readTool } from '../src/tools/read.js'

const ZIP = Buffer.from('PK\u0003\u0004 an archive')
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** The workspace as a map behind the same policy fence core runs every test session against. */
function memoryFs() {
  const files = new Map<string, Uint8Array>()
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  const fs: FsOps = fencedFs(
    {
      read: async (path) => {
        const b = files.get(path)
        if (!b) throw enoent(path)
        return b
      },
      write: async (path, data) => {
        files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data)
      },
      list: async () => [],
      stat: async (path) => {
        const b = files.get(path)
        if (b) return { kind: 'file' as const, size: b.byteLength, mtimeMs: 0 }
        if ([...files.keys()].some((k) => k.startsWith(`${path}/`)))
          return { kind: 'dir' as const, size: 0, mtimeMs: 0 }
        throw enoent(path)
      },
    },
    testFsPolicy('/w'),
  )
  return { fs, files }
}

/** A session holding one referenced zip, whose model asks to copy it into the workspace. */
async function atSaveTo(o: {
  approvalMode?: 'manual' | 'off'
  verdict: 'allowed-once' | 'rejected'
  /** The sandbox reports no enforcement, so writing calls are refused (the preset default). */
  unconfined?: boolean
  saveTo?: string | undefined
}) {
  const asks: unknown[] = []
  const objects = new Map([[hex(ZIP), new Uint8Array(ZIP)]])
  const attachments: AttachmentReadPort = {
    isUserAttachment: async (sha256) => objects.has(sha256),
    read: async (sha256) => {
      const b = objects.get(sha256)
      if (!b) throw Object.assign(new Error('missing'), { code: 'ATTACHMENT_MISSING' })
      return b
    },
  }
  const { fs, files } = memoryFs()
  const registry = new ToolRegistry()
  // As the host registers a bundled extension's tools: a classified tool needs its package attested.
  registry.add(readTool, {
    source: 'agnes/tools-core',
    trust: 'builtin',
    packageIdentity: '@agnes/base',
    packageVersion: '0.0.0',
  })
  // session/start is seq 1, so the attachment row appended first is seq 2.
  const provider = fakeProvider([
    toolTurn('read', {
      path: 'session-file://2/1',
      ...('saveTo' in o
        ? o.saveTo === undefined
          ? {}
          : { saveTo: o.saveTo }
        : { saveTo: 'data/insects.zip' }),
    }),
    textTurn('done'),
  ])
  const opened = await openSession({
    provider,
    registry,
    attachments,
    fsOps: fs,
    seams: fakeSeams({
      approval: {
        ask: async (request) => {
          asks.push(request)
          return o.verdict
        },
      },
      ...(o.unconfined ? { sandbox: { enforcement: () => ({ level: 'none' as const, scope: [] }) } } : {}),
    }),
    ...(o.approvalMode ? { approvalMode: o.approvalMode } : {}),
    resolvedProfileHash: `sha256-${'a'.repeat(64)}`,
  })
  const { session } = opened
  const { firstSeq } = await session.d.log.append([
    session.ev('user/message', {
      content: [
        {
          type: 'file',
          mimeType: 'application/zip',
          name: 'insects.zip',
          attachment: { sha256: hex(ZIP), bytes: ZIP.byteLength },
        },
      ],
    }),
  ])
  expect(firstSeq).toBe(2)
  await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'unpack it' }] })
  await session.acceptInput()
  await session.runInference()
  await session.runToolsPhase()
  const [result] = await opened.log.scan({ type: 'tool/result', limit: 1 })
  return { asks, files, result }
}

describe('read saveTo through the kernel', () => {
  it('asks in manual mode before copying, as for write, and copies once allowed', async () => {
    const { asks, files, result } = await atSaveTo({ verdict: 'allowed-once' })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ tool: { name: 'read', args: { saveTo: 'data/insects.zip' } } })
    expect(files.get('/w/data/insects.zip')).toEqual(new Uint8Array(ZIP))
    expect(JSON.stringify(result?.data)).toContain('Saved')
  })

  it('writes nothing when the person refuses', async () => {
    const { asks, files, result } = await atSaveTo({ verdict: 'rejected' })
    expect(asks).toHaveLength(1)
    expect(files.size).toBe(0)
    expect(JSON.stringify(result?.data)).not.toContain('Saved')
  })

  it('does not ask when approvals are off, like write', async () => {
    const { asks, files } = await atSaveTo({ approvalMode: 'off', verdict: 'rejected' })
    expect(asks).toHaveLength(0)
    expect(files.get('/w/data/insects.zip')).toEqual(new Uint8Array(ZIP))
  })

  it('refuses the copy when the sandbox is unavailable, as for any writing call, while plain reads go on', async () => {
    const refused = await atSaveTo({ approvalMode: 'off', verdict: 'allowed-once', unconfined: true })
    expect(refused.files.size).toBe(0)
    expect(JSON.stringify(refused.result?.data)).not.toContain('Saved')
    const plain = await atSaveTo({
      approvalMode: 'off',
      verdict: 'allowed-once',
      unconfined: true,
      saveTo: undefined,
    })
    expect(JSON.stringify(plain.result?.data)).toContain('document-reading tool')
  })
})
