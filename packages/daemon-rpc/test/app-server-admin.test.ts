import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localPackageAdminAuthority } from '@agnes/daemon-admin/packages/index'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { createCredentialStore, createPlatform, resolveProfile } from '@agnes/host'
import { expect, it } from 'vitest'
import { createAppServerAdmin, registerAppServerAdmin } from '../src/local/methods/admin.js'

it('owns settings and plan writes behind local admin and registered-workspace authority', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-app-admin-'))
  const cwd = join(home, 'project')
  await mkdir(cwd)
  await mkdir(join(home, 'data'))
  await writeFile(join(cwd, 'AGENTS.md'), 'Project rules')
  const service = createAppServerAdmin({
    home,
    dataDir: join(home, 'data'),
    profileDir: join(home, 'profiles/local-dev'),
    resolveProfile: async () =>
      resolveProfile(
        { builtin: 'local-dev' },
        { platform: createPlatform().snapshot(), agnesVersion: '0.0.0', now: new Date().toISOString() },
      ),
    workspaces: async () => ({ items: [{ path: cwd, available: true }] }),
  })
  const endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  endpoint.conn.initialized = true
  registerAppServerAdmin(endpoint, service, localPackageAdminAuthority())
  let id = 0
  const call = (method: string, params: unknown) =>
    endpoint.handle({ jsonrpc: '2.0', id: ++id, method, params })
  try {
    expect(await call('_agnes/v1/admin.context', {})).toMatchObject({
      error: { code: -32006, data: { messageKey: 'appServer.errors.forbidden' } },
    })
    endpoint.conn.authKind = 'local'
    endpoint.conn.credentialKind = 'local'
    const credential = {
      provider: 'mcp-oauth',
      accessToken: 'fixture-token',
      expiresAt: 2000000000000,
      refreshToken: 'synthetic-refresh',
      scope: ['read'],
      grantId: 'synthetic-grant',
    }
    expect(await call('_agnes/v1/admin.mcp.oauth.save', { serverId: 'srv-1', credential })).toMatchObject({
      result: {},
    })
    expect(await createCredentialStore({ root: home }).read('secret://mcp-oauth/srv-1')).toMatchObject({
      kind: 'oauth',
      ...credential,
    })
    expect(await call('_agnes/v1/admin.mcp.oauth.save', { serverId: '../other', credential })).toMatchObject({
      error: { code: -32602, data: { messageKey: 'appServer.errors.invalidParams' } },
    })
    expect(await call('_agnes/v1/admin.context', { cwd: home, config: { timeZone: 'UTC' } })).toMatchObject({
      error: { code: -32006 },
    })
    expect(
      await call('_agnes/v1/admin.context', {
        cwd,
        config: { timeZone: 'Asia/Shanghai', customSkillRoots: [join(home, '技能')] },
      }),
    ).toMatchObject({
      result: { config: { timeZone: 'Asia/Shanghai' }, rules: { files: [{ content: 'Project rules' }] } },
    })
    expect(JSON.parse(await readFile(join(home, 'context.json'), 'utf8')).customSkillRoots).toEqual([
      join(home, '技能'),
    ])
    expect(await call('_agnes/v1/admin.plan', { cwd, line: '/plan look first' })).toMatchObject({
      result: { active: true, text: 'Plan mode is on: look first' },
    })
    expect(JSON.parse(await readFile(join(cwd, '.agh/plan-mode.json'), 'utf8'))).toMatchObject({
      active: true,
      instruction: 'look first',
    })
    expect(await call('_agnes/v1/admin.plan', { cwd, line: '/plan off' })).toMatchObject({
      result: { active: false },
    })
    for (const params of [
      { cwd: home, line: '/plan' },
      { cwd: 'relative', line: '/plan' },
      { cwd: join(home, 'missing'), line: '/plan' },
      { cwd, line: 'hello' },
    ])
      expect(await call('_agnes/v1/admin.plan', params)).toHaveProperty('error')
    expect(
      await call('_agnes/v1/admin.history.search', { query: '', title: '', workspace: '' }),
    ).toMatchObject({ result: { items: [], truncated: false } })
    endpoint.conn.authKind = 'jwt'
    expect(await call('_agnes/v1/admin.mcp.oauth.save', { serverId: 'srv-1', credential })).toHaveProperty(
      'error.data.code',
      'CAPABILITY_DENIED',
    )
    expect(
      await call('_agnes/v1/admin.history.search', { query: '', title: '', workspace: '' }),
    ).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
  } finally {
    await endpoint.close()
    await rm(home, { recursive: true, force: true })
  }
})
