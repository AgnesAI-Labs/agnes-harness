import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { roleHuman, setupRoleEscalation } from './role-escalation-fixture.js'

// A fork that adds a directory opens a fresh workspace runtime for the child, and a fork scan does
// not carry the parent's captured role delegation. The extension must therefore be refused for a role
// session instead of quietly dropping its restrictions, while an ordinary session still extends.
it('refuses to extend the workspace of a role session fork but extends an ordinary one', async () => {
  const fixture = await setupRoleEscalation(
    async () => ({ verdict: 'allowed-once', answeredBy: roleHuman }),
    {
      calls: () => [],
    },
  )
  const parent = fixture.parent
  try {
    await parent.enqueue('next-turn', {
      actor: parent.d.actor,
      trust: 'untrusted',
      content: [{ type: 'text', text: 'Delegate' }],
    })
    await parent.acceptInput()
    const handle = await parent.d.children.createWithKind!('spawn', {
      parent: parent.key,
      cwd: fixture.workspaceRoot,
      role: fixture.refs[0],
      input: 'Write requirements',
      resident: true,
    })
    const role = fixture.host.kernel.get(handle.key)!
    await handle.run('Write requirements')
    expect(await role.scan({ type: 'x/core/role-delegation', limit: 1 })).toHaveLength(1)
    await parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) }).catch(() => undefined)
    const ended = async (session: typeof role) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await session.scan({ type: 'turn/end', order: 'desc', limit: 1 })
        if (row) return row.seq
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`no completed turn in ${session.key}`)
    }

    const extra = join(
      fixture.workspaceRoot,
      '..',
      `extra-${createHash('sha256').update(handle.key).digest('hex').slice(0, 8)}`,
    )
    mkdirSync(extra, { recursive: true })
    const canonicalExtra = realpathSync.native(extra)
    const fork = async (from: typeof role, key: string) => {
      const root = from.d.cwd
      const binding = fixture.host.acceptWorkspaceBinding(
        {
          version: 1,
          sessionKey: key,
          workspaceId: createHash('sha256').update(root).digest('hex'),
          revision: 1,
          canonicalRoot: root,
          extraRoots: [canonicalExtra],
        },
        key,
      )
      return fixture.host.createSession({
        key,
        cwd: root,
        binding,
        parent: { key: from.key, boundarySeq: await ended(from) },
      })
    }

    await expect(fork(role, 'role-fork')).rejects.toThrow(
      /a fork of a role session cannot add directories.*E_WORKSPACE_UNTRUSTED|E_WORKSPACE_UNTRUSTED.*a fork of a role session cannot add directories/s,
    )
    // An ordinary session still extends.
    const plain = await fork(parent, 'plain-fork')
    expect(plain.d.extraDirectories).toEqual([canonicalExtra])
  } finally {
    await fixture.host.close()
  }
}, 120_000)
