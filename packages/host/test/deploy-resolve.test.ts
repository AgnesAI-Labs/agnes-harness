import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { satisfiesApiRange } from '@agnes/extension-api'
import {
  createPackageManager,
  emptyLock,
  type InstalledInventory,
  parseSource,
  writeLock,
} from '@agnes/package-manager'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveDeployment } from '../src/deploy/index.js'
import { rangeNarrows } from '../src/deploy/ranges.js'
import { pluginRowSource } from '../src/ext-host/row-extension-host.js'

const id = 'acme/dashboard',
  rowId = 'ext:acme/backend',
  ext = pluginRowSource(rowId)
const plugins = [{ id: rowId, export: 'main', services: ['data.read', 'other.read'] }]
const grant = { extension: ext, name: 'data.read', range: '^1.0' }
const instance = {
  package: id,
  surfaceId: 'dashboard',
  mount: '/dashboard',
  sourceId: 'customer',
  config: { title: 'Public' },
  secrets: { key: 'secret://acme/key' },
  grants: [grant],
}
const descriptor = {
  id: 'dashboard',
  apiRange: '^1.0',
  artifact: { kind: 'node', entry: './dist/server.js' },
  healthPath: '/health',
  requires: { services: [grant] },
}
const policy = { harnessVersion: '0.1.0', surfaceApiVersion: '1.0.0', grants: { customer: [grant] } }
const manifest = {
  id: 'customer',
  version: '1.0.0',
  harnessRange: '^0.1',
  extensions: [],
  profileFragment: 'profile/main.yaml',
  presets: [],
  fixtures: 'fixtures/data',
  surfaces: ['surfaces/main.json'],
}
let root: string, source: string, deploy: string, profile: string, inventory: InstalledInventory
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value))
function manager() {
  return createPackageManager({ dataDir: root, cwd: root, agnesVersion: '0.1.0', references: async () => [] })
}
async function install() {
  const m = manager(),
    spec = parseSource('file:./source'),
    preview = await m.inspect(profile, spec)
  await m.install(profile, spec, { expectedIntegrity: preview.integrity })
  const row = (await m.inventory(profile)).packages[0]
  if (!row) throw Error('missing')
  await m.trust(profile, id, { integrity: row.entry.integrity, capabilityHash: row.capabilityHash })
  await m.enable(profile, id, true)
  return m.inventory(profile)
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'agnes-fde-'))
  source = join(root, 'source')
  deploy = join(root, 'deploy')
  profile = join(root, 'profiles/local-dev')
  mkdirSync(join(source, 'dist'), { recursive: true })
  mkdirSync(join(deploy, 'surfaces'), { recursive: true })
  mkdirSync(profile, { recursive: true })
  save(join(source, 'package.json'), {
    name: id,
    version: '1.2.3',
    license: 'MIT',
    agnes: { plugins, surfaces: [descriptor] },
  })
  writeFileSync(join(source, 'index.mjs'), 'export function main() {}')
  writeFileSync(join(source, 'dist/server.js'), 'throw Error("must not start")')
  save(join(deploy, 'manifest.json'), manifest)
  save(join(deploy, 'surfaces/main.json'), instance)
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
    policySnapshot: { capabilityCeiling: ['services'], workspacePackages: 'require-project-trust' },
  })
  inventory = await install()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
it('resolves actual installed bytes with bundled Extension version and only secret references', () => {
  const result = resolveDeployment(inventory, deploy, policy)
  expect(result.surfaces[0]).toMatchObject({
    version: '1.2.3',
    services: [{ extension: ext, version: '1.2.3', package: id }],
  })
  expect(JSON.stringify(result)).not.toContain(root)
  expect(JSON.stringify(result)).toContain('secret://acme/key')
  expect(Object.isFrozen(result.surfaces[0]?.instance.secrets)).toBe(true)
  expect(Object.isFrozen(policy)).toBe(false)
  expect(result.hash).toBe(resolveDeployment(inventory, deploy, policy).hash)
})
it('is location independent and canonical for object key order', () => {
  const a = resolveDeployment(inventory, deploy, policy),
    moved = join(root, 'moved')
  cpSync(deploy, moved, { recursive: true })
  save(join(moved, 'surfaces/main.json'), Object.fromEntries(Object.entries(instance).reverse()))
  expect(resolveDeployment(inventory, moved, policy)).toEqual(a)
})
it('changes hashes for config and policy changes, without mutating caller snapshots', () => {
  const a = resolveDeployment(inventory, deploy, policy)
  save(join(deploy, 'surfaces/main.json'), { ...instance, config: { title: 'Changed' } })
  expect(resolveDeployment(inventory, deploy, policy).hash).not.toBe(a.hash)
  save(join(deploy, 'surfaces/main.json'), instance)
  expect(
    resolveDeployment(inventory, deploy, { ...policy, grants: { customer: [{ ...grant, range: '*' }] } })
      .policyHash,
  ).not.toBe(a.policyHash)
})
it.each(['disabled', 'untrusted'] as const)('rejects actual %s inventory', async (mode) => {
  const m = manager()
  if (mode === 'disabled') await m.enable(profile, id, false)
  else {
    const spec = parseSource('file:./source'),
      p = await m.inspect(profile, spec)
    await m.update(profile, id, spec, { expectedIntegrity: p.integrity })
  }
  const next = await m.inventory(profile)
  expect(() => resolveDeployment(next, deploy, policy)).toThrow('not installed trusted and enabled')
})
it.each(['grant', 'policy', 'missing-policy', 'missing-service', 'range', 'api', 'harness'] as const)(
  'rejects %s incompatibility',
  (mode) => {
    let p = policy
    if (mode === 'grant')
      save(join(deploy, 'surfaces/main.json'), { ...instance, grants: [{ ...grant, range: '*' }] })
    if (mode === 'policy') p = { ...policy, grants: { customer: [{ ...grant, range: '1.2.3' }] } }
    if (mode === 'missing-policy') p = { ...policy, grants: {} as typeof policy.grants }
    if (mode === 'missing-service')
      save(join(deploy, 'surfaces/main.json'), { ...instance, grants: [{ ...grant, name: 'other.read' }] })
    if (mode === 'range')
      save(join(deploy, 'surfaces/main.json'), { ...instance, grants: [{ ...grant, range: '1.9.0' }] })
    if (mode === 'api') p = { ...policy, surfaceApiVersion: '2.0.0' }
    if (mode === 'harness') p = { ...policy, harnessVersion: '1.0.0' }
    expect(() => resolveDeployment(inventory, deploy, p)).toThrow()
  },
)
it.each(['mount', 'nested-mount', 'source'] as const)(
  'rejects duplicate %s and accepts distinct explicit routes',
  (mode) => {
    save(join(deploy, 'manifest.json'), {
      ...manifest,
      surfaces: ['surfaces/main.json', 'surfaces/second.json'],
    })
    save(join(deploy, 'surfaces/second.json'), {
      ...instance,
      mount: mode === 'mount' ? instance.mount : mode === 'nested-mount' ? '/dashboard/child' : '/second',
      sourceId: mode === 'source' ? instance.sourceId : 'second',
    })
    expect(() =>
      resolveDeployment(inventory, deploy, { ...policy, grants: { ...policy.grants, second: [grant] } }),
    ).toThrow('duplicated or overlaps')
  },
)
it('sorts independent instance declaration order deterministically', () => {
  const p = { ...policy, grants: { ...policy.grants, second: [grant] } }
  save(join(deploy, 'surfaces/second.json'), { ...instance, mount: '/second', sourceId: 'second' })
  save(join(deploy, 'manifest.json'), {
    ...manifest,
    surfaces: ['surfaces/main.json', 'surfaces/second.json'],
  })
  const first = resolveDeployment(inventory, deploy, p)
  save(join(deploy, 'manifest.json'), {
    ...manifest,
    surfaces: ['surfaces/second.json', 'surfaces/main.json'],
  })
  expect(resolveDeployment(inventory, deploy, p)).toEqual(first)
})
it('detects changed bytes after the inventory snapshot', () => {
  const dir = inventory.packages[0]?.directory
  if (!dir) throw Error('missing')
  writeFileSync(join(dir, 'index.mjs'), 'throw Error("changed after install")')
  expect(() => resolveDeployment(inventory, deploy, policy)).toThrow('bytes differ')
})
it('rejects forged inventory flags/hash and traversal/symlink input', () => {
  expect(() => resolveDeployment({ ...inventory, hash: 'bad' }, deploy, policy)).toThrow('snapshot hash')
  save(join(deploy, 'manifest.json'), { ...manifest, surfaces: ['surfaces/../../other.json'] })
  expect(() => resolveDeployment(inventory, deploy, policy)).toThrow()
  save(join(deploy, 'manifest.json'), manifest)
  rmSync(join(deploy, 'surfaces/main.json'))
  symlinkSync(join(root, 'other.json'), join(deploy, 'surfaces/main.json'))
  save(join(root, 'other.json'), instance)
  expect(() => resolveDeployment(inventory, deploy, policy)).toThrow()
})
it('allows only range subsets, independently checked against existing range membership', () => {
  const ranges = [
    '*',
    '1.x',
    '1.2.x',
    '^1.0',
    '~1.2.3',
    '>=1.2.3 <2.0.0',
    '1.2.3',
    '^0.0',
    '^0.0.1',
    '^0.1.0',
    '>1.2.3',
    '<=1.2.3',
  ]
  const versions = [
    '0.0.0',
    '0.0.1',
    '0.0.2',
    '0.1.0',
    '0.2.0',
    '1.0.0',
    '1.2.2',
    '1.2.3',
    '1.2.4',
    '1.3.0',
    '1.999.0',
    '2.0.0',
    '3.0.0',
  ]
  for (const requested of ranges)
    for (const ceiling of ranges)
      if (rangeNarrows(requested, ceiling))
        for (const version of versions)
          if (satisfiesApiRange(requested, version))
            expect(satisfiesApiRange(ceiling, version), `${requested} <= ${ceiling} at ${version}`).toBe(true)
  expect(rangeNarrows('1.2.3', '^1.0')).toBe(true)
  expect(rangeNarrows('*', '^1.0')).toBe(false)
  expect(rangeNarrows('^0.0', '^0.0.0')).toBe(false)
  expect(() => rangeNarrows('>1.2.3 <1.2.4', '*')).toThrow()
})
it.each(['', 'garbage', '1.2.3-alpha', '>=2.0.0 <1.0.0', '9007199254740992.x'])(
  'rejects invalid or empty range %s',
  (range) => {
    expect(() => rangeNarrows(range, '*')).toThrow()
  },
)
it.each(['missing', 'version'] as const)(
  'checks all required Service declarations for %s mismatch',
  async (mode) => {
    await manager().remove(profile, id)
    const requirement = mode === 'missing' ? { ...grant, name: 'missing.read' } : { ...grant, range: '^2.0' }
    save(join(source, 'package.json'), {
      name: id,
      version: '1.2.3',
      license: 'MIT',
      agnes: {
        plugins,
        surfaces: [{ ...descriptor, requires: { services: [requirement] } }],
      },
    })
    inventory = await install()
    save(join(deploy, 'surfaces/main.json'), { ...instance, grants: [] })
    expect(() => resolveDeployment(inventory, deploy, policy)).toThrow(
      'service is unavailable or incompatible',
    )
  },
)
it('resolves immutable OCI digest without pulling or starting it and permits grant removal', async () => {
  await manager().remove(profile, id)
  const artifact = { kind: 'oci', image: `registry.example/acme/dashboard@sha256:${'a'.repeat(64)}` }
  save(join(source, 'package.json'), {
    name: id,
    version: '1.2.3',
    license: 'MIT',
    agnes: { plugins, surfaces: [{ ...descriptor, artifact }] },
  })
  inventory = await install()
  save(join(deploy, 'surfaces/main.json'), { ...instance, grants: [] })
  expect(
    resolveDeployment(inventory, deploy, { ...policy, grants: { customer: [] } }).surfaces[0]?.descriptor
      .artifact,
  ).toEqual(artifact)
})
it('canonicalizes grant ordering across deployment and managed policy snapshots', async () => {
  await manager().remove(profile, id)
  const second = { ...grant, name: 'other.read' },
    both = [grant, second]
  save(join(source, 'package.json'), {
    name: id,
    version: '1.2.3',
    license: 'MIT',
    agnes: { plugins, surfaces: [{ ...descriptor, requires: { services: both } }] },
  })
  inventory = await install()
  save(join(deploy, 'surfaces/main.json'), { ...instance, grants: both })
  const first = resolveDeployment(inventory, deploy, { ...policy, grants: { customer: both } })
  save(join(deploy, 'surfaces/main.json'), { ...instance, grants: [...both].reverse() })
  expect(
    resolveDeployment(inventory, deploy, { ...policy, grants: { customer: [...both].reverse() } }),
  ).toEqual(first)
})
