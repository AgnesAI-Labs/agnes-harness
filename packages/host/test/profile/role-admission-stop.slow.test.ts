import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { roleHuman, setupRoleEscalation } from './role-escalation-fixture.js'

it.each(
  (['close', 'abort'] as const).flatMap((action) =>
    (['ready', 'deferred', 'nested'] as const).map((stage) => ({ action, stage })),
  ),
)(
  'persists parent $action for $stage admissions and only admits fresh role work',
  async ({ action, stage }) => {
    const questions: string[] = []
    const fixture = await setupRoleEscalation(
      async (request) => {
        questions.push(request.decision!.handle.sessionId!)
        return { verdict: 'allowed-once', answeredBy: roleHuman }
      },
      {
        nested: stage === 'nested',
        calls: (_key, step) =>
          step ? [] : [{ name: 'write', args: { path: 'fresh.md', content: 'Fresh admission' } }],
      },
    )
    const parent = fixture.parent
    const accept = async () => {
      await parent.enqueue('next-turn', {
        actor: parent.d.actor,
        trust: 'untrusted',
        content: [{ type: 'text', text: 'Delegate' }],
      })
      await parent.acceptInput()
    }
    const create = () =>
      parent.d.children.createWithKind!('spawn', {
        parent: parent.key,
        cwd: fixture.workspaceRoot,
        role: fixture.refs[0],
        input: 'Write fresh requirements',
        resident: true,
        ...(stage === 'deferred' ? { start: false } : {}),
      })
    try {
      await accept()
      const old = await create()
      const keys = [old.key]
      if (stage === 'nested') {
        const middle = fixture.host.kernel.get(old.key)!
        const grandchild = await middle.d.children.createWithKind!('spawn', {
          parent: middle.key,
          cwd: fixture.workspaceRoot,
          role: fixture.refs[1]!,
          input: 'Grandchild task',
          resident: true,
        })
        keys.push(grandchild.key)
      }
      if (action === 'close') await parent.close()
      else await parent.abort(parent.d.actor)
      for (const key of keys) {
        expect((await parent.d.log.storage.lookupByKey(key))?.state).toBe('cancelled')
        await expect(parent.d.children.resume!(key)).rejects.toBeDefined()
      }
      expect(questions).toEqual([])
      expect(existsSync(join(fixture.workspaceRoot, 'fresh.md'))).toBe(false)
      if (action === 'abort') {
        await parent.run({ until: 'turn-end', signal: AbortSignal.timeout(15000) })
        await accept()
        const fresh = await create()
        expect(fresh.key).not.toBe(old.key)
        await fresh.run('Write fresh requirements')
        expect(questions).toEqual([fresh.key])
        expect(readFileSync(join(fixture.workspaceRoot, 'fresh.md'), 'utf8')).toBe('Fresh admission')
      }
    } finally {
      await fixture.host.close()
    }
  },
  30000,
)
