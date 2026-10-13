import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { base64DecodedBytes, isLeanEvent, LEAN_DATA_MIN_CHARS, leanEvent } from '../src/log/lean.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { prepareEvents } from '../src/log/validate.js'
import { openTracked } from '../src/reduce/tracker.js'
import type { Event } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const big = 'QUJD'.repeat(LEAN_DATA_MIN_CHARS / 4 + 1)
const small = 'QUJD'
const row = (seq: number, type: string, data: unknown): Event =>
  ({
    seq,
    ts: '2026-10-13T00:00:00.000Z',
    id: `e${seq}`,
    lane: 'main',
    v: 1,
    actor,
    origin: 'principal',
    trust: 'trusted',
    type,
    data,
  }) as Event

describe('lean events', () => {
  it('replaces only large inline image and file data, keeping every other field and order', () => {
    const e = row(1, 'user/message', {
      kind: 'prompt',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', mimeType: 'image/jpeg', data: big },
        { type: 'image', mimeType: 'image/png', data: small },
        { type: 'file', mimeType: 'application/zip', name: 'a.zip', data: `${big}A=` },
      ],
    })
    const lean = leanEvent(e)
    expect(lean).not.toBe(e)
    expect(JSON.stringify(lean.data)).toBe(
      JSON.stringify({
        kind: 'prompt',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', mimeType: 'image/jpeg', dataOmitted: { bytes: base64DecodedBytes(big) } },
          { type: 'image', mimeType: 'image/png', data: small },
          {
            type: 'file',
            mimeType: 'application/zip',
            name: 'a.zip',
            dataOmitted: { bytes: base64DecodedBytes(`${big}A=`) },
          },
        ],
      }),
    )
    expect(isLeanEvent(lean)).toBe(true)
    expect(isLeanEvent(e)).toBe(false)
  })

  it('leans every inbox item and leaves other rows untouched by identity', () => {
    const inbox = row(2, 'inbox', {
      items: [
        { itemId: 'i', content: [{ type: 'image', mimeType: 'image/jpeg', data: big }] },
        { itemId: 'j', content: [{ type: 'text', text: 'x' }] },
      ],
    })
    const lean = leanEvent(inbox)
    expect(
      (lean.data as { items: Array<{ content: Array<Record<string, unknown>> }> }).items[0]?.content[0],
    ).toEqual({
      type: 'image',
      mimeType: 'image/jpeg',
      dataOmitted: { bytes: base64DecodedBytes(big) },
    })
    const result = row(3, 'tool/result', { content: [{ type: 'image', mimeType: 'image/png', data: big }] })
    expect(leanEvent(result)).toBe(result)
    const plain = row(4, 'user/message', { content: [{ type: 'text', text: 'x' }] })
    expect(leanEvent(plain)).toBe(plain)
  })

  it('counts decoded bytes from base64 padding', () => {
    expect([
      base64DecodedBytes(''),
      base64DecodedBytes('QQ=='),
      base64DecodedBytes('QUI='),
      base64DecodedBytes('QUJD'),
    ]).toEqual([0, 1, 2, 3])
  })

  it('serves scanLean from the in-memory adapter and refuses omitted data on append', async () => {
    const storage = new MemoryStorage()
    await storage.open('k', { writerRunId: 'w', ttlMs: 60_000 })
    const { seq: _seq, ...prepared } = row(0, 'user/message', {
      content: [{ type: 'image', mimeType: 'image/jpeg', data: big }],
    })
    await storage.commit('k', { events: [prepared as never], expectedWriterRunId: 'w' })
    const [lean] = await storage.scanLean('k', { fromSeq: 1, toSeq: 1, limit: 1 })
    expect(isLeanEvent(lean as Event)).toBe(true)
    const [full] = await storage.scan('k', { fromSeq: 1, toSeq: 1, limit: 1 })
    expect(isLeanEvent(full as Event)).toBe(false)
    expect(() =>
      prepareEvents(
        [
          {
            actor,
            origin: 'principal',
            trust: 'trusted',
            type: 'user/message',
            data: { content: [{ type: 'image', mimeType: 'image/jpeg', dataOmitted: { bytes: 1 } }] },
          },
        ] as never,
        {
          ids: {
            ulid: () => 'x',
            effectId: () => 'x',
            toolUseId: () => 'x',
            requestId: () => 'x',
            nonce: () => 'x',
          } as never,
          clock: () => 0,
          refineCaller: false,
        },
      ),
    ).toThrow(/E_ENVELOPE.*omitted attachment data/)
  })
})

describe('lean rows in the live session', () => {
  const common = {
    ttlMs: 60_000,
    clock: () => 1_757_203_200_000,
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    relationCheck: () => undefined,
    ids: defaultIds(),
  }
  const userNode = async (ui: Awaited<ReturnType<typeof openTracked>>['ui']) =>
    (await ui.view()).nodes.find((node) => node.kind === 'user') as { content: unknown[] } | undefined

  it('folds the UI cell from lean rows while the model surface keeps the bytes, live and on reopen', async () => {
    const storage = new MemoryStorage()
    const block = { type: 'image', mimeType: 'image/jpeg', data: big }
    const opened = await openTracked({ ...common, storage, key: 'k', writerRunId: 'w' })
    await opened.log.append([
      { actor, origin: 'principal', trust: 'trusted', type: 'user/message', data: { content: [block] } },
    ])
    const lean = { type: 'image', mimeType: 'image/jpeg', dataOmitted: { bytes: base64DecodedBytes(big) } }
    expect((await userNode(opened.ui))?.content).toEqual([lean])
    expect(opened.surface.nodes().map((node) => (node.event.data as { content: unknown[] }).content)).toEqual(
      [[block]],
    )
    await opened.log.close()

    const reopened = await openTracked({ ...common, storage, key: 'k', writerRunId: 'w2' })
    expect((await userNode(reopened.ui))?.content).toEqual([lean])
    expect(isLeanEvent((await reopened.log.scanLean({ fromSeq: 1, toSeq: 1, limit: 1 }))[0] as Event)).toBe(
      true,
    )
    await reopened.log.close()
  })

  it('leans in JS when the adapter has no scanLean of its own', async () => {
    const storage = new MemoryStorage()
    const opened = await openTracked({ ...common, storage, key: 'k', writerRunId: 'w' })
    await opened.log.append([
      {
        actor,
        origin: 'principal',
        trust: 'trusted',
        type: 'user/message',
        data: { content: [{ type: 'image', mimeType: 'image/jpeg', data: big }] },
      },
    ])
    Object.defineProperty(storage, 'scanLean', { value: undefined })
    const [row] = await opened.log.scanLean({ fromSeq: 1, toSeq: 1, limit: 1 })
    expect(isLeanEvent(row as Event)).toBe(true)
    await opened.log.close()
  })
})
