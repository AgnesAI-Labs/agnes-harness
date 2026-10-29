import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCredentialAdmin } from '../src/credentials.js'

it.each(['full-access', 'workspace-write'])(
  'retains the credential administration confirmation boundary under %s',
  async (policy) => {
    const scratch = await mkdtemp(join(tmpdir(), 'agh-credential-permission-'))
    // The existing credential writer creates a fresh private home; it refuses broad pre-existing ACLs.
    const home = join(scratch, 'home')
    const actor = { id: 'owner', org: 'local', role: 'owner', deptPath: [], attrs: {} }
    try {
      const admin = createCredentialAdmin({
        home,
        dataDir: join(home, 'data'),
        configurations: async () => [],
        writableStore: async () => true,
      })
      const created = (await admin.call(
        'create',
        { label: 'Fixture', value: 'synthetic-test-value' },
        actor.id,
      )) as { id: string }
      const context = { sessionKey: 's', sessionId: 'backend', epoch: 0, policy, actor }
      const change = admin.call('delete', { id: created.id, force: true }, actor.id, {
        context,
        current: async () => context,
      })
      if (policy === 'full-access') {
        await expect(change).resolves.toEqual({})
        expect(await admin.call('list', {}, actor.id)).toEqual({ items: [] })
        const audit = (await readFile(join(home, 'data/audit/credentials.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(audit.at(-1).detail).toMatchObject({
          action: 'delete',
          reason: 'full-access',
          answeredBy: { role: 'system' },
        })
        expect(JSON.stringify(audit)).not.toContain('synthetic-test-value')
      } else {
        await expect(change).rejects.toMatchObject({
          data: { reason: 'CONFIG_CREDENTIAL_CONFIRMATION_REQUIRED' },
        })
        expect(await admin.call('list', {}, actor.id)).toMatchObject({ items: [{ id: created.id }] })
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  },
)
