import { createHash } from 'node:crypto'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { mediaConsumed } from '../../src/runtime/model-adapter/media.js'
import type { ModelWireMedia, ModelWireSource } from '../../src/runtime/model-adapter/ports.js'

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const features = {
  input: ['text', 'image'],
  output: ['text'],
  tools: false,
  structuredOutput: false,
  streaming: true,
}
const plan = {
  key: 'media:a',
  sourceRefs: [],
  sourceDigest: 'a'.repeat(64),
  transformSchema: { typeId: 't', revision: 1, digest: 'b'.repeat(64) },
  parameters: {},
  targetFeatures: features,
  provider: { bindingId: 'm', providerId: 'p', contract: 'agh.media', logicalName: 'd' },
}
const imageBytes = new Uint8Array([1, 2, 3])
const label = '[untrusted tool image; x]'
const request = (blocks: unknown[]) => ({ messages: [{ role: 'user', content: blocks }] })
const source = (
  over: { plans?: unknown[]; media?: ModelWireMedia[]; blocks?: unknown[]; features?: unknown } = {},
): ModelWireSource =>
  ({
    prepared: { mediaPlans: over.plans ?? [plan], target: { features: over.features ?? features } },
    request: request(
      over.blocks ?? [
        { type: 'text', text: 'hi' },
        { type: 'text', text: label },
        { type: 'image', data: Buffer.from(imageBytes).toString('base64'), mimeType: 'image/png' },
      ],
    ),
    media: over.media ?? [
      {
        planKey: 'media:a',
        planDigest: canonicalJsonDigest(plan as never),
        usageIds: [],
        parts: [
          { kind: 'text', sha256: sha(label) },
          { kind: 'image', sha256: sha(imageBytes) },
        ],
      },
    ],
  }) as unknown as ModelWireSource

describe('mediaConsumed', () => {
  it('accepts a request that carries exactly the verified parts', () => {
    expect(mediaConsumed(source())).toBe(true)
  })
  it('accepts no plans and no image', () => {
    expect(mediaConsumed(source({ plans: [], media: [], blocks: [{ type: 'text', text: 'hi' }] }))).toBe(true)
  })
  it('refuses an image nobody planned', () => {
    expect(mediaConsumed(source({ plans: [], media: [] }))).toBe(false)
  })
  it.each([
    ['missing evidence', { media: [] }],
    [
      'another plan key',
      {
        media: [
          {
            planKey: 'media:x',
            planDigest: canonicalJsonDigest(plan as never),
            usageIds: [],
            parts: [
              { kind: 'text', sha256: sha(label) },
              { kind: 'image', sha256: sha(imageBytes) },
            ],
          },
        ],
      },
    ],
    [
      'an altered plan digest',
      {
        media: [
          {
            planKey: 'media:a',
            planDigest: 'f'.repeat(64),
            usageIds: [],
            parts: [
              { kind: 'text', sha256: sha(label) },
              { kind: 'image', sha256: sha(imageBytes) },
            ],
          },
        ],
      },
    ],
    ['widened target features', { features: { ...features, input: ['text'] } }],
    [
      'a second image the evidence never named',
      {
        blocks: [
          { type: 'text', text: label },
          { type: 'image', data: Buffer.from(imageBytes).toString('base64'), mimeType: 'image/png' },
          { type: 'image', data: Buffer.from(imageBytes).toString('base64'), mimeType: 'image/png' },
        ],
      },
    ],
    [
      'a different image',
      {
        blocks: [
          { type: 'text', text: label },
          { type: 'image', data: Buffer.from([9, 9]).toString('base64'), mimeType: 'image/png' },
        ],
      },
    ],
    [
      'a verified text part missing from the request',
      {
        blocks: [{ type: 'image', data: Buffer.from(imageBytes).toString('base64'), mimeType: 'image/png' }],
      },
    ],
  ])('refuses %s', (_name, over) => {
    expect(mediaConsumed(source(over as never))).toBe(false)
  })
  it('refuses two plans with the same key and shared usage', () => {
    const twin = { ...plan }
    const entry = {
      planKey: 'media:a',
      planDigest: canonicalJsonDigest(plan as never),
      usageIds: [],
      parts: [],
    }
    expect(mediaConsumed(source({ plans: [plan, twin], media: [entry, entry], blocks: [] }))).toBe(false)
    const usedEntry = { ...entry, usageIds: ['u'] }
    expect(mediaConsumed(source({ plans: [plan, twin], media: [usedEntry, usedEntry], blocks: [] }))).toBe(
      false,
    )
    const other = { ...plan, key: 'media:b' }
    const second = {
      planKey: 'media:b',
      planDigest: canonicalJsonDigest(other as never),
      usageIds: ['u'],
      parts: [],
    }
    expect(mediaConsumed(source({ plans: [plan, other], media: [usedEntry, second], blocks: [] }))).toBe(
      false,
    )
  })
})
