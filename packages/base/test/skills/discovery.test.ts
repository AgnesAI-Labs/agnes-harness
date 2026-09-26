import { basename, join, resolve, sep } from 'node:path'
import { TextEncoder } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  discoverPackageSkill,
  discoverSkillRoot,
  FIVE_SKILL_ROOTS,
  locateSkillEntry,
  MAX_SKILL_BODY_BYTES,
  MAX_SKILL_ENTRIES_PER_ROOT,
  MAX_SKILL_FILE_BYTES,
  resolveSkillCandidates,
  type SkillFs,
  type SkillRoot,
  skillResourceIdAt,
  skillRoots,
  workspaceSkillKey,
} from '../../extensions/skills/src/discover.js'

const bytes = new TextEncoder()
const workspaceRoot = (path: string, workspace = '/work'): SkillRoot => ({
  ...FIVE_SKILL_ROOTS[0],
  path,
  workspaceKey: workspaceSkillKey(workspace),
})
function fs(files: Record<string, string>): SkillFs {
  return {
    async list(path) {
      const prefix = `${path.split(sep).join('/')}/`
      const names = new Map<string, 'dir' | 'file'>()
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue
        const rest = file.slice(prefix.length)
        const name = rest.split('/')[0] ?? ''
        if (!name) continue
        const kind = rest.includes('/') ? 'dir' : 'file'
        if (kind === 'dir' || !names.has(name)) names.set(name, kind)
      }
      return [...names].map(([name, kind]) => ({ name, kind }))
    },
    async stat(path) {
      const value = files[path.split(sep).join('/')]
      if (value === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      return { kind: 'file' as const, size: bytes.encode(value).byteLength, mtimeMs: 0 }
    },
    async read(path) {
      const value = files[path.split(sep).join('/')]
      if (value === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      return bytes.encode(value)
    },
  }
}

describe('skill discovery', () => {
  it('uses the frozen five roots and makes source ids path-free and deterministic', async () => {
    expect(FIVE_SKILL_ROOTS.map((root) => [root.scope, root.rootKey, root.priority])).toEqual([
      ['workspace', 'workspace-agnes', 500],
      ['user', 'user-agnes', 400],
      ['user', 'user-agents', 300],
      ['user', 'user-claude', 200],
      ['user', 'user-codex', 100],
    ])
    const root = workspaceRoot('/private/project/.agh/skills', '/private/project')
    const scan = await discoverSkillRoot(
      fs({
        '/private/project/.agh/skills/review/SKILL.md':
          '---\nname: review\ndescription: Review a change\n---\nsecret body',
      }),
      root,
    )
    expect(scan.ok).toBe(true)
    if (!scan.ok) return
    expect(scan.candidates[0]).toMatchObject({
      name: 'review',
      body: 'secret body',
      sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes' },
    })
    // Only the host-private base directory carries the path; identity and content stay path-free.
    expect(scan.candidates[0]?.directory).toBe(join('/private/project/.agh/skills', 'review'))
    expect(JSON.stringify({ ...scan.candidates[0], directory: undefined })).not.toContain('/private/project')
    expect(scan.candidates[0]?.resourceId).toMatch(/^skill\/workspace\/workspace-agnes\/[a-f0-9]{64}$/)
    expect(scan.candidates[0]?.revision).toMatch(/^[a-f0-9]{64}$/)
  })

  it('splits the Agnes-owned root from the OS-home-relative ones when AGH_HOME diverges from the OS home', () => {
    // A deployment that customises AGH_HOME points it somewhere unrelated to the OS home
    // entirely, so the two arguments below must produce visibly different paths for this
    // assertion to mean anything -- neither is a substring or prefix of the other.
    const osHomeDir = '/srv/os-account'
    const agnesHomeDir = '/var/agnes-deployment/custom-home'
    const roots = skillRoots({ workspaceRoot: '/work/project', osHomeDir, agnesHomeDir })
    expect(roots.map((root) => [root.rootKey, root.path])).toEqual([
      ['workspace-agnes', join('/work/project', '.agh', 'skills')],
      // The one Agnes-owned root follows the resolved Agnes home, not the OS home -- this is
      // the exact split PATH-03 exists to enforce. Before it, this root silently used osHomeDir
      // here too, which meant a customised AGNES_HOME never reached Skill discovery.
      ['user-agnes', join(agnesHomeDir, 'skills')],
      // The other three are other tools' own conventions and must stay OS-home-relative even
      // though AGH_HOME was customised above.
      ['user-agents', join(osHomeDir, '.agents', 'skills')],
      ['user-claude', join(osHomeDir, '.claude', 'skills')],
      ['user-codex', join(osHomeDir, '.codex', 'skills')],
    ])
  })

  it('discovers workspace skills under <ws>/.agh/skills and no longer reads <ws>/.agnes/skills', async () => {
    const skill = (name: string) => `---\nname: ${name}\ndescription: useful\n---\nbody`
    const files = fs({
      '/work/.agh/skills/current/SKILL.md': skill('current'),
      '/work/.agnes/skills/legacy/SKILL.md': skill('legacy'),
    })
    const names: string[] = []
    for (const root of skillRoots({
      workspaceRoot: '/work',
      osHomeDir: '/os-home',
      agnesHomeDir: '/os-home/.agh',
    })) {
      const scan = await discoverSkillRoot(files, root)
      if (scan.ok) names.push(...scan.candidates.map((candidate) => candidate.name))
    }
    expect(names).toEqual(['current'])
  })

  it('skips an unreadable, malformed, or oversized entry and keeps the rest without exposing the entry or body', async () => {
    const root = workspaceRoot('/work/.agh/skills')
    const malformed = await discoverSkillRoot(
      fs({
        '/work/.agh/skills/good/SKILL.md': '---\nname: good\ndescription: useful\n---\nbody',
        '/work/.agh/skills/bad/SKILL.md': '---\nname: bad\ndescription: [not static]\n---\nprivate',
        '/work/.agh/skills/blank/SKILL.md': "---\nname: blank\ndescription: ''\n---\nbody",
        '/work/.agh/skills/giant/SKILL.md': `---\nname: giant\ndescription: useful\n---\n${'x'.repeat(MAX_SKILL_FILE_BYTES)}`,
        '/work/.agh/skills/body/SKILL.md': `---\nname: body\ndescription: useful\n---\n${'x'.repeat(MAX_SKILL_BODY_BYTES + 1)}`,
      }),
      root,
    )
    expect(malformed.ok).toBe(true)
    if (!malformed.ok) return
    expect(malformed.candidates.map((item) => item.name)).toEqual(['good'])
    expect(Object.fromEntries((malformed.skipped ?? []).map((item) => [item.location, item.code]))).toEqual({
      bad: 'invalid-frontmatter',
      blank: 'invalid-frontmatter',
      giant: 'skill-file-unreadable',
      body: 'skill-body-too-large',
    })
    for (const item of malformed.skipped ?? [])
      expect(item.resourceId).toBe(skillResourceIdAt(root, item.location))
    expect(JSON.stringify(malformed.skipped)).not.toContain('private')
  })
  it('chooses the priority winner and reports shadowed identities without body or location', async () => {
    const workspace = await discoverSkillRoot(
      fs({
        '/work/.agh/skills/review/SKILL.md':
          '---\nname: Review\ndescription: workspace description\n---\nworkspace private body',
      }),
      workspaceRoot('/work/.agh/skills'),
    )
    const user = await discoverSkillRoot(
      fs({
        [['/home', 'u', '.agents', 'skills', 'review', 'SKILL.md'].join('/')]:
          '---\nname: review\ndescription: user description\n---\nuser private body',
      }),
      { ...FIVE_SKILL_ROOTS[2], path: ['/home', 'u', '.agents', 'skills'].join('/') },
    )
    expect(workspace.ok && user.ok).toBe(true)
    if (!workspace.ok || !user.ok) return
    const resolved = resolveSkillCandidates([...workspace.candidates, ...user.candidates])
    expect(resolved.winners[0]).toMatchObject({ name: 'Review', description: 'workspace description' })
    expect(resolved.shadowed).toMatchObject([{ reason: 'lower-priority' }])
    expect(JSON.stringify(resolved)).not.toContain('workspace private body')
    expect(JSON.stringify(resolved)).not.toContain('/private/project')
    expect(JSON.stringify(resolved)).not.toContain('user private body')
  })

  it('gives an attested package contribution a unique package identity and the lowest priority', () => {
    const skill = discoverPackageSkill({
      packageId: '@acme/review',
      contributionId: '@acme/review-skill',
      relativeLocation: './skills/review/SKILL.md',
      source: '---\nname: package-review\ndescription: Review packages\n---\npackage body',
    })
    expect(skill).toMatchObject({
      resourceId: expect.stringMatching(/^skill\/package\/package\/[a-f0-9]{64}$/),
      priority: 50,
      sourceIdentity: { scope: 'package', rootKey: 'package' },
      body: 'package body',
    })
    expect(JSON.stringify(skill)).not.toContain('./skills/review/SKILL.md')
  })

  it('binds workspace source ids to the workspace key so two workspaces do not share trust', async () => {
    const source = '---\nname: review\ndescription: Review a change\n---\nbody'
    const filesA = { '/a/.agh/skills/review/SKILL.md': source }
    const filesB = { '/b/.agh/skills/review/SKILL.md': source }
    const first = await discoverSkillRoot(fs(filesA), workspaceRoot('/a/.agh/skills', '/a'))
    const second = await discoverSkillRoot(fs(filesB), workspaceRoot('/b/.agh/skills', '/b'))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.candidates[0]?.resourceId).not.toBe(second.candidates[0]?.resourceId)
    expect(JSON.stringify({ ...first.candidates[0], directory: undefined })).not.toContain('/a/.agh')
    expect(JSON.stringify({ ...second.candidates[0], directory: undefined })).not.toContain('/b/.agh')
  })

  it('treats a missing root as an empty success and does not recurse into nested Skill directories', async () => {
    const missing: SkillFs = {
      async list() {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      },
      async stat() {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      },
      async read() {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      },
    }
    expect(await discoverSkillRoot(missing, workspaceRoot('/missing/.agh/skills', '/missing'))).toEqual({
      ok: true,
      root: 'workspace-agnes',
      candidates: [],
    })
    const nested = await discoverSkillRoot(
      fs({
        '/work/.agh/skills/outer/SKILL.md': '---\nname: outer\ndescription: visible\n---\nouter body',
        '/work/.agh/skills/outer/nested/SKILL.md': '---\nname: nested\ndescription: hidden\n---\nsecret',
      }),
      workspaceRoot('/work/.agh/skills'),
    )
    expect(nested.ok).toBe(true)
    if (!nested.ok) return
    expect(nested.candidates).toHaveLength(1)
    expect(nested.candidates[0]?.name).toBe('outer')
    expect(JSON.stringify(nested.candidates)).not.toContain('nested')
    expect(JSON.stringify(nested.candidates)).not.toContain('secret')
  })

  it('ignores a child directory without SKILL.md and skips entries beyond the cap', async () => {
    const plain = await discoverSkillRoot(
      fs({
        '/work/.agh/skills/good/SKILL.md': '---\nname: good\ndescription: useful\n---\nbody',
        '/work/.agh/skills/empty/README.md': 'not a skill',
      }),
      workspaceRoot('/work/.agh/skills'),
    )
    expect(plain).toMatchObject({ ok: true, candidates: [{ name: 'good' }] })
    expect(plain.ok && plain.skipped).toBeFalsy()
    const files: Record<string, string> = {}
    for (let index = 0; index <= MAX_SKILL_ENTRIES_PER_ROOT; index += 1) {
      files[`/work/.agh/skills/s${String(index).padStart(3, '0')}/SKILL.md`] =
        `---\nname: s${index}\ndescription: useful\n---\nbody`
    }
    const over = await discoverSkillRoot(fs(files), workspaceRoot('/work/.agh/skills'))
    expect(over.ok).toBe(true)
    if (!over.ok) return
    expect(over.candidates).toHaveLength(MAX_SKILL_ENTRIES_PER_ROOT)
    expect(over.skipped).toMatchObject([{ location: 's128', code: 'entry-limit' }])
  })
  it('skips a project Skill whose realpath leaves the root but follows a linked user Skill', async () => {
    const escaping = (files: Record<string, string>): SkillFs => ({
      ...fs(files),
      async realpath(path) {
        if (basename(path) === 'review') return resolve('/elsewhere/review')
        if (basename(path) === 'SKILL.md' && path.includes('review'))
          return resolve('/elsewhere/review/SKILL.md')
        return resolve(path)
      },
    })
    const project = await discoverSkillRoot(
      escaping({
        '/work/.agh/skills/review/SKILL.md': '---\nname: review\ndescription: useful\n---\nbody',
        '/work/.agh/skills/local/SKILL.md': '---\nname: local\ndescription: useful\n---\nbody',
      }),
      workspaceRoot('/work/.agh/skills'),
    )
    expect(project).toMatchObject({
      ok: true,
      candidates: [{ name: 'local' }],
      skipped: [{ location: 'review', code: 'entry-outside-root' }],
    })
    const user = await discoverSkillRoot(
      escaping({
        '/srv/profile/.claude/skills/review/SKILL.md': '---\nname: review\ndescription: useful\n---\nbody',
      }),
      { ...FIVE_SKILL_ROOTS[3], path: '/srv/profile/.claude/skills' },
    )
    expect(user).toMatchObject({ ok: true, candidates: [{ name: 'review' }] })
  })
  it('keeps SKILL.md revision when a Skill has no supported assets', async () => {
    const source = '---\nname: review\ndescription: useful\n---\nbody'
    const scan = await discoverSkillRoot(
      fs({ '/work/.agh/skills/review/SKILL.md': source }),
      workspaceRoot('/work/.agh/skills'),
    )
    expect(scan.ok).toBe(true)
    if (!scan.ok) return
    const { skillSha256 } = await import('../../extensions/skills/src/frontmatter.js')
    expect(scan.candidates[0]?.revision).toBe(skillSha256(source))
    expect(scan.candidates[0]?.files).toBeUndefined()
  })

  it('skips only the bad reference file and keeps its Skill', async () => {
    const scan = await discoverSkillRoot(
      fs({
        '/work/.agh/skills/good/SKILL.md': '---\nname: good\ndescription: useful\n---\nbody',
        '/work/.agh/skills/good/references/guide.md': '# guide',
        '/work/.agh/skills/bad/SKILL.md': '---\nname: bad\ndescription: useful\n---\nbody',
        '/work/.agh/skills/bad/references/../escape.md': 'nope',
      }),
      workspaceRoot('/work/.agh/skills'),
    )
    expect(scan.ok).toBe(true)
    if (!scan.ok) return
    expect(scan.candidates.map((item) => [item.name, item.files?.length ?? 0])).toEqual([
      ['bad', 0],
      ['good', 1],
    ])
  })
  it('skips an oversized text reference instead of truncating it and keeps the Skill', async () => {
    const huge = `# ${'a'.repeat(256 * 1024)}`
    const scan = await discoverSkillRoot(
      fs({
        '/work/.agh/skills/review/SKILL.md': '---\nname: review\ndescription: useful\n---\nbody',
        '/work/.agh/skills/review/references/guide.md': huge,
      }),
      workspaceRoot('/work/.agh/skills'),
    )
    expect(scan.ok).toBe(true)
    if (!scan.ok) return
    expect(scan.candidates.map((item) => item.name)).toEqual(['review'])
    expect(scan.candidates[0]?.files).toBeUndefined()
  })

  it('collects root-level and any-folder attachments but not dot folders, node_modules or nested Skills', async () => {
    const scan = await discoverSkillRoot(
      fs({
        '/work/.agh/skills/review/SKILL.md': '---\nname: review\ndescription: useful\n---\nbody',
        '/work/.agh/skills/review/reference.md': '# ref',
        '/work/.agh/skills/review/templates/letter.md': '# letter',
        '/work/.agh/skills/review/examples/a/b.txt': 'b',
        '/work/.agh/skills/review/.git/config': 'x',
        '/work/.agh/skills/review/node_modules/x/index.md': 'x',
        '/work/.agh/skills/review/tool/unknown.bin': 'x',
        '/work/.agh/skills/review/nested/SKILL.md': '---\nname: nested\ndescription: d\n---\nsecret',
      }),
      workspaceRoot('/work/.agh/skills'),
    )
    expect(scan.ok).toBe(true)
    if (!scan.ok) return
    expect(scan.candidates.map((item) => item.name)).toEqual(['review'])
    expect(scan.candidates[0]?.files?.map((file) => file.relativePath)).toEqual([
      'examples/a/b.txt',
      'reference.md',
      'templates/letter.md',
    ])
  })

  it('keeps a Skill with more than the file cap by taking the first files', async () => {
    const files: Record<string, string> = {
      '/work/.agh/skills/review/SKILL.md': '---\nname: review\ndescription: useful\n---\nbody',
    }
    for (let index = 0; index < 40; index += 1)
      files[`/work/.agh/skills/review/references/f${String(index).padStart(2, '0')}.md`] = `# ${index}`
    const scan = await discoverSkillRoot(fs(files), workspaceRoot('/work/.agh/skills'))
    expect(scan.ok && scan.candidates[0]?.files?.length).toBe(32)
  })

  it('discovers single-file Skills, ignores plain markdown, and lets a directory win a same-name file', async () => {
    const scan = await discoverSkillRoot(
      fs({
        '/work/.agh/skills/solo.md': '---\nname: solo\ndescription: one file\n---\nsolo body',
        '/work/.agh/skills/README.md': '# About these skills',
        '/work/.agh/skills/review/SKILL.md': '---\nname: review\ndescription: directory\n---\nbody',
        '/work/.agh/skills/review.md': '---\nname: review\ndescription: file\n---\nbody',
      }),
      workspaceRoot('/work/.agh/skills'),
    )
    expect(scan.ok).toBe(true)
    if (!scan.ok) return
    expect(scan.candidates.map((item) => [item.name, item.description])).toEqual([
      ['review', 'directory'],
      ['solo', 'one file'],
    ])
    expect(scan.skipped).toBeUndefined()
    // A single file has no directory of its own; naming its parent would expose the whole root.
    expect(scan.candidates.find((item) => item.name === 'solo')?.directory).toBeUndefined()
    expect(scan.candidates.find((item) => item.name === 'review')?.directory).toBe(
      join('/work/.agh/skills/review'),
    )
  })

  it('reads .agents and .claude project Skills after .agh, keeps .agh ids, and lets the earlier one win', async () => {
    const skill = (name: string, description: string) =>
      `---\nname: ${name}\ndescription: ${description}\n---\nbody`
    const [root] = skillRoots({
      workspaceRoot: '/work',
      osHomeDir: '/os-home',
      agnesHomeDir: '/os-home/.agh',
    })
    if (!root) throw new Error('workspace root missing')
    const scan = await discoverSkillRoot(
      fs({
        '/work/.agh/skills/shared/SKILL.md': skill('shared', 'from agh'),
        '/work/.agents/skills/agents-only/SKILL.md': skill('agents-only', 'from agents'),
        '/work/.claude/skills/shared/SKILL.md': skill('shared', 'from claude'),
        '/work/.claude/skills/claude-only/SKILL.md': skill('claude-only', 'from claude'),
      }),
      root,
    )
    expect(scan.ok).toBe(true)
    if (!scan.ok) return
    expect(scan.candidates.map((item) => [item.name, item.description])).toEqual([
      ['shared', 'from agh'],
      ['agents-only', 'from agents'],
      ['claude-only', 'from claude'],
    ])
    expect(scan.candidates[0]?.resourceId).toBe(skillResourceIdAt(root, 'shared'))
    expect(scan.candidates[2]?.resourceId).toBe(skillResourceIdAt(root, '.claude/skills/claude-only'))
    const located = await locateSkillEntry(
      fs({ '/work/.claude/skills/claude-only/SKILL.md': skill('claude-only', 'x') }),
      root,
      skillResourceIdAt(root, '.claude/skills/claude-only'),
    )
    expect(located).toEqual({ dirPath: join('/work', '.claude', 'skills'), name: 'claude-only', kind: 'dir' })
  })
})
