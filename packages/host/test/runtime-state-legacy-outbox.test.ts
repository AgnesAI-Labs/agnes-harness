import { RuntimeSchemaRefs } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { convertLegacyOutbox, decodeLegacyOutbox } from '../src/runtime/state/legacy-outbox.js'

const created = () => ({
  eventId: 'event',
  sourceAuthorityId: 'authority',
  sourceCommitId: 'commit',
  destination: 'inbox',
  typeId: 'agh.events/changed@1',
  payload: {
    kind: 'inline',
    schema: RuntimeSchemaRefs.RuntimeFormatData,
    value: null,
    digest: 'a'.repeat(64),
    bytes: 4,
  },
  fingerprint: 'b'.repeat(64),
  delivery: 'pending',
  attempts: 0,
  nextAttemptAt: '2026-10-02T00:00:00.000Z',
  claim: null,
  ackRef: null,
  sessionId: 'session',
  sourceReceiptId: 'receipt',
})
const projected = () => {
  const { sessionId: _session, sourceReceiptId: _receipt, ...rest } = created()
  return rest
}

describe('historical outbox emitted profiles', () => {
  it('reads the immutable creation profile without inventing present failure fields', () => {
    const input = created(),
      bytes = JSON.stringify(input)
    const source = decodeLegacyOutbox('state85-outbox-created', input)
    expect(source).toEqual(input)
    expect(source).not.toHaveProperty('consecutiveFailures')
    expect(source).not.toHaveProperty('lastError')
    expect(JSON.stringify(input)).toBe(bytes)
  })
  it('reads a delivery projection separately from immutable creation facts', () => {
    const value = { ...projected(), delivery: 'dead', attempts: 22 }
    expect(decodeLegacyOutbox('state85-outbox-delivery', value)).toEqual(value)
    expect(() => decodeLegacyOutbox('state85-outbox-created', value)).toThrow('profile')
    expect(() => decodeLegacyOutbox('state85-outbox-delivery', created())).toThrow('profile')
  })
  it.each(['consecutiveFailures', 'lastError', 'extra'])(
    'rejects an unregistered field %s in the frozen old profile',
    (key) => {
      expect(() => decodeLegacyOutbox('state85-outbox-created', { ...created(), [key]: null })).toThrow(
        'profile',
      )
    },
  )
  it('does not treat a narrow tag-only record as a full historical body', () => {
    expect(() => decodeLegacyOutbox('state85-outbox-created', { eventId: 'event' })).toThrow('profile')
  })
  it.each([-0, -1, 1.5, NaN])(
    'rejects invalid historical attempts %s without normalizing to zero',
    (attempts) => {
      expect(() => decodeLegacyOutbox('state85-outbox-delivery', { ...projected(), attempts })).toThrow()
    },
  )
  it('does not let JSON coercion disguise an invalid delivery enum', () => {
    expect(() =>
      decodeLegacyOutbox('state85-outbox-delivery', { ...projected(), delivery: ['pending'] }),
    ).toThrow('delivery fields')
  })
  it('cannot use immutable creation facts as evidence of later delivery progress', () => {
    expect(() => decodeLegacyOutbox('state85-outbox-created', { ...created(), attempts: 2 })).toThrow(
      'delivery progress',
    )
  })
  it('requires a closed claim with a valid positive or zero integer epoch', () => {
    const claim = { ownerId: 'owner', epoch: 1, until: '2026-10-02T00:00:01.000Z' }
    expect(
      decodeLegacyOutbox('state85-outbox-delivery', { ...projected(), delivery: 'claimed', claim }),
    ).toHaveProperty('claim', claim)
    expect(() =>
      decodeLegacyOutbox('state85-outbox-delivery', { ...projected(), claim: { ...claim, epoch: -0 } }),
    ).toThrow()
    expect(() =>
      decodeLegacyOutbox('state85-outbox-delivery', { ...projected(), claim: { ...claim, surprise: true } }),
    ).toThrow()
  })
  it('refuses conversion with missing failure history instead of filling zero and null', () => {
    const input = projected(),
      bytes = JSON.stringify(input)
    expect(() => convertLegacyOutbox(decodeLegacyOutbox('state85-outbox-delivery', input), null)).toThrow(
      'cannot be proved',
    )
    expect(JSON.stringify(input)).toBe(bytes)
  })
  it('uses explicitly reconstructed facts and preserves every historical delivery field', () => {
    const source = decodeLegacyOutbox('state85-outbox-delivery', { ...projected(), attempts: 5 })
    const result = convertLegacyOutbox(source, { consecutiveFailures: 1, lastError: null })
    expect(result).toEqual({ ...source, consecutiveFailures: 1, lastError: null })
    expect(result.attempts).toBe(5)
  })
  it('does not accept a dead-letter conversion without actual error facts', () => {
    const source = decodeLegacyOutbox('state85-outbox-delivery', {
      ...projected(),
      delivery: 'dead',
      attempts: 20,
    })
    expect(() => convertLegacyOutbox(source, { consecutiveFailures: 20, lastError: null })).toThrow(
      'registered target',
    )
  })
})
