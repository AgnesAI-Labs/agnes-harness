import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPackageManager, emptyLock, writeLock } from '@agnes/package-manager'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { createPackageAdminService, FilePackageOperationStore } from '../src/packages/index.js'
import { pluginProposalSourceAdapter } from '../src/packages/plugin-source.js'
import { checkedPluginFiles } from '../src/supervisor/plugin-files.js'
import { createPluginManageRequests } from '../src/supervisor/plugin-manage-requests.js'

const roots: string[] = []
const endpoints: LocalEndpoint[] = []
afterEach(async () => {
  for (const ep of endpoints.splice(0)) await ep.close()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const source = `export const main = { inject: ['extension'], apply(ctx) {} }`
const files = [
  {
    path: 'package.json',
    content: JSON.stringify({
      name: 'test-plugin',
      version: '0.1.0',
      type: 'module',
      exports: './index.mjs',
      license: 'Apache-2.0',
      agnes: { plugins: [{ id: 'ext:test-plugin/main', export: 'main', inject: ['extension'] }] },
    }),
  },
  { path: 'index.mjs', content: source },
] as const
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agh-plugin-helper-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  writeLock(profileDir, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      [
        'approval',
        'checkpoint',
        'ledger',
        'sandbox',
        'verifier',
        'repair',
        'artifacts',
        'principals',
        'platform',
        'harness',
      ].map((s) => [s, '@agnes/base']),
    ),
    policySnapshot: { capabilityCeiling: ['tools', 'ui'], workspacePackages: 'require-project-trust' },
  })
  const exec = vi.fn(async () => {
    throw new Error('No network')
  })
  const manager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    sourceAdapters: [pluginProposalSourceAdapter(root)],
    exec,
    references: async () => [],
  })
  const installedIntegrity = async () => {
    const pkg = (await manager.inventory(profileDir)).packages[0]
    if (!pkg) throw new Error('Missing fixture package')
    return pkg.entry.integrity
  }
  let running = false
  const admin = createPackageAdminService({
    manager,
    profileDirectory: async () => profileDir,
    operations: new FilePackageOperationStore(join(root, 'ops')),
    clock: () => new Date().toISOString(),
    activation: {
      actual: async () =>
        running
          ? {
              actual: 'running',
              actualIntegrity: await installedIntegrity(),
            }
          : { actual: 'not-running' },
      reconcile: async () => {
        running = true
        return {
          actual: 'running',
          actualIntegrity: await installedIntegrity(),
        }
      },
    },
  })
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
  endpoints.push(ep)
  Object.assign(ep.conn, { authKind: 'local', credentialKind: 'local', clientId: 'client' })
  ep.conn.capabilities.permission = true
  ep.conn.attached.set('session', {} as never)
  const ask = vi
    .spyOn(ep, 'request')
    .mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
  const options = {
    directory: root,
    profile: 'local-dev',
    service: () => admin,
    current: () => ep.conn,
    endpoint: () => ep,
    owner: () => ({ principalId: 'local', active: true }),
  }
  let handler = createPluginManageRequests(options)
  const request = (input: unknown, overrides = {}, requestId: string = randomUUID()) =>
    handler('session', requestId, 'plugin-manage', {
      input,
      packageId: '@agnes/plugin-helper',
      snapshotId: 'snap',
      rowId: 'ext:plugin-helper/main',
      sessionKey: 'session',
      toolUseId: 'tool',
      leaseId: 'lease',
      ...overrides,
    }) as Promise<{ proposalId: string; state: string; installed: boolean; actual: string }>
  return {
    root,
    profileDir,
    manager,
    admin,
    ep,
    ask,
    exec,
    request,
    restart: () => {
      handler = createPluginManageRequests(options)
    },
    abort: (id: string) => handler('session', 'abort', 'plugin-manage-abort', { requestId: id }),
  }
}
it('inspects real files, approves exact content, installs and enables through PackageAdmin, and recovers status without replay', async () => {
  const s = await setup()
  const p = await s.request({ action: 'prepare', files })
  expect(p.state).toBe('prepared')
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
  expect(s.ask).not.toHaveBeenCalled()
  const submitted = await s.request({ action: 'commit', proposalId: p.proposalId })
  expect(['submitted', 'ready']).toContain(submitted.state)
  await vi.waitFor(async () =>
    expect((await s.request({ action: 'status', proposalId: p.proposalId })).state).toBe('ready'),
  )
  expect(s.ask).toHaveBeenCalledOnce()
  expect(JSON.stringify(s.ask.mock.calls)).toContain('sha256-')
  s.restart()
  expect((await s.request({ action: 'commit', proposalId: p.proposalId })).state).toBe('ready')
  expect(s.ask).toHaveBeenCalledOnce()
  expect(s.exec).not.toHaveBeenCalled()
  await expect(s.request({ action: 'prepare', files })).rejects.toMatchObject({
    data: { code: 'PLUGIN_PACKAGE_EXISTS' },
  })
})
it('does not install on native rejection, and does not replay a prepared proposal after restart', async () => {
  const s = await setup()
  const p = await s.request({ action: 'prepare', files })
  s.ask.mockResolvedValueOnce({ outcome: { outcome: 'selected', optionId: 'deny' } })
  expect((await s.request({ action: 'commit', proposalId: p.proposalId })).state).toBe('cancelled')
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
  const p2 = await s.request({ action: 'prepare', files })
  s.restart()
  await expect(s.request({ action: 'commit', proposalId: p2.proposalId })).rejects.toMatchObject({
    data: { code: 'PLUGIN_PROPOSAL_EXPIRED' },
  })
})
it('binds authority to the local owner, session and live connection', async () => {
  const s = await setup()
  await expect(s.request({ action: 'prepare', files }, { sessionKey: 'other' })).rejects.toMatchObject({
    code: -32602,
  })
  s.ep.conn.capabilities.permission = false
  await expect(s.request({ action: 'prepare', files })).rejects.toMatchObject({
    data: { code: 'PLUGIN_PERMISSION_REQUIRED' },
  })
  expect(s.ask).not.toHaveBeenCalled()
})
it('rejects source changes after preview and never trusts changed bytes', async () => {
  const s = await setup()
  const p = await s.request({ action: 'prepare', files })
  writeFileSync(
    join(s.root, 'plugin-onboarding', 'sources', p.proposalId, 'index.mjs'),
    `${source}\n// changed`,
  )
  await expect(s.request({ action: 'commit', proposalId: p.proposalId })).rejects.toMatchObject({
    data: { code: 'PLUGIN_PACKAGE_OPERATION_FAILED' },
  })
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
})
it('aborting the native prompt admits no installation', async () => {
  const s = await setup()
  const p = await s.request({ action: 'prepare', files })
  s.ask.mockImplementationOnce(
    (_m, _p, opts) =>
      new Promise((_resolve, reject) =>
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
  )
  const job = s.request({ action: 'commit', proposalId: p.proposalId }, {}, 'cancel-me').catch((e) => e)
  await vi.waitFor(() => expect(s.ask).toHaveBeenCalledOnce())
  await s.abort('cancel-me')
  await job
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
})
it.each([
  '../escape.mjs',
  '/tmp/escape.mjs',
  'src/../escape.mjs',
  'node_modules/x.mjs',
  'CON.mjs',
  'a\\b.mjs',
])('rejects unsafe file path %s before staging', (path) => {
  expect(() => checkedPluginFiles([...files, { path, content: '' }])).toThrow('PLUGIN_FILES_INVALID')
})
it('rejects aliases, file-directory conflicts, bounds and lifecycle/dependency declarations', () => {
  for (const extra of [
    [{ path: 'INDEX.mjs', content: '' }],
    [{ path: 'index.mjs/a.mjs', content: '' }],
    [{ path: 'large.mjs', content: 'a'.repeat(256 * 1024 + 1) }],
  ])
    expect(() => checkedPluginFiles([...files, ...extra])).toThrow()
  for (const key of ['scripts', 'dependencies', 'optionalDependencies', 'bin']) {
    const pkg = JSON.parse(files[0].content)
    pkg[key] = {}
    expect(() =>
      checkedPluginFiles([{ path: 'package.json', content: JSON.stringify(pkg) }, files[1]]),
    ).toThrow()
  }
  expect(() =>
    checkedPluginFiles([
      ...files,
      ...Array.from({ length: 31 }, (_, i) => ({ path: `f${i}.md`, content: '' })),
    ]),
  ).toThrow()
})

it('cancels an in-flight approval through the proposal and does not continue installation', async () => {
  const s = await setup()
  const p = await s.request({ action: 'prepare', files })
  s.ask.mockImplementationOnce(
    (_m, _p, opts) =>
      new Promise((_resolve, reject) =>
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
  )
  const pending = s.request({ action: 'commit', proposalId: p.proposalId }).catch((e) => e)
  await vi.waitFor(() => expect(s.ask).toHaveBeenCalledOnce())
  expect((await s.request({ action: 'cancel', proposalId: p.proposalId })).state).toBe('cancelling')
  await pending
  expect((await s.request({ action: 'status', proposalId: p.proposalId })).state).toBe('cancelled')
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
})
it('preserves an admitted installation after trust failure but never replays the remaining pipeline', async () => {
  const s = await setup()
  const p = await s.request({ action: 'prepare', files })
  const trust = vi.spyOn(s.manager, 'trust').mockRejectedValue(new Error('fixture trust failure'))
  await expect(s.request({ action: 'commit', proposalId: p.proposalId })).rejects.toMatchObject({
    data: { code: 'PLUGIN_PACKAGE_OPERATION_FAILED' },
  })
  s.restart()
  expect(await s.request({ action: 'commit', proposalId: p.proposalId })).toMatchObject({
    state: 'failed',
    installed: true,
  })
  expect(trust).toHaveBeenCalledOnce()
  expect(s.ask).toHaveBeenCalledOnce()
  expect((await s.manager.inventory(s.profileDir)).packages[0]?.entry.state).toMatchObject({
    enabled: false,
    trusted: null,
  })
})
it.each(['tool', 'skill'])('the shipped %s template passes real package inspection', async (kind) => {
  const module = await import(
    new URL('../../package-manager/bundled-plugins/plugin-helper/index.mjs', import.meta.url).href
  )
  const tools: { name: string; execute(args: unknown): Promise<{ content: { text: string }[] }> }[] = []
  module.pluginHelper.apply({
    extension: () => ({ registerTool: (tool: (typeof tools)[number]) => tools.push(tool) }),
  })
  const guide = tools.find((t) => t.name === 'plugin_helper_guide')
  if (!guide) throw new Error('guide missing')
  const generated = JSON.parse((await guide.execute({ kind })).content[0]?.text ?? '{}')
  const s = await setup()
  expect((await s.request({ action: 'prepare', files: generated.files })).state).toBe('prepared')
})

it('accepts and installs the bundled pure skin template, rejecting arbitrary client contributions', async () => {
  const templatePath = '../../package-manager/bundled-plugins/plugin-helper/src/skin.mjs'
  const { skinFiles } = await import(templatePath)
  const skin: { path: string; content: string }[] = skinFiles()
  expect(checkedPluginFiles(skin)).toEqual(skin)
  const s = await setup()
  const p = await s.request({ action: 'prepare', files: skin }).catch((e) => {
    throw new Error(JSON.stringify(e))
  })
  expect(p.state).toBe('prepared')
  await s.request({ action: 'commit', proposalId: p.proposalId })
  await vi.waitFor(async () =>
    expect((await s.request({ action: 'status', proposalId: p.proposalId })).state).toBe('ready'),
  )
  for (const content of [JSON.stringify({ skins: [], panels: [] }), JSON.stringify({ panels: [{}] })]) {
    const bad = skin.map((f) => (f.path === 'extensions/main/agnes.client.json' ? { ...f, content } : f))
    expect(() => checkedPluginFiles(bad)).toThrow('PLUGIN_FILES_INVALID')
  }
  const badPath = skin.map((f) =>
    f.path === 'package.json'
      ? { ...f, content: f.content.replace('./extensions/main/agnes.client.json', '../agnes.client.json') }
      : f,
  )
  expect(() => checkedPluginFiles(badPath)).toThrow('PLUGIN_FILES_INVALID')
})
