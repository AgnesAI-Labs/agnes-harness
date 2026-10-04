import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkToolDef, type ToolDef } from '@agnes/extension-api'
import { validateAgainst } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { BUNDLED_SKILL_HELPER_REF, bundledPluginSourceRoot } from '../src/bundled-plugin-source.js'
import { emptyLock, readLock, writeLock } from '../src/lockfile.js'
import { createPackageManager } from '../src/manager.js'
import { fetchSource, hashDirectory, parseSource } from '../src/sources.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-bundled-helper-'))
  roots.push(root)
  return root
}
const managementTools = new Map<string, ToolDef>()
for (const [directory, exported] of [
  ['mcp-helper', 'mcpHelper'],
  ['skill-helper', 'skillHelper'],
  ['plugin-helper', 'pluginHelper'],
] as const) {
  const module = (await import(
    new URL(`../bundled-plugins/${directory}/index.mjs`, import.meta.url).href
  )) as Record<string, { apply(ctx: { extension(): { registerTool(tool: ToolDef): void } }): void }>
  const plugin = module[exported]
  if (!plugin) throw new Error(`Missing helper export: ${exported}`)
  plugin.apply({
    extension: () => ({ registerTool: (tool) => managementTools.set(tool.name, tool) }),
  })
}
function managementTool(name: string): ToolDef {
  const tool = managementTools.get(name)
  if (!tool) throw new Error(`Missing management tool: ${name}`)
  return tool
}
const definition = {
  serverId: 'test-server',
  displayName: 'Test server',
  transport: { kind: 'stdio', executable: 'node', args: [] },
  secretBinding: { kind: 'none' },
}
type ManagementCase = [action: string, fields: Record<string, unknown>, valid: boolean]
const mcpCases: ManagementCase[] = [
  ['prepare', { definition }, true],
  ['prepare', {}, false],
  ['prepare', { definition: null }, false],
  [
    'prepare',
    { definition: { ...definition, transport: { kind: 'http', url: 'https://example.test' } } },
    true,
  ],
  [
    'prepare',
    { definition: { ...definition, transport: { kind: 'sse', url: 'https://example.test' } } },
    true,
  ],
  ['prepare', { definition: { ...definition, transport: { kind: 'stdio', executable: 'node' } } }, false],
  ['prepare', { definition, proposalId: 'existing-optional-field' }, true],
  ...['commit', 'status', 'cancel'].flatMap((action): ManagementCase[] => [
    [action, { proposalId: 'proposal' }, true],
    [action, {}, false],
    [action, { proposalId: '' }, false],
    [action, { proposalId: 'proposal', definition }, true],
  ]),
  ['list', {}, true],
  ['list', { definition, proposalId: 'existing-optional-field' }, true],
  ['list', { unexpected: true }, false],
  ['unknown', {}, false],
]
it.each(mcpCases)('validates mcp_manage %s with %j: %s', (action, fields, valid) => {
  const tool = managementTool('mcp_manage')
  expect(checkToolDef(tool)).toEqual({ ok: true })
  expect(tool.parameters.type).toBe('object')
  expect(validateAgainst(tool.parameters, { action, ...fields }).ok).toBe(valid)
})
it.each(['skill_helper_install', 'plugin_helper_install'])(
  '%s requires a known action and proposal',
  (name) => {
    const tool = managementTool(name)
    expect(checkToolDef(tool)).toEqual({ ok: true })
    for (const action of ['commit', 'status', 'cancel']) {
      expect(validateAgainst(tool.parameters, { action, proposalId: 'proposal' }).ok).toBe(true)
      for (const input of [
        { action },
        { action, proposalId: '' },
        { action, proposalId: 'proposal', extra: true },
      ])
        expect(validateAgainst(tool.parameters, input).ok).toBe(false)
    }
    expect(validateAgainst(tool.parameters, { action: 'prepare', proposalId: 'proposal' }).ok).toBe(false)
  },
)
it('uses runtime payload instead of workspace impostor and never runs network commands', async () => {
  const cwd = fixture()
  const impostor = join(cwd, 'bundled-plugins', 'skill-helper')
  mkdirSync(impostor, { recursive: true })
  writeFileSync(join(impostor, 'package.json'), JSON.stringify({ name: 'impostor', version: '9.9.9' }))
  const exec = vi.fn(async () => {
    throw new Error('Network/command forbidden')
  })
  const into = join(cwd, 'stage')
  const fetched = await fetchSource(parseSource(BUNDLED_SKILL_HELPER_REF), into, { cwd, exec })
  expect(JSON.parse(readFileSync(join(into, 'package.json'), 'utf8')).name).toBe('@agnes/skill-helper')
  expect(fetched.integrity).toBe(
    hashDirectory(
      join(bundledPluginSourceRoot(BUNDLED_SKILL_HELPER_REF) ?? '', 'bundled-plugins', 'skill-helper'),
    ),
  )
  expect(exec).not.toHaveBeenCalled()
  expect(bundledPluginSourceRoot('file:./ordinary')).toBeUndefined()
  expect(existsSync(join(into, 'src', 'sources.mjs'))).toBe(true)
})
it('inspects and installs offline without automatic trust or activation', async () => {
  const root = fixture(),
    profile = join(root, 'profiles', 'local-dev')
  mkdirSync(profile, { recursive: true })
  writeLock(profile, {
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
      ].map((name) => [name, '@agnes/base']),
    ),
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
  const exec = vi.fn(async () => {
    throw new Error('Network forbidden')
  })
  const manager = createPackageManager({ dataDir: root, cwd: root, agnesVersion: '0.1.0', exec })
  const preview = await manager.inspect(profile, parseSource(BUNDLED_SKILL_HELPER_REF))
  expect(preview).toMatchObject({ id: '@agnes/skill-helper', blockers: [] })
  const installed = await manager.add(profile, BUNDLED_SKILL_HELPER_REF)
  expect(installed.state).toMatchObject({ trusted: null, enabled: false })
  expect(
    readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages['@agnes/skill-helper'],
  ).toBeDefined()
  expect(exec).not.toHaveBeenCalled()
})
