import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPackageManager, emptyLock, parseSource, readLock, writeLock } from '@agnes/package-manager'
import { createPrivateDirectorySync, hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, describe, expect, it } from 'vitest'
import { writePackageSkillInventory } from '../src/package-skill-snapshot.js'

const roots: string[] = []
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-package-skill-inventory-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function prepare(root: string, dataDir: string = root) {
  const profile = join(root, 'profiles', 'local-dev')
  const source = join(root, 'source')
  mkdirSync(profile, { recursive: true })
  writeLock(profile, {
    ...emptyLock('local-dev', '0.0.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams: {
      approval: '@agnes/base',
      checkpoint: '@agnes/base',
      ledger: '@agnes/base',
      sandbox: '@agnes/base',
      verifier: '@agnes/base',
      repair: '@agnes/base',
      artifacts: '@agnes/base',
      principals: '@agnes/base',
      platform: '@agnes/base',
      harness: '@agnes/base',
    },
    policySnapshot: { capabilityCeiling: ['tools'], workspacePackages: 'require-project-trust' },
  })
  mkdirSync(source, { recursive: true })
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'acme/verified-skill',
      version: '1.0.0',
      license: 'MIT',
      agnes: { contributions: [{ kind: 'skill', id: 'acme/review', path: './SKILL.md' }] },
    }),
  )
  writeFileSync(
    join(source, 'SKILL.md'),
    '---\nname: review\ndescription: Reviewed package Skill\n---\nverified body',
  )
  const manager = createPackageManager({
    dataDir,
    cwd: root,
    agnesVersion: '0.0.0',
    references: async () => [],
  })
  return { profile, source, manager }
}

async function install(profile: string, manager: ReturnType<typeof createPackageManager>) {
  const preview = await manager.inspect(profile, parseSource('file:./source'))
  await manager.install(profile, parseSource('file:./source'), { expectedIntegrity: preview.integrity })
  const row = (await manager.inventory(profile)).packages[0]
  if (!row) throw new Error('package missing from inventory')
  return row
}

describe('verified PackageManager Skill inventory', () => {
  it.skipIf(process.platform !== 'win32')(
    'regenerates a legacy snapshot in a safely inherited directory',
    async () => {
      const root = makeRoot()
      prepare(root)
      const parent = join(root, 'private-runtime')
      createPrivateDirectorySync(parent)
      const directory = join(parent, 'worker-snapshots')
      mkdirSync(directory)
      const target = join(directory, 'local-dev.package-skills.json')
      writeFileSync(target, 'old disposable snapshot')
      expect(hasPrivateDaclSync(directory)).toBe(false)
      await writePackageSkillInventory(
        { dataDir: root, name: 'local-dev' },
        join(root, 'profiles', 'local-dev'),
        target,
      )
      expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ version: 1, skills: [] })
      expect(hasPrivateDaclSync(directory)).toBe(true)
      expect(hasPrivateDaclSync(target)).toBe(true)
    },
  )
  it('publishes only trusted enabled attested Skills atomically and preserves a safe snapshot on path escape', async () => {
    const root = makeRoot()
    const { profile, source, manager } = prepare(root)
    const installed = await install(profile, manager)
    const packageId = installed.id
    const target = join(root, 'worker', 'package-skills.json')
    const identity = { dataDir: root, name: 'local-dev' }
    const lock = readLock(profile, { profile: 'local-dev', agnesVersion: '0.0.0' })
    const untrusted = lock.packages[packageId]
    if (!untrusted) throw new Error('package lock missing')
    // The inventory writer must not trust a desired state alone, even when the package bytes attest.
    untrusted.state.enabled = true
    writeLock(profile, lock)
    await writePackageSkillInventory(identity, profile, target)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ version: 1, skills: [] })

    await manager.trust(profile, packageId, {
      integrity: installed.entry.integrity,
      capabilityHash: installed.capabilityHash,
    })
    await manager.setEnabled(profile, packageId, true)
    await writePackageSkillInventory(identity, profile, target)
    const published = JSON.parse(readFileSync(target, 'utf8')) as {
      inventoryRevision: string
      skills: Array<{ packageId: string; contributionId: string; relativeLocation: string; source: string }>
    }
    expect(published.inventoryRevision).toMatch(/^sha256-[a-f0-9]{64}$/)
    expect(published.skills).toEqual([
      {
        packageId,
        contributionId: 'acme/review',
        relativeLocation: './SKILL.md',
        source: expect.stringContaining('verified body'),
      },
    ])
    if (process.platform === 'win32') {
      expect(hasPrivateDaclSync(target)).toBe(true)
      expect(hasPrivateDaclSync(join(root, 'worker'))).toBe(true)
    } else {
      expect(statSync(target).mode & 0o777).toBe(0o600)
      expect(statSync(join(root, 'worker')).mode & 0o777).toBe(0o700)
    }

    await manager.setEnabled(profile, packageId, false)
    await writePackageSkillInventory(identity, profile, target)
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ skills: [] })

    await manager.setEnabled(profile, packageId, true)
    await writePackageSkillInventory(identity, profile, target)
    const beforeEscape = readFileSync(target, 'utf8')
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: packageId,
        version: '1.0.0',
        license: 'MIT',
        agnes: { contributions: [{ kind: 'skill', id: 'acme/review', path: '../escape' }] },
      }),
    )
    await expect(manager.inspect(profile, parseSource('file:./source'))).rejects.toMatchObject({
      code: 'E_PACKAGE_STATE',
    })
    // The writer gets only PackageManager's verified inventory, so a rejected escaped candidate
    // cannot replace the last attested body snapshot.
    expect(readFileSync(target, 'utf8')).toBe(beforeEscape)
    expect(readFileSync(target, 'utf8')).not.toContain(source)
  })

  it('reads the profile the caller passes, not one derived from dataDir', async () => {
    // A profile's home (where its profiles/ tree lives) and its dataDir (large-state storage) are
    // configured independently in production and are not the same directory in general. Regression
    // for a bug where this function reconstructed profileDir as dataDir/profiles/<name>, which only
    // happened to match in every test above because those fixtures set dataDir to the same root
    // profiles/ lives under.
    const root = makeRoot()
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { recursive: true })
    const { profile, manager } = prepare(root, dataDir)
    const installed = await install(profile, manager)
    await manager.trust(profile, installed.id, {
      integrity: installed.entry.integrity,
      capabilityHash: installed.capabilityHash,
    })
    await manager.setEnabled(profile, installed.id, true)
    const target = join(root, 'worker', 'package-skills.json')
    const identity = { dataDir, name: 'local-dev' }
    await writePackageSkillInventory(identity, profile, target)
    const published = JSON.parse(readFileSync(target, 'utf8')) as {
      skills: Array<{ packageId: string }>
    }
    expect(published.skills).toMatchObject([{ packageId: installed.id }])
  })
})
