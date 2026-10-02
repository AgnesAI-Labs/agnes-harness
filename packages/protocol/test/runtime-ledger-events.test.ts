import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { X_AGNES_DATA } from '../gen/ts/session-v1.js'
import { EVENT_TYPES, isEventType, validateEvent } from '../src/index.js'
import { runtimeCommitData, runtimeFormatData } from './fixtures/runtime-ledger.js'

const envelope = (type: string, data: unknown) => ({
  seq: 1,
  ts: '2026-09-30T00:00:00Z',
  id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
  type,
  lane: 'main',
  v: 1,
  actor: { id: 'runtime-state', org: 'agnes', role: 'system', deptPath: [], attrs: {} },
  origin: 'system',
  trust: 'trusted',
  data,
})

describe('runtime ledger authority events', () => {
  it.each([
    ['runtime/format', 'RuntimeFormatData', runtimeFormatData],
    ['runtime/state-commit', 'RuntimeCommitData', runtimeCommitData],
  ] as const)('registers %s and validates the persisted payload', (type, name, data) => {
    expect(EVENT_TYPES).toContain(type)
    expect(isEventType(type)).toBe(true)
    expect(X_AGNES_DATA[type]).toBe(name)
    const source = JSON.parse(readFileSync(new URL('../schema/session-v1.json', import.meta.url), 'utf8'))
    expect(source.$defs[name]).toEqual({
      $ref: `https://agnes.ai/schema/runtime/v1/public.json#/$defs/${name}`,
    })
    expect(validateEvent(envelope(type, data)).ok).toBe(true)
    expect(validateEvent(envelope(type, { ...data, unknown: true })).ok).toBe(false)
    expect(validateEvent({ ...envelope(type, data), integrity: {} }).ok).toBe(false)
    expect(validateEvent({ ...envelope(type, data), ignorable: true }).ok).toBe(false)
    for (const key of Object.keys(data)) {
      const incomplete = { ...data } as Record<string, unknown>
      delete incomplete[key]
      expect(validateEvent(envelope(type, incomplete)).ok, key).toBe(false)
    }
  })
  it('accepts format 2 lineage and rejects unsupported format/reader declarations', () => {
    expect(
      validateEvent(
        envelope('runtime/format', {
          ...runtimeFormatData,
          previousFormat: 2,
          legacyThroughSeq: 100,
          sourceHeadDigest: 'd'.repeat(64),
        }),
      ).ok,
    ).toBe(true)
    expect(validateEvent(envelope('runtime/format', { ...runtimeFormatData, minReader: 2 })).ok).toBe(true)
    for (const [key, value] of [
      ['formatVersion', 1],
      ['runtimeSchemaMajor', 2],
      ['minReader', 3],
      ['previousFormat', 3],
      ['sourceHeadDigest', 'D'.repeat(64)],
    ])
      expect(
        validateEvent(envelope('runtime/format', { ...runtimeFormatData, [key as string]: value })).ok,
      ).toBe(false)
  })
  it('preserves nullable run/action/previous commit references and closed side counts', () => {
    expect(
      validateEvent(
        envelope('runtime/state-commit', {
          ...runtimeCommitData,
          runId: null,
          actionId: 'action-1',
          previousCommitId: 'commit-0',
        }),
      ).ok,
    ).toBe(true)
    for (const key of ['commitId', 'runId', 'actionId', 'previousCommitId'])
      expect(
        validateEvent(envelope('runtime/state-commit', { ...runtimeCommitData, [key]: '' })).ok,
        key,
      ).toBe(false)
    for (const key of ['transactionFingerprint', 'mutationsDigest', 'sideListsDigest'])
      expect(
        validateEvent(envelope('runtime/state-commit', { ...runtimeCommitData, [key]: 'a'.repeat(63) })).ok,
        key,
      ).toBe(false)
    for (const key of Object.keys(runtimeCommitData.counts)) {
      const counts = { ...runtimeCommitData.counts } as Record<string, unknown>
      delete counts[key]
      expect(validateEvent(envelope('runtime/state-commit', { ...runtimeCommitData, counts })).ok, key).toBe(
        false,
      )
    }
    expect(
      validateEvent(
        envelope('runtime/state-commit', {
          ...runtimeCommitData,
          counts: { ...runtimeCommitData.counts, extra: 0 },
        }),
      ).ok,
    ).toBe(false)
  })
  it('enforces UInt53 on every proof counter, including negative zero', () => {
    for (const invalid of [-1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        validateEvent(envelope('runtime/format', { ...runtimeFormatData, legacyThroughSeq: invalid })).ok,
      ).toBe(false)
      for (const key of ['authorityEpoch', 'writerEpoch', 'mutationCount'])
        expect(
          validateEvent(envelope('runtime/state-commit', { ...runtimeCommitData, [key]: invalid })).ok,
          key,
        ).toBe(false)
      for (const key of Object.keys(runtimeCommitData.counts))
        expect(
          validateEvent(
            envelope('runtime/state-commit', {
              ...runtimeCommitData,
              counts: { ...runtimeCommitData.counts, [key]: invalid },
            }),
          ).ok,
          key,
        ).toBe(false)
    }
    expect(
      validateEvent(
        envelope('runtime/format', { ...runtimeFormatData, legacyThroughSeq: Number.MAX_SAFE_INTEGER }),
      ).ok,
    ).toBe(true)
  })
  it('keeps ignorable extension rows compatible', () => {
    expect(validateEvent({ ...envelope('x/core/probe', { value: -0 }), ignorable: true }).ok).toBe(true)
  })
})
