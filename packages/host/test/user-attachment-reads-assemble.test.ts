import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { ContentBlock, InferenceEvent } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createAttachmentStore } from '../src/attachment-store.js'
import type { Host } from '../src/host.js'
import { createTestHost } from '../testkit/index.js'

const roots: string[] = []
const hosts: Host[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const TEXT = Buffer.from('kept by reference\n')
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const read = (args: Record<string, string>): InferenceEvent[] => [
  { type: 'toolcall_end', via: 'native', call: { toolUseId: '', name: 'read', args, ordinal: 0 } },
  { type: 'done', reason: 'toolUse' },
]
const done: InferenceEvent[] = [{ type: 'text_delta', delta: 'done' }]

/** A host with the bundled tools; each model call takes the next queued answer, then says done. */
async function open(storeAttachmentsByReference: boolean, limits?: Record<string, number>) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agh-attach-reads-')))
  roots.push(root)
  const answers: InferenceEvent[][] = []
  const { host } = await createTestHost({
    dataDir: root,
    storeAttachmentsByReference,
    ...(limits ? { limits } : {}),
    packageDirs: { '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)) },
    // The test route's models, able to take images.
    provider: (profile) =>
      new ScriptedProvider({
        scripts: [() => answers.shift() ?? done],
        models: (profile.provider.routes ?? [])
          .flatMap((route) => route.models ?? [])
          .map((model) => ({ ...model, input: ['text', 'image'] })),
      }),
    approval: async () => 'allowed-once',
  })
  hosts.push(host)
  const store = createAttachmentStore({ dataDir: root })
  const session = async (key: string) => {
    const s = await host.createSession({ cwd: root, key })
    /** Answers the last user message with a turn whose model makes these reads; resolves to each tool result as JSON. */
    const turn = async (...calls: InferenceEvent[][]) => {
      answers.push(...calls)
      const from = s.lastSeq
      await s.run({ until: 'turn-end', signal: new AbortController().signal })
      return (await s.scan({ type: 'tool/result', fromSeq: from + 1, toSeq: s.lastSeq })).map((r) =>
        JSON.stringify(r.data),
      )
    }
    /** Queues one input and claims it, so it is a user message; resolves to its seq. */
    const message = async (content: ContentBlock[]) => {
      const from = s.lastSeq
      await s.enqueue('next-turn', { actor: s.d.actor, content })
      expect(await s.acceptInput()).toBe(true)
      const [row] = await s.scan({ type: 'user/message', fromSeq: from + 1, toSeq: s.lastSeq })
      if (!row) throw new Error('no user message')
      return { seq: row.seq, content: (row.data as { content: ContentBlock[] }).content }
    }
    const window = (seq: number, kind: 'image' | 'file', thumbnail = false) =>
      s.readAttachmentRange({ seq, kind, index: 1, offset: 0, length: 1024 * 1024, thumbnail })
    return { s, turn, message, window }
  }
  return { root, store, session }
}

const upload = async (
  store: ReturnType<typeof createAttachmentStore>,
  bytes: Buffer,
  mimeType: string,
  receiptFor?: string,
) => {
  const object = await store.put(bytes, { kind: 'user-attachment', mimeType })
  await store.markUserAttachment(object, { mimeType, ...(receiptFor ? { receiptFor } : {}) })
  return object
}

describe('user attachment reads in an assembled host', () => {
  it('keeps a copy of an old inline attachment only when there is room for it, and reads it either way', async () => {
    for (const [limits, copied] of [
      [{ 'attachments.global_quota_bytes': 1 }, false],
      [{}, true],
    ] as const) {
      const { store, session } = await open(false, limits)
      const a = await session('reads-cache')
      const inline = await a.message([
        { type: 'file', mimeType: 'text/plain', name: 'notes.txt', data: TEXT.toString('base64') },
      ])
      expect(inline.content).toMatchObject([{ data: TEXT.toString('base64') }])
      const [result] = await a.turn(read({ path: `session-file://${inline.seq}/1` }))
      expect(result).toContain('kept by reference')
      expect(result).toContain('"isError":false')
      expect((await store.stat(hex(TEXT))) !== undefined).toBe(copied)
      if (copied) expect(await store.userAttachment(hex(TEXT))).toMatchObject({ receipts: [] })
    }
  })

  it('keeps references readable when storing by reference is off, and inline input inline', async () => {
    const { store, session } = await open(false)
    const a = await session('reads-off')
    const object = await upload(store, TEXT, 'text/plain')
    // A reference the session holds from before the switch was turned off.
    const {
      seqs: [seq],
    } = await a.s.append([
      a.s.ev('user/message', {
        content: [{ type: 'file', mimeType: 'text/plain', name: 'notes.txt', attachment: object }],
      }),
    ])
    await a.message([{ type: 'text', text: 'read it' }])
    const [result] = await a.turn(read({ path: `session-file://${seq}/1` }))
    expect(result).toContain('kept by reference')
    expect(result).toContain('"isError":false')
    const page = await a.window(seq as number, 'file')
    expect(Buffer.from(page.bytes).equals(TEXT)).toBe(true)
    expect(page).toMatchObject({ mimeType: 'text/plain', totalBytes: TEXT.byteLength })

    const inline = { type: 'file' as const, mimeType: 'text/plain', name: 'n.txt', data: 'QUJD' }
    expect((await a.message([inline])).content).toEqual([inline])
    expect(await store.stat(hex(Buffer.from('ABC')))).toBeUndefined()
  })
})
