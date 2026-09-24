import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDeployManifest, validateSurfaceInstance } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { createPackageManager, emptyLock, parseSource, readLock, writeLock } from '../src/index.js'

const examples = fileURLToPath(new URL('../../../examples/packages/', import.meta.url))
it('real inspect validates versioned recovery fixtures without installing or executing their entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-recovery-fixtures-')),
    profile = join(root, 'profiles/local-dev')
  try {
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
      policySnapshot: {
        capabilityCeiling: ['tools', 'services'],
        workspacePackages: 'require-project-trust',
      },
    })
    const manager = createPackageManager({ dataDir: root, cwd: root, agnesVersion: '0.1.0' })
    const results = []
    for (const [family, label] of [
      ['hot-service', 'v1'],
      ['hot-service', 'v2'],
      ['hot-service', 'broken'],
      ['acme-dashboard', 'v1'],
      ['acme-dashboard', 'v2'],
    ]) {
      const folder = `${family}-${label}`
      cpSync(join(examples, family as string, label as string), join(root, folder), { recursive: true })
      const preview = await manager.inspect(profile, parseSource(`file:./${folder}`))
      expect(preview.id).toBe(family === 'hot-service' ? '@agnes-examples/hot-service' : 'acme/dashboard')
      expect(preview.version).toBe(
        family === 'hot-service'
          ? label === 'v1'
            ? '1.0.0'
            : label === 'v2'
              ? '1.1.0'
              : '1.2.0'
          : label === 'v1'
            ? '1.0.0'
            : '2.0.0',
      )
      // hot-service is agnes.plugins: no static contribution to report (plugin-manifest.ts).
      if (family === 'hot-service') expect(preview.contributions).toEqual([])
      if (family === 'acme-dashboard') {
        expect(preview.contributions.some((item) => item.kind === 'extension')).toBe(false)
        expect(preview.contributions.some((item) => item.kind === 'surface')).toBe(true)
      }
      results.push(preview.integrity)
    }
    expect(new Set(results).size).toBe(5)
    expect(readLock(profile, { profile: 'local-dev', agnesVersion: '0.1.0' }).packages).toEqual({})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('recovery deployment references use real protocol contracts and contain only secret references', () => {
  const deploy = JSON.parse(readFileSync(join(examples, 'acme-dashboard/deploy/manifest.json'), 'utf8'))
  const instance = JSON.parse(
    readFileSync(join(examples, 'acme-dashboard/deploy/surfaces/main.json'), 'utf8'),
  )
  expect(validateDeployManifest(deploy).ok).toBe(true)
  expect(validateSurfaceInstance(instance).ok).toBe(true)
  expect(Object.values(instance.secrets)).toEqual(['secret://customer/dashboard-upstream'])
  expect(instance.grants).toEqual([
    { extension: 'plugin/6a629743672f8122', name: 'data.read', range: '^2.0' },
  ])
})
