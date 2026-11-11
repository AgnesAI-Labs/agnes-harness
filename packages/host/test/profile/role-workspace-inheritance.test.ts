import { WorkspaceBindingAuthority } from '@agnes/host-common/workspace-authority'
import { expect, it, vi } from 'vitest'
import { createRoleChildren } from '../../src/runtime/profile/role-children.js'

it('reopens a role child with the trusted parent legacy grant derived for its own session key', async () => {
  const authority = new WorkspaceBindingAuthority()
  const grant = {
    sessionKey: 'parent',
    workspaceId: 'a'.repeat(64),
    root: '/data/chats',
    source: 'existing' as const,
    directoryIdentity: '1:2',
  }
  const parent = authority.accept(
    {
      version: 1,
      sessionKey: 'parent',
      workspaceId: grant.workspaceId,
      revision: 1,
      canonicalRoot: grant.root,
      legacyChatReadGrant: grant,
    },
    'parent',
  )
  const createSession = vi.fn(async () => ({ close: async () => {} }))
  const host = {
    acceptWorkspaceBinding: (envelope: never, key: string) => authority.accept(envelope, key),
    createSession,
    kernel: { sessions: new Map() },
  }
  const port = createRoleChildren({
    read: (key: string) => ({ sessionKey: key }),
    open: async () => ({ host }),
    containers: new Map(),
    sessionOwners: new Map(),
    opened: () => undefined,
  } as never)
  await port.reopen?.('child', { cwd: grant.root, workspaceIdentity: parent } as never)
  expect(createSession).toHaveBeenCalledWith(
    expect.objectContaining({
      binding: expect.objectContaining({
        sessionKey: 'child',
        legacyChatReadGrant: { ...grant, sessionKey: 'child', source: 'derived' },
      }),
    }),
  )
  createSession.mockClear()
  await expect(
    port.reopen?.('forged', { cwd: grant.root, workspaceIdentity: { ...parent } } as never),
  ).rejects.toThrow('E_WORKSPACE_UNTRUSTED')
  expect(createSession).not.toHaveBeenCalled()
})

it('reopens a role child with the parent’s outward command rules', async () => {
  const createSession = vi.fn(async () => ({ close: async () => {} }))
  const port = createRoleChildren({
    read: (key: string) => ({ sessionKey: key }),
    open: async () => ({ host: { createSession, kernel: { sessions: new Map() } } }),
    containers: new Map(),
    sessionOwners: new Map(),
    opened: () => undefined,
  } as never)
  await port.reopen?.('child', { cwd: '/w', writerRunId: 'r', outwardCommandRules: true } as never)
  expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ outwardCommandRules: true }))
  createSession.mockClear()
  await port.reopen?.('child', { cwd: '/w', writerRunId: 'r' } as never)
  expect(createSession).toHaveBeenCalledWith(expect.not.objectContaining({ outwardCommandRules: true }))
})
