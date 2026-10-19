import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPackageManager,
  emptyLock,
  parsePackageBundleContract,
  parseSource,
  readApplicationAssets,
  writeLock,
} from '@agnes/package-manager'
import { expect, it } from 'vitest'

it('inspects and installs the third-party application with valid raster assets and five resolvable launch Bundles', async () => {
  const packageDir = fileURLToPath(new URL('../', import.meta.url)),
    root = await mkdtemp(join(tmpdir(), 'agh-pharma-install-'))
  try {
    const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
    const bundles = parsePackageBundleContract(manifest.name, manifest.agnes.bundles)
    expect(Object.keys(bundles)).toHaveLength(5)
    for (const ref of manifest.agnes.application.agents)
      expect(bundles[ref]?.document.launch?.preset).toBe('gmp')
    const assets = await readApplicationAssets(packageDir, manifest.agnes.application)
    expect(Object.keys(assets)).toEqual(expect.arrayContaining(['mark', 'favicon']))
    const manager = createPackageManager({
      dataDir: root,
      agnesVersion: '0.1.0',
      cwd: packageDir,
      ceiling: ['tools', 'ui', 'store', 'filesystem.read', 'filesystem.write', 'tools.invoke'],
    })
    const source = parseSource(`file:${packageDir}`),
      profile = join(root, 'profiles', 'local-dev')
    await mkdir(profile, { recursive: true })
    writeLock(profile, {
      ...emptyLock('local-dev', '0.1.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
          name,
          { provider: 'local' },
        ]),
      ),
      policySnapshot: {
        capabilityCeiling: ['tools', 'ui', 'store', 'filesystem.read', 'filesystem.write', 'tools.invoke'],
        workspacePackages: 'require-project-trust',
      },
    })
    const preview = await manager.inspect(profile, source)
    expect(preview.blockers).toEqual([])
    expect(preview.application?.id).toBe('sableleaf-quality')
    expect(preview.application?.presentation?.navigation?.entries).toHaveLength(6)
    const installed = await manager.install(profile, source, { expectedIntegrity: preview.integrity })
    expect(installed).toBeDefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
