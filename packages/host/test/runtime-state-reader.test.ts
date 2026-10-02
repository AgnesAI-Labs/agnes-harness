import { RuntimeSchemaRefs, type SchemaRef } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { assertStateReader, createStateRecordReader } from '../src/runtime/state/reader.js'

const ref = RuntimeSchemaRefs.RuntimeFormatData

describe('State record reader', () => {
  it.each([0, -0, -1, 1.5, 3, NaN, Infinity])(
    'rejects unsupported minimum reader %s before decoding',
    (required) => {
      const decode = vi.fn()
      const reader = createStateRecordReader(2, [{ schema: ref, minReader: 1, decode }])
      expect(() => reader.decode(ref, required, {})).toThrow('minimum reader')
      expect(decode).not.toHaveBeenCalled()
    },
  )
  it('reader one refuses reader two before payload decoding', () => {
    const decode = vi.fn()
    const reader = createStateRecordReader(1, [{ schema: ref, minReader: 2, decode }])
    expect(() => reader.decode(ref, 2, {})).toThrow('minimum reader')
    expect(decode).not.toHaveBeenCalled()
  })
  it('rejects a record which understates the required decoder capability', () => {
    const decode = vi.fn()
    const reader = createStateRecordReader(2, [{ schema: ref, minReader: 2, decode }])
    expect(() => reader.decode(ref, 1, {})).toThrow('understates')
    expect(decode).not.toHaveBeenCalled()
  })
  it.each(['digest', 'revision', 'typeId'] as const)(
    'requires the full schema identity including %s',
    (key) => {
      const decode = vi.fn()
      const reader = createStateRecordReader(2, [{ schema: ref, minReader: 1, decode }])
      const changed = {
        ...ref,
        [key]:
          key === 'revision' ? ref.revision + 1 : key === 'digest' ? '0'.repeat(64) : 'agh.runtime/unknown@1',
      }
      expect(() => reader.decode(changed, 1, {})).toThrow('unknown State record schema')
      expect(decode).not.toHaveBeenCalled()
    },
  )
  it('keeps mixed history separate and preserves payload bytes', () => {
    const newer = { ...RuntimeSchemaRefs.RuntimeCommitData }
    const oldValue = { field: '\\u0000', extra: 'legacy source' }
    const oldBytes = JSON.stringify(oldValue)
    const reader = createStateRecordReader(2, [
      { schema: ref, minReader: 1, decode: (value) => ({ family: 'old', value }) },
      { schema: newer, minReader: 2, decode: (value) => ({ family: 'new', value }) },
    ])
    expect(reader.decode(ref, 1, oldValue)).toEqual({ family: 'old', value: oldValue })
    expect(reader.decode(newer, 2, oldValue)).toEqual({ family: 'new', value: oldValue })
    expect(JSON.stringify(oldValue)).toBe(oldBytes)
  })
  it('preserves decoder rejection instead of falling back to a generic JSON reader', () => {
    const reader = createStateRecordReader(2, [
      {
        schema: ref,
        minReader: 1,
        decode: () => {
          throw Error('source profile mismatch')
        },
      },
    ])
    expect(() => reader.decode(ref, 1, {})).toThrow('source profile mismatch')
  })
  it('rejects duplicate complete identities instead of selecting a different decoder', () => {
    const entry = { schema: ref, minReader: 1 as const, decode: vi.fn() }
    expect(() => createStateRecordReader(2, [entry, entry])).toThrow('duplicate')
  })
  it('does not allow mutation of the registration to redirect an installed decoder', () => {
    const registered: SchemaRef = { ...ref }
    const decode = vi.fn((value) => value)
    const reader = createStateRecordReader(2, [{ schema: registered, minReader: 1, decode }])
    registered.digest = '0'.repeat(64)
    expect(() => reader.decode(registered, 1, {})).toThrow('unknown')
    expect(reader.decode(ref, 1, 'preserved')).toBe('preserved')
  })
  it('rejects an unregistered reader capability even for an otherwise valid old record', () => {
    expect(() => assertStateReader(1, 3 as 2)).toThrow('minimum reader')
  })
  it('allows both explicitly supported reader capabilities without mutating history', () => {
    expect(() => assertStateReader(1, 1)).not.toThrow()
    expect(() => assertStateReader(1, 2)).not.toThrow()
    expect(() => assertStateReader(2, 2)).not.toThrow()
  })
})
