import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { forkPaths } from '../src/log/fork-seed.js'
import { base64DecodedBytes, isLeanEvent, LEAN_DATA_MIN_CHARS, leanEvent } from '../src/log/lean.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { prepareEvents } from '../src/log/validate.js'
import { openTracked } from '../src/reduce/tracker.js'
import type { Event } from '../src/types.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { openSession } from './helpers/open-session.js'

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

  it('refuses the lean shape only where a ContentBlock stands, not in free-form JSON', () => {
    const omitted = { type: 'file', mimeType: 'application/zip', name: 'a.zip', dataOmitted: { bytes: 1 } }
    const prepare = (input: Record<string, unknown>) =>
      prepareEvents([{ actor, origin: 'principal', trust: 'trusted', ...input }] as never, {
        ids: defaultIds(),
        clock: () => 0,
        refineCaller: false,
      })
    // A model may well put this shape in a tool call's arguments; the row is still the model's to write.
    expect(
      prepare({
        origin: 'model',
        type: 'tool/call',
        data: { toolUseId: 't1', name: 'write', args: { block: omitted, list: [[omitted]] }, ordinal: 0 },
      }),
    ).toHaveLength(1)
    expect(prepare({ type: 'x/acme/pkg/note', ignorable: true, data: { content: [omitted] } })).toHaveLength(
      1,
    )
    for (const input of [
      { type: 'user/message', data: { content: [omitted] } },
      { type: 'tool/result', origin: 'tool:read', data: { content: [omitted] } },
      { type: 'inbox', register: 'inbox', data: { items: [{ itemId: 'i', content: [omitted] }] } },
    ])
      expect(() => prepare(input), input.type).toThrow(/E_ENVELOPE.*omitted attachment data/)
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

  it('folds the UI cell and the model surface from lean rows, live and on reopen', async () => {
    const storage = new MemoryStorage()
    const block = { type: 'image', mimeType: 'image/jpeg', data: big }
    const opened = await openTracked({ ...common, storage, key: 'k', writerRunId: 'w' })
    await opened.log.append([
      { actor, origin: 'principal', trust: 'trusted', type: 'user/message', data: { content: [block] } },
    ])
    const lean = { type: 'image', mimeType: 'image/jpeg', dataOmitted: { bytes: base64DecodedBytes(big) } }
    expect((await userNode(opened.ui))?.content).toEqual([lean])
    // A request reads the bytes from the row when it picks the image; the surface does not hold them.
    const surfaced = (o: typeof opened) =>
      o.surface.nodes().map((node) => (node.event.data as { content: unknown[] }).content)
    expect(surfaced(opened)).toEqual([[lean]])
    await opened.log.close()

    const reopened = await openTracked({ ...common, storage, key: 'k', writerRunId: 'w2' })
    expect((await userNode(reopened.ui))?.content).toEqual([lean])
    expect(surfaced(reopened)).toEqual([[lean]])
    // The row itself is untouched.
    expect((await reopened.log.scan({ fromSeq: 1, toSeq: 1, limit: 1 }))[0]?.data).toEqual({
      content: [block],
    })
    expect(isLeanEvent((await reopened.log.scanLean({ fromSeq: 1, toSeq: 1, limit: 1 }))[0] as Event)).toBe(
      true,
    )
    await reopened.log.close()
  })

  it('projects a historical cut from lean rows, as the live cell does', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    const message = (content: unknown[]) => ({
      actor,
      origin: 'principal' as const,
      trust: 'trusted' as const,
      type: 'user/message',
      data: { content },
    })
    await session.append([message([{ type: 'image', mimeType: 'image/jpeg', data: big }])] as never)
    const cut = session.lastSeq
    await session.append([message([{ type: 'text', text: 'later' }])] as never)
    // A cut short of the head is never the live cell's: it is read back from storage.
    const timeline = await session.projectUI(cut)
    expect(timeline.upto).toBe(cut)
    expect(timeline.nodes.filter((node) => node.kind === 'user').map((node) => node.content)).toEqual([
      [{ type: 'image', mimeType: 'image/jpeg', dataOmitted: { bytes: base64DecodedBytes(big) } }],
    ])
    await session.close()
  })

  it('folds a delegated child seeded from its live parent from lean rows', async () => {
    const storage = new MemoryStorage()
    const parent = await openTracked({ ...common, storage, key: 'p', writerRunId: 'p' })
    await parent.log.append([
      {
        actor,
        origin: 'principal',
        trust: 'trusted',
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'go' }] },
      },
    ])
    const forked = await parent.log.forkInto(parent.log.lastSeq, 'c', {
      actor,
      agnesVersion: 'test',
      preset: null,
      resolvedProfileHash: null,
      writerRunId: 'c',
      lane: 'main',
      delegation: { kind: 'fork', creationId: 'x', rootTaskId: 'p', generationDepth: 1 },
    })
    expect(forkPaths.get(forked)).toEqual({ path: 'live-parent' })
    // Committed before a tracker is attached, so it reaches the cell through the seed, not a replay.
    await forked.append([
      {
        actor,
        origin: 'principal',
        trust: 'trusted',
        type: 'user/message',
        data: { content: [{ type: 'image', mimeType: 'image/jpeg', data: big }] },
      },
    ])
    const child = await openTracked({ ...common, storage, key: 'c', writerRunId: 'c', existing: forked })
    expect(child.ui.complete).toBe(false)
    expect((await userNode(child.ui))?.content).toEqual([
      { type: 'image', mimeType: 'image/jpeg', dataOmitted: { bytes: base64DecodedBytes(big) } },
    ])
    await child.log.close()
    await parent.log.close()
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
