import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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
      version: '0.1.0',
      sourceId: 'builtin-plugins',
      source: { type: 'file', ref: 'file:./bundled-plugins/judgment' },
      metadata: { displayName: 'Judgment' },
    })
    expect(DEFAULT_ENABLED_BUNDLED_PACKAGES.some((pkg) => pkg.id === '@agnes/judgment')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('install review shows sideCall and conversation reading', async () => {
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
        capabilityCeiling: ['hooks', 'events', 'projections'],
        workspacePackages: 'require-project-trust',
      },
    })
    const manager = createPackageManager({ dataDir: root, agnesVersion: '0.1.0', cwd: root })
    const preview = await manager.inspect(profile, parseSource('file:./bundled-plugins/judgment'))
    expect(preview.blockers).toEqual([])
    expect(preview.metadata?.description).toContain('sideCall')
    expect(preview.metadata?.description).toContain('conversation messages')
    expect(preview.metadata?.description).toContain('2,000')
    expect(preview.metadata?.description).toContain('8,000')
    // Review scope union deliberately excludes hook/projection contracts; disclosure is metadata.
    expect(preview.declaredCapabilities).toEqual({})
    expect(preview.metadata?.locales?.['zh-CN']?.description).toContain('对话消息')
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
