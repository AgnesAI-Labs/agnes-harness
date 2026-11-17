import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bundledPluginSource,
  createPackageManager,
  DEFAULT_ENABLED_BUNDLED_PACKAGES,
  emptyLock,
  parseSource,
  writeLock,
} from '@agnes/package-manager'
import { expect, it } from 'vitest'
import { discoverLocalExamples } from '../src/packages/local-examples.js'

it('lists judgment as an optional bundled package, not installed by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-judgment-catalog-'))
  try {
    const catalog = await discoverLocalExamples(root)
    expect(
      (await catalog.read({ offline: true })).entries.find((entry) => entry.id === '@agnes/judgment'),
    ).toMatchObject({
      version: '0.1.2',
      sourceId: 'builtin-plugins',
      source: { type: 'file', ref: 'file:./bundled-plugins/judgment' },
      metadata: { displayName: 'Judgment' },
    })
    expect(DEFAULT_ENABLED_BUNDLED_PACKAGES.some((pkg) => pkg.id === '@agnes/judgment')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('install review discloses what judgment sends to remote providers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-judgment-review-'))
  try {
    const profile = join(root, 'profiles', 'test')
    mkdirSync(profile, { recursive: true })
    writeLock(profile, {
      ...emptyLock('test', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
          name,
          { provider: 'local' },
        ]),
      ),
      policySnapshot: {
        // Every category judgment declares, so the review previews without a ceiling blocker.
        capabilityCeiling: [
          ...['hooks', 'events', 'projections', 'tools', 'ui', 'services'],
          ...['filesystem.read', 'sessionWork', 'autoTitle'],
        ],
        workspacePackages: 'require-project-trust',
      },
    })
    const manager = createPackageManager({ dataDir: root, agnesVersion: '0.1.0', cwd: root })
    const preview = await manager.inspect(profile, parseSource('file:./bundled-plugins/judgment'))
    expect(preview.blockers).toEqual([])
    // The same data-use tokens the install review disclosure test pins.
    for (const text of ['off by default', 'Remote providers receive', 'credential masking', '2,000', '8,000'])
      expect(preview.metadata?.description).toContain(text)
    // Review scope union excludes tool, hook and projection contracts; it lists the settings panel, the
    // status service, workspace reads for find_relevant, background session work and title refresh.
    const release = bundledPluginSource('file:./bundled-plugins/judgment')!
    const manifest = JSON.parse(readFileSync(join(release.root, release.path, 'package.json'), 'utf8'))
    expect(preview.declaredCapabilities).toEqual({
      ui: true,
      sessionWork: true,
      autoTitle: true,
      filesystem: { read: ['**'] },
      services: manifest.agnes.plugins[0].capabilities.services,
    })
    for (const text of ['默认关闭', '远程服务会收到', '遮蔽凭据'])
      expect(preview.metadata?.locales?.['zh-CN']?.description).toContain(text)
    expect(preview.presentation?.rows).toEqual([
      expect.objectContaining({ id: 'ext:agnes.judgment/main', settings: true }),
    ])
    const installed = await manager.install(profile, parseSource('file:./bundled-plugins/judgment'), {
      expectedIntegrity: preview.integrity,
    })
    expect(installed.state.enabled).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
