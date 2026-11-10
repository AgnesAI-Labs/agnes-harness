import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemorySessionWorkspaces } from '@agnes/daemon-foundation/storage/lister'
import { MemorySessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import { afterEach, expect, it } from 'vitest'
import * as acp from '../src/local/methods/acp.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('commits trusted creation provenance after binding and before opening or activation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-internal-new-'))
  roots.push(root)
  const ownership = new MemorySessionPrincipalOwnership()
  const workspaces = new WorkspaceCatalog(
    new MemoryWorkspaceStore(),
    new MemorySessionWorkspaces(),
    async (path) => ({ path, name: 'test' }),
  )
  await workspaces.add(root)
  const order: string[] = []
  const cx = {
    host: { profile: { presets: { allowed: [] } } },
    workspaces,
    sessionOwnership: ownership,
    auth: { config: { transport: 'unix' } },
    registry: {
      get: () => undefined,
      open: async ({ key }: { key: string }) => {
        expect(order).toEqual(['commit'])
        expect(ownership.resolve(key)).toBeUndefined()
        order.push('open')
        return { key }
      },
    },
  }
  const call = { conn: { principalId: 'local' }, signal: new AbortController().signal }
  const result = await acp.createSessionInternal(
    cx as never,
    {
      cwd: root,
      mcpServers: [],
      _meta: { 'ai.agnes.harness': { sessionKey: 'scheduled' } },
    },
    call as never,
    {
      validateWorkspace: async (cwd: string, key: string) => {
        expect(key).toBe('scheduled')
        return workspaces.validate(cwd)
      },
      afterBind: (key: string) => {
        expect(workspaces.sessionPath(key)).toBe(root)
        expect(ownership.resolve(key)).toBeUndefined()
        order.push('commit')
      },
    },
  )
  expect(result).toEqual({ sessionId: 'scheduled' })
  expect(order).toEqual(['commit', 'open'])
  expect(ownership.resolve('scheduled')?.active).toBe(true)
})
