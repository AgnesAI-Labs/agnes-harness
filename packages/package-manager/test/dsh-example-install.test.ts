import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createPackageManager,
  emptyLock,
  parseSource,
  validatePublicClientConfig,
  writeLock,
} from '../src/index.js'

const examples = fileURLToPath(new URL('../../../examples/packages/dsh-input-controls', import.meta.url))
const packageId = '@agnes-examples/dsh-input-controls'
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
  root = mkdtempSync(join(tmpdir(), 'agnes-dsh-example-'))
  profile = join(root, 'profiles', 'local-dev')
  mkdirSync(profile, { recursive: true })
  cpSync(join(examples, 'v1'), join(root, 'dsh-input-v1'), { recursive: true })
  cpSync(join(examples, 'v2'), join(root, 'dsh-input-v2'), { recursive: true })
  writeLock(profile, {
    ...emptyLock('local-dev', '0.1.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: Object.fromEntries(seams.map((name) => [name, '@agnes/base'])),
    policySnapshot: { capabilityCeiling: ['ui', 'services'], workspacePackages: 'require-project-trust' },
  })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function manager() {
  return createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    now: () => '2026-09-23T00:00:00Z',
    references: async () => [],
  })
}

it('inspects DSH v1/v2 with exact slots, catalog version and distinct immutable digests', async () => {
  const packageManager = manager()
  const v1 = await packageManager.inspect(profile, parseSource('file:./dsh-input-v1'))
  const v2 = await packageManager.inspect(profile, parseSource('file:./dsh-input-v2'))

  expect(v1).toMatchObject({
    id: packageId,
    version: '1.0.0',
    blockers: [],
    contributions: [
      {
        kind: 'client',
        client: {
          entry: 'client/index.js',
          styles: ['client/index.css'],
          slots: ['conversation.input.right'],
          slotCatalogVersion: 'dsh-client-slots/v1',
          publicConfig: { label: 'DSH input controls · v1' },
        },
      },
    ],
  })
  expect(v2).toMatchObject({
    id: packageId,
    version: '2.0.0',
    contributions: [
      { client: { slotCatalogVersion: 'dsh-client-slots/v1', slots: ['conversation.input.right'] } },
    ],
  })
  expect(v1.integrity).not.toBe(v2.integrity)
  expect(v1.capabilityHash).not.toBe(v2.capabilityHash)
  expect(() =>
    validatePublicClientConfig(
      v1.contributions[0]?.kind === 'client' && 'client' in v1.contributions[0]
        ? v1.contributions[0].client?.publicConfig
        : undefined,
    ),
  ).not.toThrow()
})

it('installs, trusts, enables and prepares a version-aware DSH update without a browser', async () => {
  const packageManager = manager()
  const sourceV1 = parseSource('file:./dsh-input-v1')
  const sourceV2 = parseSource('file:./dsh-input-v2')
  const previewV1 = await packageManager.inspect(profile, sourceV1)
  const installed = await packageManager.install(profile, sourceV1, {
    expectedIntegrity: previewV1.integrity,
  })

  await packageManager.trust(profile, packageId, {
    integrity: installed.integrity,
    capabilityHash: previewV1.capabilityHash ?? '',
  })
  await packageManager.setEnabled(profile, packageId, true)
  expect((await packageManager.inventory(profile)).packages[0]).toMatchObject({
    id: packageId,
    enabled: true,
    entry: { version: '1.0.0', integrity: installed.integrity },
  })

  const previewV2 = await packageManager.inspect(profile, sourceV2)
  const updated = await packageManager.update(profile, packageId, sourceV2, {
    expectedIntegrity: previewV2.integrity,
    activation: {
      expectedInstalledIntegrity: installed.integrity,
      trust: {
        integrity: previewV2.integrity,
        capabilityHash: previewV2.capabilityHash ?? '',
      },
    },
  })

  expect(updated).toMatchObject({
    version: '2.0.0',
    integrity: previewV2.integrity,
    state: { enabled: true },
  })
  expect((await packageManager.inventory(profile)).packages[0]).toMatchObject({
    id: packageId,
    enabled: true,
    entry: { version: '2.0.0', integrity: previewV2.integrity },
  })
})
