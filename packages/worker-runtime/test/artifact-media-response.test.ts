import { createHash } from 'node:crypto'
import { REQUEST_MEDIA_ARTIFACT_RECLAIMED } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { decodeArtifactMediaResponse } from '../src/main.js'

const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex')
const sha256 = createHash('sha256').update(bytes).digest('hex')

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha256,
    size: bytes.byteLength,
    mime: 'image/png',
    data: bytes.toString('base64'),
    ...overrides,
  }
}

describe('worker artifact media response boundary', () => {
  it('accepts one exact canonical response whose bytes match its declared digest', () => {
    expect(decodeArtifactMediaResponse(response(), sha256, bytes.byteLength)).toEqual(Uint8Array.from(bytes))
  })

  it.each([
    ['extra fields', { ...response(), extra: true }],
    ['wrong digest', response({ sha256: '0'.repeat(64) })],
    ['wrong size', response({ size: bytes.byteLength + 1 })],
    ['unsupported MIME', response({ mime: 'image/gif' })],
    ['non-canonical base64', response({ data: `${bytes.toString('base64')}\n` })],
  ])('rejects %s', (_label, value) => {
    expect(decodeArtifactMediaResponse(value, sha256, bytes.byteLength)).toBeUndefined()
  })

  it('rejects a response above the configured byte cap', () => {
    expect(decodeArtifactMediaResponse(response(), sha256, bytes.byteLength - 1)).toBeUndefined()
  })

  it('maps a reclaimed reply for the requested digest to the reclaimed sentinel', () => {
    expect(decodeArtifactMediaResponse({ sha256, reclaimed: true }, sha256, bytes.byteLength)).toBe(
      REQUEST_MEDIA_ARTIFACT_RECLAIMED,
    )
  })

  it.each([
    ['another digest', { sha256: '0'.repeat(64), reclaimed: true }],
    ['a non-true flag', { sha256, reclaimed: 'yes' }],
    ['an extra field', { sha256, reclaimed: true, size: 1 }],
    ['a missing digest', { reclaimed: true }],
  ])('rejects a reclaimed reply with %s', (_label, value) => {
    expect(decodeArtifactMediaResponse(value, sha256, bytes.byteLength)).toBeUndefined()
  })
})
