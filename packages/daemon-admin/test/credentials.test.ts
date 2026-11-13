import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialStore } from '@agnes/host'
import { expect, it } from 'vitest'
import { authorizeCloudConnection } from '../src/cloud-authorization.js'
import { createCredentialAdmin } from '../src/credentials.js'

it('resolves managed cloud credentials privately, refuses rejected/missing credentials and sanitizes platform failures', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'agh-cloud-credential-'))
  const store = createCredentialStore({ root: join(scratch, 'home') })
  const id = 'secret://generic/11111111-1111-1111-1111-111111111111'
  const input = { origin: 'http://cloud.fixture:8443', credentialRef: id }
  const key = 'synthetic-cloud-key'
  const token = `zzzzzzzz.${'A'.repeat(22)}.${'B'.repeat(43)}`
  const expiresAt = Date.now() + 3_600_000
  try {
    await expect(authorizeCloudConnection(input, store)).rejects.toMatchObject({
      data: { reason: 'CONFIG_CREDENTIAL_NOT_FOUND' },
    })
    await store.putGeneric(id, key, { label: 'Cloud fixture', createdAt: new Date().toISOString() })
    const result = await authorizeCloudConnection(input, store, async (url, init) => {
      expect(String(url)).toBe('http://cloud.fixture:8443/_agnes/remote-frontend/auth')
      expect(JSON.parse(String(init?.body))).toEqual({ key })
      expect(init?.redirect).toBe('error')
      return Response.json({ token, expiresAt, key: 'must-not-be-projected' })
    })
    expect(result).toEqual({ token, expiresAt })
    expect(JSON.stringify(result)).not.toContain(key)
    await expect(
      authorizeCloudConnection(input, store, async () => new Response('', { status: 401 })),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_CREDENTIAL_REJECTED' } })
    await expect(
      authorizeCloudConnection(input, store, async () => {
        throw new Error(key)
      }),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
    await expect(
      authorizeCloudConnection({ ...input, origin: 'http://cloud.fixture/path' }, store),
    ).rejects.toMatchObject({ data: { reason: 'CONFIG_AUTH_UNAVAILABLE' } })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

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
