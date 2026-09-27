import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceSkillKey } from '@agnes/base'
import { hasPrivateDaclSync } from '@agnes/system-node'
import { afterEach, describe, expect, it } from 'vitest'
import { scanSkills } from '../src/skill-bootstrap.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('worker-private Skill LKG', () => {
  it('restores a successful filesystem root body after a later scan failure in a new worker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-worker-skill-lkg-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const home = join(root, 'home')
    const lkg = join(root, 'private-lkg')
    const skillDir = join(workspace, '.agh', 'skills', 'review')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: review\ndescription: Review a change\n---\nprivate durable body',
    )
    const originalHome = process.env.HOME
    process.env.HOME = home
    try {
      const first = await scanSkills(workspace, undefined, lkg)
      const firstRoot = first.roots.find((entry) => entry.rootKey === 'workspace-agnes')
      expect(firstRoot?.candidates).toHaveLength(1)
      expect(firstRoot?.candidates[0]?.body).toBe('private durable body')
      expect(first.failedRoots).not.toContain('workspace-agnes')

      // A directory that cannot be listed fails the whole root; the preceding successful worker
      // generation's LKG is retained. (A single malformed Skill only skips that entry.)
      await rm(join(workspace, '.agh', 'skills'), { recursive: true, force: true })
      await writeFile(join(workspace, '.agh', 'skills'), 'not a directory')
      const restarted = await scanSkills(workspace, undefined, lkg)
      const restoredRoot = restarted.roots.find((entry) => entry.rootKey === 'workspace-agnes')
      expect(restarted.failedRoots).toContain('workspace-agnes')
      expect(restoredRoot?.candidates).toHaveLength(1)
      expect(restoredRoot?.candidates[0]?.body).toBe('private durable body')

      const storedName = `workspace-agnes.${workspaceSkillKey(workspace)}.json`
      const stored = await readFile(join(lkg, storedName), 'utf8')
      expect(stored).toContain('private durable body')
      expect(stored).toContain(workspaceSkillKey(workspace))
      expect(stored).not.toContain(workspace)
      if (process.platform === 'win32') {
        expect(hasPrivateDaclSync(join(lkg, storedName))).toBe(true)
        expect(hasPrivateDaclSync(lkg)).toBe(true)
        const systemRoot = process.env.SystemRoot
        if (!systemRoot) throw new Error('SystemRoot unavailable')
        execFileSync(
          join(systemRoot, 'System32', 'icacls.exe'),
          [join(lkg, storedName), '/grant', '*S-1-1-0:R'],
          {
            windowsHide: true,
            stdio: 'pipe',
          },
        )
        const unsafeFallback = await scanSkills(workspace, undefined, lkg)
        expect(unsafeFallback.failedRoots).toContain('workspace-agnes')
        expect(unsafeFallback.roots.find((entry) => entry.rootKey === 'workspace-agnes')).toBeUndefined()
        expect(unsafeFallback.rootStatuses.find((entry) => entry.rootKey === 'workspace-agnes')?.state).toBe(
          'unavailable',
        )
      } else {
        expect((await stat(join(lkg, storedName))).mode & 0o777).toBe(0o600)
        expect((await stat(lkg)).mode & 0o777).toBe(0o700)
      }
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })
})

describe('scanSkills threads a separately resolved Agnes home to the one Agnes-owned user root', () => {
  it.each([
    { field: 'description', value: 'd'.repeat(1025) },
    { field: 'name', value: 'n'.repeat(129) },
  ])('does not restore an LKG candidate whose $field is out of bounds', async ({ field, value }) => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-worker-skill-lkg-bounds-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const lkg = join(root, 'private-lkg')
    const skillDir = join(workspace, '.agh', 'skills', 'review')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: review\ndescription: Review a change\n---\nbody')
    const originalHome = process.env.HOME
    process.env.HOME = join(root, 'home')
    try {
      await scanSkills(workspace, undefined, lkg)
      const storedPath = join(lkg, `workspace-agnes.${workspaceSkillKey(workspace)}.json`)
      const stored = JSON.parse(await readFile(storedPath, 'utf8')) as {
        candidates: Record<string, unknown>[]
      }
      const first = stored.candidates[0]
      if (!first) throw new Error('LKG candidate missing')
      first[field] = value
      await writeFile(storedPath, JSON.stringify(stored))

      await rm(join(workspace, '.agh', 'skills'), { recursive: true, force: true })
      await writeFile(join(workspace, '.agh', 'skills'), 'not a directory')
      const restarted = await scanSkills(workspace, undefined, lkg)
      expect(restarted.failedRoots).toContain('workspace-agnes')
      expect(restarted.roots.find((entry) => entry.rootKey === 'workspace-agnes')).toBeUndefined()
      expect(restarted.rootStatuses.find((entry) => entry.rootKey === 'workspace-agnes')?.state).toBe(
        'unavailable',
      )
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })

  it('finds a Skill under agnesHomeDir/skills even when osHomeDir points elsewhere entirely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-worker-skill-agnes-home-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const osHomeDir = join(root, 'os-home')
    const agnesHomeDir = join(root, 'agnes-home')
    const skillDir = join(agnesHomeDir, 'skills', 'greet')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: greet\ndescription: Say hello\n---\nhello from the resolved Agnes home',
    )
    const scanned = await scanSkills(workspace, undefined, undefined, osHomeDir, agnesHomeDir)
    const userAgnesRoot = scanned.roots.find((entry) => entry.rootKey === 'user-agnes')
    expect(userAgnesRoot?.candidates).toMatchObject([{ name: 'greet' }])
    // osHomeDir/.agh/skills -- the OS-home default -- must not also be scanned for this root.
    const userAgentsRoot = scanned.roots.find((entry) => entry.rootKey === 'user-agents')
    expect(userAgentsRoot?.candidates).toEqual([])
  })
})

describe('attested package Skill inventory', () => {
  it('discovers the daemon-published package root without reading a package path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-worker-package-skill-'))
    roots.push(root)
    const snapshot = join(root, 'package-skills.json')
    await writeFile(
      snapshot,
      JSON.stringify({
        version: 1,
        inventoryRevision: `sha256-${'a'.repeat(64)}`,
        skills: [
          {
            packageId: 'acme/verified-skill',
            contributionId: 'acme/review',
            relativeLocation: './SKILL.md',
            source: '---\nname: review\ndescription: Verified package Skill\n---\npackage body',
          },
        ],
      }),
    )
    const scanned = await scanSkills(join(root, 'workspace'), snapshot)
    expect(scanned.roots.find((entry) => entry.rootKey === 'package')?.candidates).toMatchObject([
      { body: 'package body' },
    ])
  })
})

describe('workspace Skill LKG isolation', () => {
  it('does not restore one workspace body into a different workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-worker-skill-lkg-iso-'))
    roots.push(root)
    const home = join(root, 'home')
    const lkg = join(root, 'private-lkg')
    const firstWorkspace = join(root, 'one')
    const secondWorkspace = join(root, 'two')
    await mkdir(join(firstWorkspace, '.agh', 'skills', 'review'), { recursive: true })
    await mkdir(join(secondWorkspace, '.agh', 'skills', 'review'), { recursive: true })
    await writeFile(
      join(firstWorkspace, '.agh', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review a change\n---\nfirst workspace body',
    )
    await writeFile(
      join(secondWorkspace, '.agh', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Review a change\n---\nsecond workspace body',
    )
    const originalHome = process.env.HOME
    process.env.HOME = home
    try {
      const first = await scanSkills(firstWorkspace, undefined, lkg)
      const second = await scanSkills(secondWorkspace, undefined, lkg)
      expect(first.roots[0]?.candidates[0]?.resourceId).not.toBe(second.roots[0]?.candidates[0]?.resourceId)
      expect(first.roots[0]?.candidates[0]?.body).toBe('first workspace body')
      expect(second.roots[0]?.candidates[0]?.body).toBe('second workspace body')
      await rm(join(secondWorkspace, '.agh', 'skills'), { recursive: true, force: true })
      await writeFile(join(secondWorkspace, '.agh', 'skills'), 'not a directory')
      const restored = await scanSkills(secondWorkspace, undefined, lkg)
      expect(restored.failedRoots).toContain('workspace-agnes')
      expect(restored.roots[0]?.candidates[0]?.body).toBe('second workspace body')
      expect(restored.roots[0]?.candidates[0]?.body).not.toBe('first workspace body')
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })
})
