import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { snapshotApprovesLocalStart } from '../src/mcp-server-opener.js'

it('binds local startup permission to the current profile, exact definition and live trust', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-mcp-grant-'))
  const path = join(root, 'snapshot.json')
  const definition = {
    serverId: 'fixture',
    displayName: 'Fixture',
    transport: { kind: 'stdio' as const, executable: '/fixture/mcp', args: ['v1'] },
    secretBinding: { kind: 'none' as const },
  }
  const revision = createHash('sha256').update(jcs(definition)).digest('hex')
  const row = { definition, revision, localStartApproval: revision, trust: 'trusted', desired: 'enabled' }
  const publish = (change = {}) =>
    writeFile(
      path,
      JSON.stringify({
        version: 1,
        profile: 'local-dev',
        mcpAuthority: 'resource-control',
        mcp: [{ ...row, ...change }],
      }),
    )
  try {
    expect(await snapshotApprovesLocalStart(path, 'local-dev', definition)).toBe(false)
    await publish()
    expect(await snapshotApprovesLocalStart(path, 'local-dev', definition)).toBe(true)
    expect(await snapshotApprovesLocalStart(path, 'other-profile', definition)).toBe(false)
    expect(await snapshotApprovesLocalStart(path, 'local-dev', { ...definition, serverId: 'other' })).toBe(
      false,
    )
    expect(
      await snapshotApprovesLocalStart(path, 'local-dev', {
        ...definition,
        transport: { ...definition.transport, args: ['v2'] },
      }),
    ).toBe(false)
    await publish({ trust: 'rejected' })
    expect(await snapshotApprovesLocalStart(path, 'local-dev', definition)).toBe(false)
    await publish({ desired: 'disabled' })
    expect(await snapshotApprovesLocalStart(path, 'local-dev', definition)).toBe(false)
    await publish({ localStartApproval: undefined })
    expect(await snapshotApprovesLocalStart(path, 'local-dev', definition)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
