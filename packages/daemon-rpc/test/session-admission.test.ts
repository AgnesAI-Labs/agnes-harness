import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSessionAdmissionPort,
  MemorySessionPrincipalOwnership,
  MemorySessionWorkspaces,
  MemoryWorkspaceStore,
  reserveOwnedSession,
  SessionAdmissionDenied,
  WorkspaceCatalog,
} from '../src/local/index.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const catalog = async (root: string) => {
  const workspaces = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    async (path) => ({ path, name: 'ws' }),
  )
  await workspaces.add(root)
  return workspaces
}

describe('reserveOwnedSession', () => {
  it('binds a new key, persists the workspace, and leaves ownership pending until activate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-admit-'))
    roots.push(root)
    const ownership = new MemorySessionPrincipalOwnership()
    const workspaces = await catalog(root)
    const reserved = await reserveOwnedSession({
      ownership,
      workspaces,
      principalId: 'local',
      sessionKey: 'session-a',
      canonicalRoot: root,
      hasSessionFact: false,
    })
    expect(reserved.reservedNew).toBe(true)
    expect(ownership.resolve('session-a')).toBeUndefined()
    expect(workspaces.sessionPath('session-a')).toBe(root)
    expect(ownership.activateNew('session-a', 'local')).toBe(true)
    expect(ownership.resolve('session-a')).toEqual({ active: true, principalId: 'local' })
  })

  it('lets the same principal retry a pending reservation and refuses a different principal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-admit-'))
    roots.push(root)
    const ownership = new MemorySessionPrincipalOwnership()
    const workspaces = await catalog(root)
    await reserveOwnedSession({
      ownership,
      workspaces,
      principalId: 'local',
      sessionKey: 'session-a',
      canonicalRoot: root,
      hasSessionFact: false,
    })
    const retry = await reserveOwnedSession({
      ownership,
      workspaces,
      principalId: 'local',
      sessionKey: 'session-a',
      canonicalRoot: root,
      hasSessionFact: true,
    })
    expect(retry.reservedNew).toBe(true)
    await expect(
      reserveOwnedSession({
        ownership,
        workspaces,
        principalId: 'other',
        sessionKey: 'session-a',
        canonicalRoot: root,
        hasSessionFact: true,
      }),
    ).rejects.toBeInstanceOf(SessionAdmissionDenied)
  })
})

describe('createSessionAdmissionPort', () => {
  it('hands the Host the catalog envelope and activates only when asked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-admit-port-'))
    roots.push(root)
    const workspaces = await catalog(root)
    const accepted: Array<{ sessionKey: string; workspaceId: string }> = []
    const port = createSessionAdmissionPort({
      ownership: new MemorySessionPrincipalOwnership(),
      workspaces,
      principalId: 'local',
      host: {
        kernel: { get: () => undefined },
        acceptWorkspaceBinding: (envelope, sessionKey) => {
          accepted.push({ sessionKey, workspaceId: envelope.workspaceId })
          return { sessionKey, workspaceId: envelope.workspaceId } as never
        },
      },
    })
    const reserved = await port.reserve('session-a', root)
    expect(reserved.reservedNew).toBe(true)
    expect(accepted).toEqual([{ sessionKey: 'session-a', workspaceId: reserved.binding.workspaceId }])
    expect(workspaces.sessionPath('session-a')).toBe(root)
    port.activate('session-a', true)
    const again = await port.reserve('session-a', root)
    expect(again.reservedNew).toBe(false)
  })
})
