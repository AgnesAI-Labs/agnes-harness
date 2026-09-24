import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createPackageManager,
  emptyLock,
  packageDir,
  parseSource,
  validatePublicClientConfig,
  writeLock,
} from '../src/index.js'

const examples = join(dirname(fileURLToPath(import.meta.url)), '../../../examples/packages/client-panel')
const serviceExamples = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../examples/packages/client-service-panel',
)
const packageId = '@agnes-examples/client-panel'
const seams = [
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
]

let root: string
let profile: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agnes-client-panel-'))
  profile = join(root, 'profiles', 'local-dev')
  mkdirSync(profile, { recursive: true })
  cpSync(join(examples, 'v1'), join(root, 'client-panel-v1'), { recursive: true })
  cpSync(join(examples, 'v2'), join(root, 'client-panel-v2'), { recursive: true })
  cpSync(join(serviceExamples, 'v1'), join(root, 'client-service-panel-v1'), { recursive: true })
  writeLock(profile, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(seams.map((name) => [name, '@agnes/base'])),
    policySnapshot: { capabilityCeiling: ['ui', 'services'], workspacePackages: 'require-project-trust' },
  })
})

it('archives a client module bound to the package plugin row without an executable extension', async () => {
  const manager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    now: () => '2026-09-22T00:00:00Z',
    references: async () => [],
  })
  const preview = await manager.inspect(profile, parseSource('file:./client-service-panel-v1'))
  expect(preview).toMatchObject({
    id: '@agnes-examples/client-service-panel',
    blockers: [],
    contributions: [
      {
        kind: 'client',
        rowId: 'ext:examples/client-service-panel/runtime',
        client: { services: ['panel.version'], slots: ['ui:sidebar'] },
      },
    ],
  })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

it.each([
  ['v1', 'Agnes client module demo · v1'],
  ['v2', 'Agnes client module demo · v2'],
])('the %s browser entry shadows one migrated sidebar region', async (version, marker) => {
  const register = vi.fn()
  const entry = join(examples, version, 'extensions/main/client/index.js')
  const mod = await import(`${pathToFileURL(entry).href}?test=${Date.now()}`)

  mod.apply({ slots: { register } }, { publicConfig: { label: marker } })

  expect(register).toHaveBeenCalledOnce()
  const [slot, component, options] = register.mock.calls[0] ?? []
  expect(slot).toBe('ui:sidebar')
  expect(options).toEqual({ priority: -1 })
  expect(component()).toBe(marker)
})

it('rejects credential-shaped data from the explicit browser public-config channel', () => {
  expect(() => validatePublicClientConfig({ token: 'not-public' })).toThrow('credential-shaped')
  expect(() => validatePublicClientConfig({ provider: { endpoint: 'secret://model/key' } })).toThrow(
    'secret references',
  )
  expect(() => validatePublicClientConfig({ label: 'safe', modes: ['compact'] })).not.toThrow()
})

it('installs v1, atomically updates to v2, and disables the real client package', async () => {
  const manager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    now: () => '2026-09-18T00:00:00Z',
    references: async () => [],
  })
  const v1 = parseSource('file:./client-panel-v1')
  const v2 = parseSource('file:./client-panel-v2')
  const firstPreview = await manager.inspect(profile, v1)
  expect(firstPreview).toMatchObject({
    id: packageId,
    version: '1.0.0',
    blockers: [],
    contributions: [
      {
        kind: 'client',
        rowId: 'ext:examples/client-panel/main',
        client: {
          entry: 'client/index.js',
          styles: ['client/index.css'],
          slots: ['ui:sidebar'],
          publicConfig: { label: 'Agnes client module demo · v1' },
          services: [],
          projections: [],
        },
      },
    ],
  })
  const first = await manager.install(profile, v1, { expectedIntegrity: firstPreview.integrity })
  await manager.trust(profile, packageId, {
    integrity: first.integrity,
    capabilityHash: firstPreview.capabilityHash ?? '',
  })
  await manager.setEnabled(profile, packageId, true)
  expect((await manager.inventory(profile)).packages[0]).toMatchObject({
    enabled: true,
    entry: { version: '1.0.0' },
  })

  const secondPreview = await manager.inspect(profile, v2)
  const second = await manager.update(profile, packageId, v2, {
    expectedIntegrity: secondPreview.integrity,
    activation: {
      expectedInstalledIntegrity: first.integrity,
      trust: {
        integrity: secondPreview.integrity,
        capabilityHash: secondPreview.capabilityHash ?? '',
      },
    },
  })
  expect(second).toMatchObject({ version: '2.0.0', state: { enabled: true } })
  expect(existsSync(join(packageDir(root, 'local-dev', packageId), 'extensions/main/client/index.js'))).toBe(
    true,
  )

  await manager.setEnabled(profile, packageId, false)
  expect((await manager.inventory(profile)).packages[0]).toMatchObject({
    enabled: false,
    entry: { version: '2.0.0' },
  })
})
