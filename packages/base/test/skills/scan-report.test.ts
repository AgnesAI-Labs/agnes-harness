import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverSkillRoot,
  MAX_SKILL_ENTRIES_PER_ROOT,
  MAX_SKILL_FILE_BYTES,
  type SkillFs,
  type SkillRoot,
  skillRoots,
} from '../../extensions/skills/src/discover.js'

const custom = '/private/secret-custom'
const document = (name = 'review') => `---\nname: ${name}\ndescription: Useful\n---\nprivate body`
const root = (paths = [custom]): SkillRoot => {
  const selected = skillRoots({
    workspaceRoot: '/work',
    osHomeDir: '/home',
    agnesHomeDir: '/agh',
    customRoots: paths,
  })[1]
  if (!selected) throw new Error('missing user root')
  return selected
}
const directoryId = createHash('sha256').update(resolve(custom)).digest('hex')
const error = (code: string) => Object.assign(new Error('/private/secret-message'), { code })

function filesystem(files: Record<string, string> = {}): SkillFs {
  return {
    async list(path) {
      return Object.keys(files)
        .filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
        .map((key) => ({ name: key.slice(path.length + 1), kind: 'file' as const }))
    },
    async stat(path) {
      const value = files[path]
      if (value === undefined) throw error('ENOENT')
      return { kind: 'file', size: Buffer.byteLength(value), mtimeMs: 0 }
    },
    async read(path) {
      const value = files[path]
      if (value === undefined) throw error('ENOENT')
      return Buffer.from(value)
    },
    async realpath(path) {
      return path
    },
  }
}

describe('custom Skill directory scan reports', () => {
  it('counts valid files before same-name arbitration and rejects malformed files without rescanning', async () => {
    const fs = filesystem({
      [`${custom}/a.md`]: document(),
      [`${custom}/b.md`]: document(),
      [`${custom}/bad.md`]: '---\nname: invalid\ndescription: []\n---\nprivate body',
      [`${custom}/notes.txt`]: 'not a Skill',
    })
    const calls: string[] = []
    const scan = await discoverSkillRoot(
      {
        ...fs,
        list: async (path) => {
          calls.push(path)
          return fs.list(path)
        },
      },
      root(),
    )
    expect(scan).toMatchObject({
      ok: true,
      candidates: [{ name: 'review' }],
      directoryScans: [
        {
          directoryId,
          rootKey: 'user-agnes',
          state: 'partial',
          complete: true,
          foundCount: 2,
          skippedCount: 1,
          unreadable: false,
          truncated: false,
          issues: [{ code: 'invalid-frontmatter', stage: 'parse' }],
        },
      ],
    })
    expect(calls).toEqual(['/agh/skills', custom])
    expect(JSON.stringify(scan.directoryScans)).not.toMatch(/secret-custom|private body|bad\.md/)
  })

  it.each([
    ['ENOENT', 'directory-missing'],
    ['ENOTDIR', 'not-directory'],
    ['EACCES', 'permission-denied'],
    ['EPERM', 'permission-denied'],
    ['ELOOP', 'root-unreadable'],
    ['UNKNOWN_PRIVATE_CODE', 'root-unreadable'],
  ])('reports explicit directory list failure %s without counting a skipped Skill', async (osCode, code) => {
    const fs = filesystem()
    const scan = await discoverSkillRoot(
      {
        ...fs,
        list: async (path) => {
          if (path === custom) throw error(osCode)
          return fs.list(path)
        },
      },
      root(),
    )
    expect(scan).toMatchObject({
      ok: true,
      directoryScans: [
        {
          directoryId,
          state: 'unavailable',
          complete: false,
          foundCount: 0,
          skippedCount: 0,
          unreadable: true,
          truncated: false,
          issues: [{ code, stage: 'list', osCode: osCode === 'UNKNOWN_PRIVATE_CODE' ? 'OTHER' : osCode }],
        },
      ],
    })
    expect(JSON.stringify(scan.directoryScans)).not.toContain('secret')
  })

  it.each(['stat', 'realpath', 'read'] as const)(
    'reports candidate %s permission failure without dropping healthy files',
    async (stage) => {
      const fs = filesystem({
        [`${custom}/bad.md`]: document('bad'),
        [`${custom}/good.md`]: document('good'),
      })
      const scan = await discoverSkillRoot(
        {
          ...fs,
          [stage]: async (path: string) => {
            if (path === `${custom}/bad.md`) throw error('EPERM')
            return fs[stage]?.(path)
          },
        } as SkillFs,
        root(),
      )
      expect(scan).toMatchObject({
        ok: true,
        candidates: [{ name: 'good' }],
        directoryScans: [
          {
            state: 'partial',
            complete: false,
            foundCount: 1,
            skippedCount: 1,
            unreadable: false,
            issues: [{ code: 'permission-denied', stage, osCode: 'EPERM' }],
          },
        ],
      })
    },
  )

  it('reports root realpath failure after listing with no assumed rejected files', async () => {
    const fs = filesystem()
    const scan = await discoverSkillRoot(
      {
        ...fs,
        realpath: async (path) => {
          if (path === custom) throw error('EACCES')
          return path
        },
      },
      root(),
    )
    expect(scan).toMatchObject({
      directoryScans: [
        {
          state: 'unavailable',
          complete: false,
          skippedCount: 0,
          unreadable: true,
          issues: [{ code: 'permission-denied', stage: 'realpath', osCode: 'EACCES' }],
        },
      ],
    })
  })

  it('keeps absent default roots and absent SKILL.md files ignorable while reporting an empty custom directory', async () => {
    const fs = filesystem()
    const scan = await discoverSkillRoot(
      {
        ...fs,
        list: async (path) => {
          if (path === '/agh/skills') throw error('ENOENT')
          return [{ name: 'ordinary', kind: 'dir' }]
        },
      },
      root(),
    )
    expect(scan).toMatchObject({
      ok: true,
      directoryScans: [
        {
          state: 'empty',
          complete: true,
          foundCount: 0,
          skippedCount: 0,
          unreadable: false,
          truncated: false,
          issues: [],
        },
      ],
    })
  })

  it('reports unobserved custom directories honestly when a default root fails first', async () => {
    const fs = filesystem()
    const scan = await discoverSkillRoot(
      {
        ...fs,
        list: async () => {
          throw error('EPERM')
        },
      },
      root(),
    )
    expect(scan).toMatchObject({
      ok: false,
      diagnostic: { code: 'root-unreadable' },
      directoryScans: [
        {
          directoryId,
          state: 'unavailable',
          complete: false,
          foundCount: 0,
          skippedCount: 0,
          unreadable: false,
          truncated: false,
          issues: [],
        },
      ],
    })
  })

  it('caps issue detail while counting all rejected unreadable files', async () => {
    const files = Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`${custom}/${i}.md`, document()]))
    const fs = filesystem(files)
    const scan = await discoverSkillRoot(
      {
        ...fs,
        stat: async () => {
          throw error('EACCES')
        },
      },
      root(),
    )
    expect(scan.directoryScans?.[0]).toMatchObject({
      foundCount: 0,
      skippedCount: 140,
      truncated: true,
      complete: false,
    })
    expect(scan.directoryScans?.[0]?.issues).toHaveLength(128)
  })

  it('marks entry budget counts as incomplete lower bounds', async () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_SKILL_ENTRIES_PER_ROOT + 1 }, (_, i) => [
        `${custom}/${i}.md`,
        document(`skill-${i}`),
      ]),
    )
    const scan = await discoverSkillRoot(filesystem(files), root())
    expect(scan.directoryScans?.[0]).toMatchObject({
      foundCount: 128,
      skippedCount: 1,
      truncated: true,
      complete: false,
      issues: [{ code: 'entry-limit', stage: 'budget' }],
    })
  })

  it('reports size rejection at stat and a changed file at read without claiming complete observation', async () => {
    const fs = filesystem({ [`${custom}/changed.md`]: document() })
    const scan = await discoverSkillRoot(
      {
        ...fs,
        list: async (path) =>
          path === custom
            ? [
                { name: 'giant', kind: 'dir' },
                { name: 'changed.md', kind: 'file' },
              ]
            : [],
        stat: async (path) =>
          path.endsWith('/giant/SKILL.md')
            ? { kind: 'file', size: MAX_SKILL_FILE_BYTES + 1, mtimeMs: 0 }
            : fs.stat(path),
        read: async () => Buffer.from('short'),
      },
      root(),
    )
    expect(scan.directoryScans?.[0]).toMatchObject({
      complete: false,
      skippedCount: 2,
      foundCount: 0,
      issues: [
        { code: 'skill-file-unreadable', stage: 'stat' },
        { code: 'skill-file-unreadable', stage: 'read' },
      ],
    })
  })

  it('keeps exact counts complete when only issue detail truncates across two directories', async () => {
    const paths = [custom, '/private/second-custom']
    const fs = filesystem()
    const scan = await discoverSkillRoot(
      {
        ...fs,
        list: async (path) =>
          paths.includes(path)
            ? Array.from({ length: 70 }, (_, i) => ({ name: `outside-${i}`, kind: 'dir' as const }))
            : [],
        stat: async () => ({ kind: 'file', size: 1, mtimeMs: 0 }),
        realpath: async (path) => (path.endsWith('/SKILL.md') ? '/elsewhere/SKILL.md' : path),
      },
      root(paths),
    )
    expect(
      scan.directoryScans?.map((dir) => ({
        complete: dir.complete,
        skippedCount: dir.skippedCount,
        truncated: dir.truncated,
      })),
    ).toEqual([
      { complete: true, skippedCount: 70, truncated: false },
      { complete: true, skippedCount: 70, truncated: true },
    ])
    expect(scan.directoryScans?.reduce((total, dir) => total + dir.issues.length, 0)).toBe(128)
  })

  it('reports an unresolved entry permission denial without counting an unidentified Skill', async () => {
    const fs = filesystem()
    const scan = await discoverSkillRoot(
      {
        ...fs,
        list: async (path) => (path === custom ? [{ name: 'linked', kind: 'other' }] : []),
        stat: async () => {
          throw error('EACCES')
        },
      },
      root(),
    )
    expect(scan.directoryScans?.[0]).toMatchObject({
      complete: false,
      skippedCount: 0,
      issues: [{ code: 'permission-denied', stage: 'stat', osCode: 'EACCES' }],
    })
  })

  it.each([
    ['other', 'EPERM'],
    ['other', 'EACCES'],
    ['dir', 'EPERM'],
    ['dir', 'EACCES'],
  ] as const)(
    'does not invent a skipped Skill when %s identification fails with %s',
    async (kind, osCode) => {
      const fs = filesystem({ [`${custom}/known.md`]: document('known') })
      const scan = await discoverSkillRoot(
        {
          ...fs,
          list: async (path) =>
            path === custom
              ? [
                  { name: 'ordinary', kind },
                  { name: 'known.md', kind: 'file' },
                ]
              : [],
          stat: async (path) => {
            if (path === `${custom}/ordinary` || path === `${custom}/ordinary/SKILL.md`) throw error(osCode)
            return fs.stat(path)
          },
        },
        root(),
      )
      expect(scan).toMatchObject({
        ok: true,
        candidates: [{ name: 'known' }],
        directoryScans: [
          {
            state: 'partial',
            complete: false,
            foundCount: 1,
            skippedCount: 0,
            unreadable: false,
            issues: [{ code: 'permission-denied', stage: 'stat', osCode }],
          },
        ],
      })
    },
  )

  it('reports an oversized flat Skill as a confirmed rejection without reading or changing legacy catalog skips', async () => {
    const fs = filesystem({ [`${custom}/review.md`]: document('review') })
    const reads: string[] = []
    const scan = await discoverSkillRoot(
      {
        ...fs,
        stat: async () => ({ kind: 'file', size: MAX_SKILL_FILE_BYTES + 1, mtimeMs: 0 }),
        read: async (path) => {
          reads.push(path)
          return fs.read(path)
        },
      },
      root(),
    )
    expect(scan).toMatchObject({
      ok: true,
      candidates: [],
      directoryScans: [
        {
          state: 'partial',
          complete: true,
          foundCount: 0,
          skippedCount: 1,
          unreadable: false,
          truncated: false,
          issues: [{ code: 'skill-file-unreadable', stage: 'stat' }],
        },
      ],
    })
    expect(scan).not.toHaveProperty('skipped')
    expect(reads).toEqual([])
  })

  it('reports the existing root byte budget with incomplete counts', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `${custom}/${i}.md`,
        `${document(`skill-${i}`)}${'x'.repeat(190000)}`,
      ]),
    )
    const scan = await discoverSkillRoot(filesystem(files), root())
    expect(scan.directoryScans?.[0]).toMatchObject({
      foundCount: 11,
      skippedCount: 1,
      truncated: true,
      complete: false,
      issues: [{ code: 'root-bytes-limit', stage: 'budget' }],
    })
  })

  it('omits full directory reports for targeted observation and non-custom roots', async () => {
    expect(await discoverSkillRoot(filesystem(), root(), new Set())).not.toHaveProperty('directoryScans')
    const { dirs: _, ...ordinaryRoot } = root()
    expect(await discoverSkillRoot(filesystem(), ordinaryRoot)).not.toHaveProperty('directoryScans')
  })
})
