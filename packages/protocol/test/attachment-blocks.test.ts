import { describe, expect, it } from 'vitest'
import {
  attachmentForm,
  containsAttachmentRef,
  downgradeBlock,
  downgradeEvent,
  downgradeTimeline,
} from '../src/attachment-blocks.js'
import { validateEvent } from '../src/index.js'

const sha = 'a'.repeat(64)
// A well-formed row id, so each verdict below is about the content alone.
const id = '01J6ZM2Q3R4S5T6V7W8X9Y0Z00'
const imageRef = {
  type: 'image',
  mimeType: 'image/png',
  attachment: { sha256: sha, bytes: 1234 },
  width: 640,
  height: 480,
  name: 'shot.png',
} as const
const fileRef = {
  type: 'file',
  mimeType: 'application/zip',
  name: 'insects.zip',
  attachment: { sha256: sha, bytes: 99_000_000 },
} as const

describe('attachment blocks', () => {
  it('classifies the three forms', () => {
    expect(attachmentForm({ type: 'image', mimeType: 'image/png', data: 'QUJD' })).toBe('inline')
    expect(attachmentForm(imageRef)).toBe('reference')
    expect(attachmentForm({ type: 'file', mimeType: 'x/y', name: 'n', dataOmitted: { bytes: 1 } })).toBe(
      'omitted',
    )
    expect(attachmentForm({ type: 'text', text: 'x' })).toBeUndefined()
    expect(containsAttachmentRef([{ type: 'text', text: 'x' }, fileRef])).toBe(true)
    // More than one carrier is no form at all, whichever field comes first.
    expect(attachmentForm({ ...imageRef, data: 'QUJD' })).toBeUndefined()
    expect(attachmentForm({ ...fileRef, dataOmitted: { bytes: 1 } })).toBeUndefined()
    expect(containsAttachmentRef([{ ...fileRef, data: 'QUJD' }])).toBe(false)
  })

  it('downgrades a reference to ACP-legal content an old client accepts', () => {
    expect(downgradeBlock(imageRef, { seq: 4, index: 1 })).toEqual([
      { type: 'resource_link', uri: `artifact://${sha}`, name: 'shot.png', mimeType: 'image/png' },
      { type: 'text', text: '[image shot.png 640×480]' },
    ])
    expect(downgradeBlock(fileRef, { seq: 4, index: 1 })).toEqual([
      { type: 'resource_link', uri: `artifact://${sha}`, name: 'insects.zip', mimeType: 'application/zip' },
    ])
  })

  it('accepts reference rows in the schema and leaves them valid after downgrade', () => {
    const event = {
      seq: 1,
      ts: '2026-10-13T00:00:00.000Z',
      id,
      type: 'user/message',
      lane: 'main',
      v: 1,
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'principal',
      trust: 'trusted',
      data: { content: [imageRef, fileRef] },
    }
    expect(validateEvent(event).ok).toBe(true)
    const old = downgradeEvent(event as never)
    expect(validateEvent(old).ok).toBe(true)
    expect(JSON.stringify(old)).not.toContain('"attachment"')
  })

  it('rejects a reference that mixes in data or lacks dimensions', () => {
    const base = {
      seq: 1,
      ts: '2026-10-13T00:00:00.000Z',
      id,
      type: 'user/message',
      lane: 'main',
      v: 1,
      actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'principal',
      trust: 'trusted',
    }
    expect(validateEvent({ ...base, data: { content: [{ ...imageRef, data: 'QUJD' }] } }).ok).toBe(false)
    const { width: _w, ...noWidth } = imageRef
    expect(validateEvent({ ...base, data: { content: [noWidth] } }).ok).toBe(false)
    expect(
      validateEvent({ ...base, data: { content: [{ ...fileRef, attachment: { sha256: 'xyz', bytes: 1 } }] } })
        .ok,
    ).toBe(false)
  })
})

describe('downgrading for a client without attachment references', () => {
  const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
  const row = (type: string, data: unknown) =>
    ({
      seq: 2,
      ts: '2026-10-13T00:00:00.000Z',
      id,
      type,
      lane: 'main',
      v: 1,
      actor,
      origin: 'principal',
      trust: 'trusted',
      data,
    }) as never

  it('names an unnamed image, since an ACP link must have a name', () => {
    const { name: _name, ...unnamed } = imageRef
    expect(downgradeBlock(unnamed as never, { seq: 1, index: 1 })).toEqual([
      { type: 'resource_link', uri: `artifact://${sha}`, name: 'image', mimeType: 'image/png' },
      { type: 'text', text: '[image image 640×480]' },
    ])
  })

  it('rewrites queued inbox items and leaves every other row as the same object', () => {
    const inbox = row('inbox', {
      items: [
        { itemId: 'a', content: [fileRef] },
        { itemId: 'b', content: [{ type: 'text', text: 't' }] },
      ],
    })
    const old = downgradeEvent(inbox) as unknown as { data: { items: Array<{ content: unknown[] }> } }
    expect(old.data.items[0]?.content).toEqual(downgradeBlock(fileRef as never, { seq: 2, index: 1 }))
    expect(old.data.items[1]).toBe((inbox as { data: { items: unknown[] } }).data.items[1])
    const mixed = row('user/message', { content: [{ type: 'text', text: 'see' }, imageRef] })
    expect((downgradeEvent(mixed) as unknown as { data: { content: unknown[] } }).data.content).toEqual([
      { type: 'text', text: 'see' },
      ...downgradeBlock(imageRef as never, { seq: 2, index: 2 }),
    ])
    const plain = row('user/message', { content: [{ type: 'text', text: 'x' }] })
    expect(downgradeEvent(plain)).toBe(plain)
    const tool = row('tool/result', { toolUseId: 't', content: [imageRef] })
    expect(downgradeEvent(tool)).toBe(tool)
  })

  it('rewrites every content array of a projection and returns one without references unchanged', () => {
    const opening = {
      timeline: {
        nodes: [
          { kind: 'user', id: 'n1', content: [imageRef] },
          { kind: 'user', id: 'n2', content: [] },
        ],
      },
      pendingInputs: [{ itemId: 'p', content: [fileRef] }],
    }
    const old = downgradeTimeline(opening)
    expect(JSON.stringify(old)).not.toContain('"attachment"')
    expect(old.timeline.nodes[1]).toBe(opening.timeline.nodes[1])
    expect(opening.timeline.nodes[0]?.content).toEqual([imageRef])
    const none = { timeline: { nodes: [{ kind: 'user', content: [{ type: 'text', text: 'x' }] }] } }
    expect(downgradeTimeline(none)).toBe(none)
  })
})
