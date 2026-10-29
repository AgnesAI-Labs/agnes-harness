import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectPackageSkillFiles } from '@agnes/base'
import { createPackageManager, emptyLock, parseSource, writeLock } from '@agnes/package-manager'
import { writePackageSkillInventory } from '@agnes/resource-control-daemon'
import { bootstrapWorkerResources, scanSkills } from '@agnes/resource-control-worker'
import { expect, it } from 'vitest'

it('boots healthy Skills from an attested package alongside invalid and oversized Skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agh-package-skill-isolation-'))
  let close: (() => Promise<void>) | undefined
  try {
    const profile = join(root, 'profiles', 'test')
    const source = join(root, 'source')
    await mkdir(profile, { recursive: true })
    await mkdir(source)
    writeLock(profile, {
      ...emptyLock('test', '0.0.0'),
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: {
        approval: { provider: 'local-prompt' },
        checkpoint: { provider: 'fs' },
        billing: { provider: 'budget' },
        verifier: { provider: 't0' },
        repair: { provider: 'default' },
        artifacts: { provider: 'local' },
        principals: { provider: 'local' },
      },
      policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
    })
    const names = ['healthy', 'invalid', 'oversized']
    await writeFile(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'acme/isolation',
        version: '1.0.0',
        license: 'MIT',
        agnes: {
          contributions: names.map((name) => ({
            kind: 'skill',
            id: `acme/${name}`,
            path: `./${name}/SKILL.md`,
          })),
        },
      }),
    )
    for (const name of names) {
      await mkdir(join(source, name))
      await writeFile(
        join(source, name, 'SKILL.md'),
        name === 'invalid'
          ? 'invalid document'
          : '---\nname: same-name\ndescription: Package fixture\n---\nHealthy instructions',
      )
    }
    for (let i = 0; i < 33; i++) await writeFile(join(source, 'oversized', `${i}.md`), 'reference')
    const manager = createPackageManager({
      dataDir: root,
      cwd: root,
      agnesVersion: '0.0.0',
      references: async () => [],
    })
    const ref = parseSource('file:./source')
    const preview = await manager.inspect(profile, ref)
    await manager.install(profile, ref, { expectedIntegrity: preview.integrity })
    const installed = (await manager.inventory(profile)).packages[0]
    if (!installed) throw new Error('missing package')
    await manager.trust(profile, installed.id, {
      integrity: installed.entry.integrity,
      capabilityHash: installed.capabilityHash,
    })
    await manager.setEnabled(profile, installed.id, true)
    const packageSnapshot = join(root, 'worker', 'packages.json')
    await writePackageSkillInventory(
      { dataDir: root, name: 'test' },
      profile,
      packageSnapshot,
      collectPackageSkillFiles,
    )
    const stored = JSON.parse(await readFile(packageSnapshot, 'utf8'))
    expect(stored.skills).toHaveLength(1)
    expect(stored.failures.map((failure: { code: string }) => failure.code).sort()).toEqual([
      'SKILL_ATTACHMENTS_LIMIT',
      'SKILL_DOCUMENT_INVALID',
    ])
    const scan = await scanSkills(undefined, packageSnapshot, undefined, root, join(root, '.agh'))
    const candidates = scan.roots.flatMap((entry) => entry.candidates)
    const controlPath = join(root, 'worker', 'resources.json')
    await writeFile(
      controlPath,
      JSON.stringify({
        version: 1,
        mcpAuthority: 'resource-control',
        mcp: [],
        skills: {
          control: {
            desired: candidates.map((c) => ({ resourceId: c.resourceId, state: 'enabled' })),
            trust: candidates.map((c) => ({
              resourceId: c.resourceId,
              revision: c.revision,
              capabilityHash: c.capabilityHash,
              state: 'trusted',
            })),
          },
        },
      }),
    )
    const boot = await bootstrapWorkerResources({
      cwd: root,
      env: {
        HOME: root,
        AGNES_RESOURCE_SNAPSHOT: controlPath,
        AGNES_PACKAGE_SKILL_SNAPSHOT: packageSnapshot,
      },
      agnesHomeDir: join(root, '.agh'),
      profile: { name: 'test', dataDir: root, adapters: { secrets: { kind: 'env' } } },
      createBarrier: () => ({ quiesce: async (_id, publish) => publish({}) }),
      createSecrets: () => {
        throw new Error('unexpected secrets')
      },
    })
    if (!boot) throw new Error('startup failed')
    close = () => boot.runtime.mcp.close()
    expect(boot.skills.filter((s) => s.actual === 'ready')).toHaveLength(1)
    expect(boot.skills.filter((s) => s.actual === 'unavailable')).toHaveLength(2)
    expect(boot.skills.find((s) => s.lastSafeError?.code === 'SKILL_DOCUMENT_INVALID')?.name).toBe(
      'acme/invalid',
    )
    for (const skill of boot.skills) {
      const result = boot.skillResources.read(skill.resourceId, { sessionKey: 'test' })
      expect(result.ok).toBe(skill.actual === 'ready')
      if (skill.actual === 'ready')
        expect(result).toMatchObject({ content: expect.stringContaining('Healthy instructions') })
      else expect(skill.lastSafeError?.code).toMatch(/^SKILL_/)
    }
  } finally {
    await close?.()
    await rm(root, { recursive: true, force: true })
  }
})
