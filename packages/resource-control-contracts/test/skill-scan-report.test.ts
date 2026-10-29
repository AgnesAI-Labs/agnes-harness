import { describe, expect, it } from 'vitest'
import { validateResourceControlCall } from '../src/index.js'

const report = () => ({
  operationId: 'scan-1',
  generation: 1,
  observedAt: '2026-10-29T01:00:00.000Z',
  configurationRevision: 'a'.repeat(64),
  complete: false,
  foundCount: 0,
  skippedCount: 0,
  unreadableDirectoryCount: 1,
  truncated: false,
  directories: [
    {
      directoryId: 'b'.repeat(64),
      rootKey: 'user-agnes',
      state: 'unavailable',
      complete: false,
      foundCount: 0,
      skippedCount: 0,
      unreadable: true,
      truncated: false,
      issues: [{ code: 'permission-denied', stage: 'list', osCode: 'EPERM' }],
    },
  ],
})
const valid = (value: unknown) => validateResourceControlCall('_agnes/v1/resources.list', 'result', value).ok

describe('safe optional Skill scan reports', () => {
  it('accepts a directory diagnostic alongside an empty resource list', () => {
    expect(valid({ items: [], skillScanReport: report() })).toBe(true)
  })
  it('keeps old list responses valid without a scan report', () => {
    expect(valid({ items: [], skillRoots: [] })).toBe(true)
  })
  it.each(['path', 'message', 'stack', 'content'])('rejects a raw %s field in an issue', (field) => {
    const value = report()
    Object.assign(value.directories[0]!.issues[0]!, { [field]: '/private/secret' })
    expect(valid({ items: [], skillScanReport: value })).toBe(false)
  })
  it('bounds configured directories and rejects unknown error classifications', () => {
    const value = report()
    value.directories = Array.from({ length: 17 }, () => value.directories[0]!)
    expect(valid({ items: [], skillScanReport: value })).toBe(false)
    const unknown = report()
    unknown.directories[0]!.issues[0]!.osCode = 'SECRET_ERROR'
    expect(valid({ items: [], skillScanReport: unknown })).toBe(false)
  })
})
