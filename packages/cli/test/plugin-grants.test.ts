import { resolve } from 'node:path'
import { rpcError } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { pluginGrantsCommand } from '../src/commands/plugin-grants.js'
import { CommandError, UsageError } from '../src/errors.js'
import { run } from './admin-harness.js'

const pkg = '@example/companion'

describe('plugins grants', () => {
  it('lists, grants and revokes by package name, sending the workspace as an absolute path', async () => {
    const list = await run(pluginGrantsCommand, ['plugins', 'grants'], {
      'admin.managedWorkspaces.list': () => ({ items: [{ packageId: pkg, workspace: '/work/repo' }] }),
    })
    expect(list.calls).toEqual([['admin.managedWorkspaces.list', {}]])
    expect(list.out).toBe(`${pkg}\t/work/repo\n`)
    const one = await run(pluginGrantsCommand, ['plugins', 'grants', 'list', pkg, '--json'], {
      'admin.managedWorkspaces.list': () => ({ items: [] }),
    })
    expect(one.calls).toEqual([['admin.managedWorkspaces.list', { packageId: pkg }]])
    expect(JSON.parse(one.out)).toEqual({ items: [] })
    const grant = await run(pluginGrantsCommand, ['plugins', 'grants', 'grant', pkg, 'repo'], {
      'admin.managedWorkspaces.grant': (p) => ({
        packageId: p.packageId,
        workspace: '/work/repo',
        changed: true,
      }),
    })
    expect(grant.calls).toEqual([
      ['admin.managedWorkspaces.grant', { packageId: pkg, workspace: resolve(process.cwd(), 'repo') }],
    ])
    expect(grant.out).toBe(`granted\t${pkg}\t/work/repo\n`)
    const revoke = await run(pluginGrantsCommand, ['plugins', 'grants', 'revoke', pkg, '/work/repo'], {
      'admin.managedWorkspaces.revoke': (p) => ({
        packageId: p.packageId,
        workspace: '/work/repo',
        changed: false,
      }),
    })
    expect(revoke.calls).toEqual([
      ['admin.managedWorkspaces.revoke', { packageId: pkg, workspace: '/work/repo' }],
    ])
    expect(revoke.out).toBe(`already not granted\t${pkg}\t/work/repo\n`)
  })

  it('turns a daemon refusal into one fixed line and rejects malformed input without a call', async () => {
    const refused = await run(pluginGrantsCommand, ['plugins', 'grants', 'grant', pkg, '/elsewhere'], {
      'admin.managedWorkspaces.grant': () => {
        throw rpcError('SEMANTIC_REJECTED', { code: 'WORKSPACE_NOT_REGISTERED', detail: '\u001b[31msecret' })
      },
    })
    expect(refused.exit).toBeInstanceOf(CommandError)
    expect((refused.exit as Error).message).toMatch(/^WORKSPACE_NOT_REGISTERED: /)
    expect((refused.exit as Error).message).not.toContain('secret')
    const denied = await run(pluginGrantsCommand, ['plugins', 'grants'], {
      'admin.managedWorkspaces.list': () => {
        throw rpcError('CAPABILITY_DENIED')
      },
    })
    expect((denied.exit as Error).message).toMatch(/^CAPABILITY_DENIED: only the local owner/)
    for (const argv of [
      ['plugins', 'grants', 'grant', pkg],
      ['plugins', 'grants', 'remove', pkg, '/w'],
      ['plugins', 'grants', 'list', pkg, '/w'],
    ]) {
      const bad = await run(pluginGrantsCommand, argv, {})
      expect(bad.exit, argv.join(' ')).toBeInstanceOf(UsageError)
      expect(bad.calls).toEqual([])
    }
  })
})
