import { describe, expect, it } from 'vitest'
import { AttachmentIndex } from '../src/request/attachment-index.js'
import type { Event } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const row = (seq: number, type: string, data: unknown, lane = 'main'): Event =>
  ({
    seq,
    ts: '2026-10-13T00:00:00.000Z',
    id: `e${seq}`,
    lane,
    v: 1,
    actor,
    origin: 'principal',
    trust: 'trusted',
    type,
    data,
  }) as Event

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_T = 'c'.repeat(64)
// 400 KiB of decoded bytes as base64.
const INLINE = Buffer.alloc(400 * 1024, 7).toString('base64')

const three = (): Event[] => [
  row(3, 'user/message', {
    kind: 'prompt',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', mimeType: 'image/png', data: INLINE },
    ],
  }),
  row(5, 'user/message', {
    kind: 'prompt',
    content: [
      {
        type: 'file',
        mimeType: 'application/zip',
        name: 'insects.zip',
        attachment: { sha256: SHA_A, bytes: 9000 },
      },
    ],
  }),
  row(7, 'user/message', {
    kind: 'prompt',
    content: [
      { type: 'image', mimeType: 'image/jpeg', dataOmitted: { bytes: 300_000 } },
      {
        type: 'image',
        mimeType: 'image/png',
        attachment: { sha256: SHA_B, bytes: 70 },
        width: 4,
        height: 3,
        thumbnail: { sha256: SHA_T, bytes: 40, width: 4, height: 3 },
      },
      {
        type: 'file',
        mimeType: 'application/zip',
        name: 'again.zip',
        attachment: { sha256: SHA_A, bytes: 9000 },
      },
    ],
  }),
]

describe('AttachmentIndex', () => {
  it('numbers attachments per message and kind, records each form, and counts distinct references once', () => {
    const index = new AttachmentIndex()
    index.apply(three())
    const images = index.list('image', 'main')
    expect(images.map((e) => [e.seq, e.index, e.form])).toEqual([
      [3, 1, 'inline'],
      [7, 1, 'omitted'],
      [7, 2, 'reference'],
    ])
    expect(index.list('image', 'main').filter((e) => e.seq === 7)).toHaveLength(2)
    expect(images[0]).toMatchObject({ kind: 'image', bytes: 400 * 1024, mimeType: 'image/png', lane: 'main' })
    expect(images[1]).toMatchObject({ bytes: 300_000, mimeType: 'image/jpeg' })
    expect(index.get(7, 'image', 2)).toEqual({
      seq: 7,
      lane: 'main',
      kind: 'image',
      index: 2,
      form: 'reference',
      sha256: SHA_B,
      bytes: 70,
      mimeType: 'image/png',
      width: 4,
      height: 3,
      thumbnail: { sha256: SHA_T, bytes: 40 },
    })
    expect(index.get(5, 'file', 1)).toMatchObject({ name: 'insects.zip', sha256: SHA_A, form: 'reference' })
    expect(index.get(7, 'file', 1)).toMatchObject({ name: 'again.zip', sha256: SHA_A })
    expect(index.get(7, 'file', 2)).toBeUndefined()
    expect(index.get(5, 'image', 1)).toBeUndefined()
    expect(index.referenced(SHA_A)).toBe(true)
    expect(index.referenced(SHA_B)).toBe(true)
    expect(index.referenced(SHA_T)).toBe(false)
    // SHA_A appears twice and is counted once.
    expect(index.referencedBytes()).toBe(9000 + 70)
    expect(index.size).toBe(5)
  })

  it('keeps nothing for rows without attachments, and nothing of the inline bytes', () => {
    const index = new AttachmentIndex()
    const rows: Event[] = []
    for (let seq = 1; seq <= 10_000; seq++)
      rows.push(
        row(seq, seq % 2 ? 'user/message' : 'assistant/message', {
          kind: 'prompt',
          content: [{ type: 'text', text: `t${seq}` }],
        }),
      )
    index.apply(rows)
    expect(index.size).toBe(0)
    expect(index.list('file', 'main')).toEqual([])
    const withData = new AttachmentIndex()
    withData.apply(three())
    expect(JSON.stringify(withData.list('image', 'main'))).not.toContain(INLINE.slice(0, 64))
  })

  it('separates lanes, ignores rows it has already folded, and keeps the numbering of malformed blocks', () => {
    const index = new AttachmentIndex()
    index.apply([
      row(
        1,
        'user/message',
        { content: [{ type: 'file', mimeType: 'text/plain', name: 'a.txt', data: 'QQ==' }] },
        'side',
      ),
      row(2, 'user/message', {
        content: [
          // A block that no form describes still takes its number, as the old ledger scan counted it.
          { type: 'file', mimeType: 'text/plain', name: 'broken' },
          { type: 'file', mimeType: 'text/plain', name: 'b.txt', data: 'Qg==' },
        ],
      }),
    ])
    index.apply([
      row(2, 'user/message', {
        content: [{ type: 'file', mimeType: 'text/plain', name: 'dup', data: 'QQ==' }],
      }),
    ])
    expect(index.list('file', 'side').map((e) => e.name)).toEqual(['a.txt'])
    expect(index.list('file', 'main').map((e) => [e.name, e.index])).toEqual([['b.txt', 2]])
    expect(index.get(2, 'file', 1)).toBeUndefined()
    expect(index.get(2, 'file', 2)?.bytes).toBe(1)
  })

  it('starts a fork from the parent index up to the fork point only', () => {
    const parent = new AttachmentIndex()
    parent.apply(three())
    const child = new AttachmentIndex()
    child.inherit(parent, 5)
    child.apply([
      row(6, 'user/message', {
        content: [{ type: 'file', mimeType: 'text/plain', name: 'own.txt', data: 'QQ==' }],
      }),
    ])
    expect(child.list('file', 'main').map((e) => e.name)).toEqual(['insects.zip', 'own.txt'])
    expect(child.list('image', 'main').map((e) => e.seq)).toEqual([3])
    expect(child.referenced(SHA_A)).toBe(true)
    expect(child.referenced(SHA_B)).toBe(false)
    expect(child.referencedBytes()).toBe(9000)
  })
})
