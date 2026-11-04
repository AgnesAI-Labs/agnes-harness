import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { dataDir } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { Context } from '@agnes/plugin-runtime'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { AGH_DIR } from '@agnes/protocol'
import { resourceControlDirectory, workerSnapshotPath } from '@agnes/resource-control-store'
import { scanSkills } from '@agnes/resource-control-worker'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { bootLocal } from '../src/boot/local.js'
import type { Booted } from '../src/types.js'
import { TEST_LOCK } from './boot-host.js'

const baseDir = fileURLToPath(new URL('../../base', import.meta.url))
const state = vi.hoisted(() => ({ provider: undefined as ScriptedProvider | undefined }))

// A plugin that registers one Skill in code, the way bundled plugins do.
const pluginSkill = {
  declaration: {
    export: 'pluginSkill',
    id: 'ext:test.plugin-skill',
    apiRange: '^5.0.0',
    default: true,
    inject: ['skills'],
    provide: [],
    runtime: 'in-process' as const,
  },
  entry: normalizePluginExport({
    inject: ['skills'],
    apply(ctx: Context) {
      ctx.skills.register({ name: 'plugin-skill', description: 'Use plugin-skill.', body: 'Steps.' })
    },
  }),
}

// The production assembly up to createHost, then the test host with the real Base skills extension,
// one plugin Skill, and a scripted model whose requests the cases read.
vi.mock('@agnes/host', async (original) => ({
  ...(await original<typeof import('@agnes/host')>()),
  createHost: async (
    profile: import('@agnes/host').ResolvedProfile,
    options: import('@agnes/host').HostOptions,
  ) =>
    (
      await createTestHost({
        dataDir: profile.dataDir,
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        packageDirs: { '@agnes/base': baseDir },
        packages: { '@agnes/code': { plugins: [pluginSkill] } },
        ...(state.provider ? { provider: state.provider } : {}),
        disableSessionTitle: true,
        ...(options.skillContribution ? { skillContribution: options.skillContribution } : {}),
        ...(options.skillResources ? { skillResources: options.skillResources } : {}),
      })
    ).host,
}))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const skill = (dir: string, name: string) => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Use ${name}.\n---\nSteps.\n`)
}

/** One boot: home (AGH_HOME), a workspace, and the names in each request's skill catalogue. */
async function boot() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'agnes-local-skills-')))
  roots.push(root)
  const home = join(root, 'home')
  const workspace = join(root, 'work')
  mkdirSync(home)
  mkdirSync(workspace)
  const provider = new ScriptedProvider({
    models: [fakeModel({ route: 'gw', id: 'm1' })],
    scripts: [
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'done', reason: 'stop' },
      ],
    ],
  })
  state.provider = provider
  const logged: string[] = []
  /** `flags` are extra command-line flags; `bootHome` replaces the home the run boots in. */
  const start = async (flags: string[] = [], bootHome = home): Promise<Booted> => {
    const booted = await bootLocal(parseArgs([...flags, '--cwd', workspace]), {
      env: { HOME: root, AGH_HOME: home },
      home: bootHome,
      cwd: workspace,
      agnesVersion: '0.0.0',
      log: (line) => logged.push(line),
      lock: TEST_LOCK,
      loader: {
        importPackage: async () => {
          throw new Error('unused loader')
        },
      },
    })
    await booted.client.workspace.add(workspace)
    return booted
  }
  /** The skill names the last request offered, from its `<available_skills>` block. */
  const offered = () => {
    const system = provider.calls.at(-1)?.system ?? ''
    const block = /<available_skills>\n([\s\S]*?)<\/available_skills>/.exec(system)?.[1] ?? ''
    return block
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')[0])
      .sort()
  }
  /** One turn in a new session, then the skills its request offered. */
  const offeredIn = async (b: Booted, sessionKey?: string) => {
    await turn(await b.client.session.new({ cwd: workspace, ...(sessionKey ? { sessionKey } : {}) }))
    return offered()
  }
  const decisionsFile = (at = home) => workerSnapshotPath(resourceControlDirectory(dataDir(at)), 'local-dev')
  /** Writes the daemon's saved decisions for this home, the way its store does. */
  const saveDecisions = (control: object, at = home) => {
    const file = decisionsFile(at)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        profile: 'local-dev',
        skills: { control: { priorities: {}, removed: [], desired: [], trust: [], ...control } },
        mcp: [],
        mcpAuthority: 'resource-control',
      }),
    )
  }
  /** What the daemon's scan records for a workspace Skill: its resource id and capability. */
  const scanned = async (name: string) => {
    const scan = await scanSkills(workspace, undefined, undefined, root, home, false, undefined, () => {})
    const found = scan.roots.flatMap((item) => item.candidates).find((item) => item.name === name)
    if (!found) throw new Error(`scan did not find ${name}`)
    return found
  }
  return {
    home,
    root,
    workspace,
    logged,
    start,
    offered,
    offeredIn,
    decisionsFile,
    saveDecisions,
    scanned,
    workspaceSkills: join(workspace, AGH_DIR, 'skills'),
    userSkills: join(home, 'skills'),
  }
}

type Session = Awaited<ReturnType<Booted['client']['session']['new']>>
const turn = async (session: Session) => expect((await session.prompt('go')).reason).toBe('completed')
const OLD_REVISION = 'e'.repeat(64)

describe('a host embedded in the CLI offers the disk Skills a daemon worker would', () => {
  it('offers only the plugin Skills when no Skill folder exists', async () => {
    const t = await boot()
    const b = await t.start()
    try {
      expect(await t.offeredIn(b)).toEqual(['plugin-skill'])
    } finally {
      await b.close()
    }
  })

  it('offers workspace and user Skills that were on disk before boot, beside the plugin Skills', async () => {
    const t = await boot()
    skill(t.workspaceSkills, 'pre-boot')
    skill(join(t.workspace, '.claude', 'skills'), 'from-claude-folder')
    skill(t.userSkills, 'personal')
    const b = await t.start()
    try {
      expect(await t.offeredIn(b)).toEqual(['from-claude-folder', 'personal', 'plugin-skill', 'pre-boot'])
    } finally {
      await b.close()
    }
  })

  it('keeps each session on the list it started with; a new session scans, refreshSkills rebuilds every view', async () => {
    const t = await boot()
    const b = await t.start()
    try {
      const first = await b.client.session.new({ cwd: t.workspace, sessionKey: 'local-skills-first' })
      await turn(first)
      expect(t.offered()).toEqual(['plugin-skill'])
      skill(t.workspaceSkills, 'saved-later')
      expect(await t.offeredIn(b, 'local-skills-second')).toEqual(['plugin-skill', 'saved-later'])
      // The second session's scan does not change the first session's list.
      await turn(first)
      expect(t.offered()).toEqual(['plugin-skill'])
      b.refreshSkills?.()
      await turn(first)
      expect(t.offered()).toEqual(['plugin-skill', 'saved-later'])
    } finally {
      await b.close()
    }
  })

  it('applies the daemon trust rules to the saved decisions', async () => {
    const t = await boot()
    for (const name of [
      'rejected',
      'untrusted',
      'removed',
      'trusted-then-edited',
      'disabled-then-edited',
      'never-seen',
    ])
      skill(t.workspaceSkills, name)
    const rejected = await t.scanned('rejected')
    const untrusted = await t.scanned('untrusted')
    const removed = await t.scanned('removed')
    const edited = await t.scanned('trusted-then-edited')
    const disabled = await t.scanned('disabled-then-edited')
    const decided = (item: typeof rejected, state: string, desired: string, revision = item.revision) => ({
      trust: { resourceId: item.resourceId, revision, capabilityHash: item.capabilityHash, state },
      desired: { resourceId: item.resourceId, state: desired },
    })
    const all = [
      decided(rejected, 'rejected', 'enabled'),
      decided(untrusted, 'untrusted', 'enabled'),
      // Decisions saved before the file was edited: they follow the Skill to its new revision.
      decided(edited, 'trusted', 'enabled', OLD_REVISION),
      decided(disabled, 'trusted', 'disabled', OLD_REVISION),
    ]
    t.saveDecisions({
      removed: [removed.resourceId],
      trust: all.map((item) => item.trust),
      desired: all.map((item) => item.desired),
    })
    const b = await t.start()
    try {
      expect(await t.offeredIn(b)).toEqual(['never-seen', 'plugin-skill', 'trusted-then-edited'])
    } finally {
      await b.close()
    }
  })

  it('offers no disk Skill under --safe-mode', async () => {
    const t = await boot()
    skill(t.workspaceSkills, 'repo-skill')
    skill(t.userSkills, 'personal')
    const b = await t.start(['--safe-mode', '--standalone'])
    try {
      expect(await t.offeredIn(b)).toEqual(['plugin-skill'])
    } finally {
      await b.close()
    }
  })

  it('reads the real home decisions under --ephemeral', async () => {
    const t = await boot()
    skill(t.workspaceSkills, 'switched-off')
    skill(t.workspaceSkills, 'still-on')
    const off = await t.scanned('switched-off')
    t.saveDecisions({
      trust: [
        {
          resourceId: off.resourceId,
          revision: off.revision,
          capabilityHash: off.capabilityHash,
          state: 'trusted',
        },
      ],
      desired: [{ resourceId: off.resourceId, state: 'disabled' }],
    })
    const ephemeral = join(t.root, 'ephemeral-home')
    mkdirSync(ephemeral)
    const b = await t.start(['--ephemeral'], ephemeral)
    try {
      expect(await t.offeredIn(b)).toEqual(['plugin-skill', 'still-on'])
    } finally {
      await b.close()
    }
  })

  it('offers no disk Skill when the daemon kept resource state but no decisions file', async () => {
    const t = await boot()
    skill(t.workspaceSkills, 'pre-boot')
    mkdirSync(resourceControlDirectory(dataDir(t.home)), { recursive: true })
    const b = await t.start()
    try {
      expect(await t.offeredIn(b)).toEqual(['plugin-skill'])
    } finally {
      await b.close()
    }
  })

  it('treats every Skill as new where the daemon never kept resource state', async () => {
    const t = await boot()
    skill(t.workspaceSkills, 'pre-boot')
    expect(existsSync(resourceControlDirectory(dataDir(t.home)))).toBe(false)
    const b = await t.start()
    try {
      expect(await t.offeredIn(b)).toEqual(['plugin-skill', 'pre-boot'])
    } finally {
      await b.close()
    }
  })

  it('offers no disk Skill when the saved decisions cannot be read', async () => {
    const t = await boot()
    skill(t.workspaceSkills, 'pre-boot')
    mkdirSync(join(t.decisionsFile(), '..'), { recursive: true })
    writeFileSync(t.decisionsFile(), '{"version":1,"skills":')
    const b = await t.start()
    try {
      expect(await t.offeredIn(b)).toEqual(['plugin-skill'])
    } finally {
      await b.close()
    }
  })

  it('sends a skipped Skill file to the boot log once, not to the terminal', async () => {
    const t = await boot()
    skill(t.workspaceSkills, 'good')
    mkdirSync(join(t.workspaceSkills, 'broken'), { recursive: true })
    writeFileSync(join(t.workspaceSkills, 'broken', 'SKILL.md'), 'no frontmatter here\n')
    skill(t.userSkills, 'personal')
    mkdirSync(join(t.userSkills, 'broken-user'), { recursive: true })
    writeFileSync(join(t.userSkills, 'broken-user', 'SKILL.md'), 'no frontmatter here\n')
    const writes: string[] = []
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(`stdout ${String(chunk)}`)
        return true
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(`stderr ${String(chunk)}`)
        return true
      }),
      ...(['log', 'info', 'warn', 'error'] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation((...args) => {
          writes.push(`console.${method} ${args.join(' ')}`)
        }),
      ),
    ]
    let b: Booted | undefined
    try {
      b = await t.start()
      await t.offeredIn(b)
    } finally {
      for (const spy of spies) spy.mockRestore()
      await b?.close()
    }
    expect(writes).toEqual([])
    expect(t.offered()).toEqual(['good', 'personal', 'plugin-skill'])
    // One line per skipped file: the session's single scan covers the user roots too.
    expect(t.logged.sort()).toEqual([
      expect.stringMatching(/^host warn: agnes: Skill skill\/user\/\S+ skipped \(invalid-frontmatter\)$/),
      expect.stringMatching(
        /^host warn: agnes: Skill skill\/workspace\/\S+ skipped \(invalid-frontmatter\)$/,
      ),
    ])
  })
})
