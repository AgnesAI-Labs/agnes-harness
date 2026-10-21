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
    expect(manifest.agnes.application.delegableAgents).toHaveLength(4)
    expect(
      manifest.agnes.application.workbench.actions.every((action: { agent: string }) =>
        action.agent.endsWith('#hub'),
      ),
    ).toBe(true)
    for (const role of Object.values(manifest.agnes.bundles) as Array<{
      presets: { gmp: { model: { system_prompt: { personaPrefix: string } } } }
    }>)
      expect(role.presets.gmp.model.system_prompt.personaPrefix.length).toBeGreaterThan(60)
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
    expect(preview.version).toBe('1.2.0')
    expect(preview.application?.id).toBe('sableleaf-quality')
    expect(preview.application?.workbench?.tabs).toHaveLength(3)
    expect(preview.application?.workbench?.actions).toHaveLength(5)
    expect(preview.application?.workbench?.scenarios).toHaveLength(3)
    expect(preview.application?.presentation?.navigation?.entries).toHaveLength(2)
    const installed = await manager.install(profile, source, { expectedIntegrity: preview.integrity })
    expect(installed).toBeDefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
