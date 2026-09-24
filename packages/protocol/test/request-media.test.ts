import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateEvent, validateRequestMedia } from '../src/index.js'

const sessionSchema = JSON.parse(
  readFileSync(new URL('../schema/session-v1.json', import.meta.url), 'utf8'),
) as { $defs: Record<string, Record<string, unknown>> }
const modelSchema = JSON.parse(readFileSync(new URL('../schema/model.json', import.meta.url), 'utf8')) as {
  $defs: Record<string, Record<string, unknown>>
}

function dereferenceModelSha(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dereferenceModelSha)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  if (record.$ref === '#/$defs/Sha256') return dereferenceModelSha(modelSchema.$defs.Sha256)
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, dereferenceModelSha(item)]))
}

const actor = { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} }
const envelope = (type: string, data: unknown) => ({
  seq: 1,
  ts: '2026-09-17T00:00:00Z',
  id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
  type,
  data,
  actor,
  origin: 'system',
  trust: 'trusted',
})

const legacyHeader = {
  derived_hash: 'd'.repeat(64),
  sent_hash: 's'.repeat(64),
  transforms: [{ event: 'sent_hash', ext: 'reported' }],
  prompt_prefix_hash: 'p'.repeat(64),
  tool_schema_hash: 't'.repeat(64),
  parser_version: '1',
  contract_id: null,
  model: 'fixture/model',
  envelopeNonce: 'nonce',
}

const media = {
  version: 1,
  selectionOrder: [1],
  route: 'native-image',
  manifest: [
    {
      nodeSeq: 7,
      artifactUri: `artifact://${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      mime: 'image/jpeg',
      width: 1456,
      height: 909,
      selected: false,
      reason: 'deduplicated',
      elementMapDigest: 'b'.repeat(64),
    },
    {
      nodeSeq: 9,
      artifactUri: `artifact://${'c'.repeat(64)}`,
      sha256: 'c'.repeat(64),
      mime: 'image/png',
      width: 1456,
      height: 909,
      selected: true,
    },
  ],
}

const sent = {
  prompt_prefix_hash: null,
  tool_schema_hash: 'a'.repeat(64),
  parser_version: '1',
  contract_id: null,
  model: { route: 'fixture', id: 'fixture/model', responseModel: 'fixture/model-20260917' },
  derived_hash: 'd'.repeat(64),
  sent_hash: 'b'.repeat(64),
  transforms: [{ event: 'sent_hash', ext: 'reported' }],
}

describe('deterministic request media protocol', () => {
  it('keeps request/sent structurally identical to the provider ContractStamp', () => {
    expect(dereferenceModelSha(sessionSchema.$defs.RequestSent)).toEqual(
      dereferenceModelSha(modelSchema.$defs.ContractStamp),
    )
  })

  it('keeps a legacy request/header readable while accepting a complete versioned media contract', () => {
    expect(validateEvent(envelope('request/header', legacyHeader)).ok).toBe(true)
    expect(validateEvent(envelope('request/header', { ...legacyHeader, media })).ok).toBe(true)
  })

  it('fails closed on partial or malformed media metadata without guessing runtime caps', () => {
    const cases = [
      { ...media, version: 2 },
      { ...media, route: 'provider-fallback' },
      { ...media, selectionOrder: [-1] },
      { ...media, selectionOrder: [1, 1] },
      { ...media, manifest: [{ ...media.manifest[0], sha256: 'short' }] },
      { ...media, manifest: [{ ...media.manifest[0], artifactUri: 'file:///private/screenshot.png' }] },
      { ...media, manifest: [{ ...media.manifest[0], mime: 'image/gif' }] },
      { ...media, manifest: [{ ...media.manifest[0], width: 0 }] },
      { ...media, extra: true },
    ]
    for (const invalid of cases)
      expect(validateEvent(envelope('request/header', { ...legacyHeader, media: invalid })).ok).toBe(false)
    const { selectionOrder: _selectionOrder, ...partial } = media
    expect(validateEvent(envelope('request/header', { ...legacyHeader, media: partial })).ok).toBe(false)
  })

  it('resolves exactly the persisted selected indexes and rejects cross-field drift', () => {
    const checked = validateRequestMedia(media)
    expect(checked.ok).toBe(true)
    if (checked.ok) expect(checked.value.selected).toEqual([media.manifest[1]])
    const { reason: _reason, ...withoutReason } = media.manifest[0] as (typeof media.manifest)[number] & {
      reason: string
    }

    const semanticInvalid: Array<[unknown, string]> = [
      [{ ...media, selectionOrder: [2] }, '/selectionOrder/0'],
      [{ ...media, selectionOrder: [] }, '/selectionOrder'],
      [{ ...media, selectionOrder: [0, 1] }, '/selectionOrder'],
      [
        {
          ...media,
          manifest: [media.manifest[0], { ...media.manifest[1], reason: 'unsupported' }],
        },
        '/manifest/1/reason',
      ],
      [
        {
          ...media,
          manifest: [withoutReason, media.manifest[1]],
        },
        '/manifest/0/reason',
      ],
      [
        {
          ...media,
          manifest: [
            media.manifest[0],
            { ...media.manifest[1], artifactUri: `artifact://${'d'.repeat(64)}` },
          ],
        },
        '/manifest/1/artifactUri',
      ],
      [{ ...media, route: 'text-only' }, '/route'],
    ]
    for (const [invalid, path] of semanticInvalid) {
      const result = validateRequestMedia(invalid)
      expect(result.ok, path).toBe(false)
      if (!result.ok) expect(result.errors[0]?.path).toBe(path)

      // Durable ledgers, imported fixtures and recovery all enter through validateEvent; callers
      // must not need to remember a second validation step to keep semantic-invalid media out.
      const eventResult = validateEvent(envelope('request/header', { ...legacyHeader, media: invalid }))
      expect(eventResult.ok, `validateEvent ${path}`).toBe(false)
      if (!eventResult.ok) expect(eventResult.errors[0]?.path).toBe(`/data/media${path}`)
    }
  })

  it('allows native and auxiliary routes to select no image, and text-only only when none is selected', () => {
    const none = {
      ...media,
      selectionOrder: [],
      manifest: media.manifest.map((entry) => ({
        ...entry,
        selected: false,
        reason: entry.reason ?? 'unsupported',
      })),
    }
    for (const route of ['native-image', 'auxiliary-vision', 'text-only'] as const) {
      const checked = validateRequestMedia({ ...none, route })
      expect(checked.ok, route).toBe(true)
      if (checked.ok) expect(checked.value.selected).toEqual([])
    }
  })

  it('records the provider-owned stamp separately as a strict request/sent event', () => {
    expect(validateEvent(envelope('request/sent', sent)).ok).toBe(true)
    expect(validateEvent(envelope('request/sent', { ...sent, sent_hash: 'short' })).ok).toBe(false)
    expect(validateEvent(envelope('request/sent', { ...sent, extra: true })).ok).toBe(false)
    const { transforms: _transforms, ...partial } = sent
    expect(validateEvent(envelope('request/sent', partial)).ok).toBe(false)
  })
})
