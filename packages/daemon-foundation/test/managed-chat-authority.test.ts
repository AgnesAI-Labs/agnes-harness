import { expect, test } from 'vitest'
import { MemoryWorkspaceBindings } from '../src/storage/workspaces.js'
import { sqliteTables } from './sqlite-tables.js'

test('freezes legacy sources once and issues only matching bound grants', async () => {
  const { ManagedChatAuthority, assertLegacyChatReadGrant } = await import(
    '../src/storage/managed-chat-authority.js'
  )
  const tables = sqliteTables()
  const bindings = new MemoryWorkspaceBindings()
  const old = { sessionKey: 'old', workspaceId: 'w', revision: 1, canonicalRoot: '/legacy' }
  bindings.putIfAbsent(old)
  const authority = new ManagedChatAuthority(tables.table('managed_chat_authority'), bindings, '/legacy')
  await authority.initialize({ bindings: [old], schedules: [{ scheduleId: 's', targetRoot: '/legacy' }] })
  await authority.initialize({ bindings: [], schedules: [{ scheduleId: 'new', targetRoot: '/legacy' }] })
  const grant = await authority.authorizeExisting('old')
  expect(grant?.root).toBe('/legacy')
  expect(() => assertLegacyChatReadGrant(grant)).not.toThrow()
  expect(() => assertLegacyChatReadGrant({ ...grant })).toThrow()
  expect(authority.scheduleEligible('s', '/legacy')).toBe(true)
  expect(authority.scheduleEligible('new', '/legacy')).toBe(false)
  expect(await authority.authorizeExisting('unknown')).toBeUndefined()
  await tables.close()
})
test('scheduled pending sources cannot read before commit and interrupted runs stay denied', async () => {
  const { ManagedChatAuthority } = await import('../src/storage/managed-chat-authority.js')
  const bindings = new MemoryWorkspaceBindings()
  const tables = sqliteTables()
  const authority = new ManagedChatAuthority(tables.table('managed_chat_authority'), bindings, '/legacy')
  await authority.initialize({ bindings: [], schedules: [{ scheduleId: 's', targetRoot: '/legacy' }] })
  const input = {
    runId: 'run',
    jobKey: 'job',
    taskId: 's',
    revision: 1,
    sessionKey: 'created',
    root: '/legacy',
  }
  authority.reserveScheduledBinding(input)
  bindings.putIfAbsent({ sessionKey: 'created', workspaceId: 'w', revision: 1, canonicalRoot: '/legacy' })
  expect(await authority.authorizeExisting('created')).toBeUndefined()
  authority.commitScheduledBinding('created')
  expect((await authority.authorizeExisting('created'))?.source).toBe('schedule')
  expect(() => authority.reserveScheduledBinding({ ...input, sessionKey: 'another' })).toThrow()
  authority.revokeSchedule('s')
  expect(authority.scheduleEligible('s', '/legacy')).toBe(false)
  expect((await authority.authorizeExisting('created'))?.source).toBe('schedule')
  await tables.close()
})

test('derived grants retain provenance and cannot cover arbitrary roots', async () => {
  const { ManagedChatAuthority } = await import('../src/storage/managed-chat-authority.js')
  const bindings = new MemoryWorkspaceBindings()
  const parent = { sessionKey: 'parent', workspaceId: 'w', revision: 1, canonicalRoot: '/legacy' }
  bindings.putIfAbsent(parent)
  const authority = new ManagedChatAuthority(undefined, bindings, '/legacy')
  await authority.initialize({ bindings: [parent], schedules: [] })
  await authority.bindDerived('parent', 'child')
  bindings.putIfAbsent({ ...parent, sessionKey: 'child' })
  expect((await authority.authorizeExisting('child'))?.source).toBe('derived')
  bindings.putIfAbsent({ ...parent, sessionKey: 'outsider', canonicalRoot: '/private' })
  expect(await authority.authorizeExisting('outsider')).toBeUndefined()
})
