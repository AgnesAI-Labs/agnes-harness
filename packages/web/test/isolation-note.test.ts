import { describe, expect, it } from 'vitest'
import { isolationNoteKey, sessionIsolationOf } from '../src/app/isolation-note.js'

const boundary = {
  contract: 'windows-write-restricted-v1',
  fileWrite: 'acl-partial',
  fileRead: 'unrestricted',
  network: 'unrestricted',
  processTree: 'job-object',
} as const

describe('the composer isolation note', () => {
  const note = (os: string, isolation?: ReturnType<typeof sessionIsolationOf>, draftingNew = false) =>
    isolationNoteKey({ connected: true, os, draftingNew, currentId: 's', isolation })

  it('reads each Windows session from its own enforcement, not the platform', () => {
    const acl = sessionIsolationOf('s', {
      provider: 'local',
      enforcement: { level: 'partial', scope: ['file'], boundary },
    })
    const open = sessionIsolationOf('s', { provider: 'local', enforcement: { level: 'none', scope: [] } })
    expect(acl).toEqual({ sessionId: 's', disabled: false, boundary: true })
    expect(note('win32', acl)).toBe('session.runtime.windowsAclIsolation')
    expect(note('win32', open)).toBe('session.runtime.platformNoCommandIsolation')
    // Another session's facts never describe this one; an unknown session keeps the cautious note.
    expect(note('win32', acl && { ...acl, sessionId: 'other' })).toBe(
      'session.runtime.platformNoCommandIsolation',
    )
    expect(note('win32', acl, true)).toBe('session.runtime.platformNoCommandIsolation')
  })

  it('leaves other platforms as they were', () => {
    const open = sessionIsolationOf('s', {
      provider: 'local',
      enforcement: { level: 'partial', scope: ['file'] },
    })
    expect(note('darwin', open)).toBe('session.runtime.noOsIsolation')
    const full = sessionIsolationOf('s', {
      provider: 'local',
      enforcement: { level: 'full', scope: ['file', 'network', 'process'] },
    })
    expect(note('darwin', full)).toBeUndefined()
    expect(note('darwin')).toBeUndefined()
    expect(
      sessionIsolationOf('s', { provider: 'remote', enforcement: { level: 'none', scope: [] } }),
    ).toBeUndefined()
    expect(
      isolationNoteKey({ connected: false, os: 'win32', draftingNew: false, currentId: 's' }),
    ).toBeUndefined()
  })
})
