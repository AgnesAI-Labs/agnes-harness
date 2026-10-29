import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import Module from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTemplate } from '@agnes/host-common/profile/templates'
import {
  BUNDLED_EXAMPLES,
  createPackageManager,
  DEFAULT_ENABLED_BUNDLED_PACKAGES,
  emptyLock,
  parseSource,
  runtimePluginSnapshotsFromInventory,
  writeLock,
} from '@agnes/package-manager'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { loadRuntimePackage, preflightRuntimePackage } from '../../src/assemble/packages.js'
import { createLoader } from '../../src/ext-host/loader.js'

const examples = fileURLToPath(new URL('../../../../examples/', import.meta.url))
const manifest = (path: string) => JSON.parse(readFileSync(join(examples, path, 'package.json'), 'utf8'))
// The catalog's shipped examples, as a person starts them from the business agents page or market.
// Examples written in TypeScript ship their build output, which a source checkout does not have.
const shipped = BUNDLED_EXAMPLES.map((example) => `${example.family}/${example.name}`).filter((path) => {
  const pkg = manifest(path)
  const entry =
    typeof pkg.exports === 'string' ? pkg.exports : (pkg.exports?.['.'] ?? pkg.main ?? './index.js')
  return typeof entry === 'string' && existsSync(join(examples, path, entry))
})
let root: string, profile: string
const nodePath = process.env.NODE_PATH
/** Node's global lookup paths are computed from NODE_PATH; recompute them after changing it. */
const initPaths = () => (Module as unknown as { _initPaths(): void })._initPaths()

beforeAll(() => {
  // pnpm runs tests with NODE_PATH naming its hoisted store, which a daemon started with plain
  // node does not have; without this a module the package never ships would still resolve here.
  delete process.env.NODE_PATH
  initPaths()
  // Outside the repository, as on a fresh AGH home: an installed tree resolves only its own files
  // and the modules AGH provides, never this checkout's node_modules.
  root = mkdtempSync(join(tmpdir(), 'agnes-examples-clean-'))
  profile = join(root, 'profiles/local-dev')
  mkdirSync(profile, { recursive: true })
  // The state a daemon's first start leaves: a resolved profile with no packages installed.
  writeLock(profile, {
    ...emptyLock('local-dev', '0.1.0'),
    policySnapshot: {
      capabilityCeiling: loadTemplate('local-dev').policy?.capabilityCeiling ?? [],
      workspacePackages: 'require-project-trust',
    },
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(
      ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((seam) => [
        seam,
        { provider: 'local' },
      ]),
    ),
  })
})
afterAll(() => {
  if (nodePath !== undefined) process.env.NODE_PATH = nodePath
  initPaths()
  rmSync(root, { recursive: true, force: true })
})

it('lists the curated business agents independently of local TypeScript build outputs', () => {
  expect(
    BUNDLED_EXAMPLES.filter((example) => example.family === 'fde')
      .map((example) => `${example.family}/${example.name}`)
      .sort(),
  ).toEqual([
    'fde/data-report',
    'fde/finance-reconcile',
    'fde/knowledge-qa',
    'fde/ops-runbook',
    'fde/support-triage',
  ])
})

it.each(shipped)('installs, trusts, enables and loads %s from a clean home', async (path) => {
  const m = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.0.0',
    references: async () => [],
  })
  const directory = join(examples, path)
  const id = String(manifest(path).name)
  const spec = parseSource(`file:${directory.split(sep).join('/')}`)
  const parentId = manifest(path).agnes?.metadata?.exampleOf
  if (parentId && !(await m.inventory(profile)).packages.some((pkg) => pkg.id === parentId)) {
    expect((await m.inspect(profile, spec)).blockers).toEqual([
      { code: 'dependency', references: ['example-parent-unavailable', parentId] },
    ])
    const parent = DEFAULT_ENABLED_BUNDLED_PACKAGES.find((pkg) => pkg.id === parentId)
    if (!parent) throw new Error(`${parentId} has no release payload`)
    const parentSpec = parseSource(parent.ref)
    const parentPreview = await m.inspect(profile, parentSpec)
    expect(parentPreview.blockers).toEqual([])
    if (!parentPreview.capabilityHash) throw new Error(`${parentId} has no capability hash`)
    await m.install(profile, parentSpec, { expectedIntegrity: parentPreview.integrity })
    await m.trust(profile, parentId, {
      integrity: parentPreview.integrity,
      capabilityHash: parentPreview.capabilityHash,
    })
    await m.enable(profile, parentId, true)
  }
  const preview = await m.inspect(profile, spec)
  expect(preview.blockers).toEqual([])
  await m.install(profile, spec, { expectedIntegrity: preview.integrity })
  const row = (await m.inventory(profile)).packages.find((pkg) => pkg.id === id)
  if (!row) throw new Error(`${id} was not installed`)
  await m.trust(profile, id, { integrity: row.entry.integrity, capabilityHash: row.capabilityHash })
  await m.enable(profile, id, true)

  // Enabling activates the installed snapshot through the same preflight and module loader as a worker.
  const source = runtimePluginSnapshotsFromInventory(await m.inventory(profile)).find(
    (item) => item.snapshot.packageId === id,
  )
  if (!source) throw new Error(`${id} has no runtime snapshot`)
  preflightRuntimePackage(source)
  const loader = createLoader({
    cacheDir: join(root, 'cache'),
    hostRoot: fileURLToPath(new URL('../../', import.meta.url)),
    agnesVersion: '0.0.0',
  })
  const loaded = await loadRuntimePackage(source, loader)
  expect(loaded?.module.plugins?.length).toBeGreaterThan(0)
})
