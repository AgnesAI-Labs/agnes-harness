import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeModel, ScriptedProvider } from '@agnes/ai/testkit'
import { dataDir } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import type { Context } from '@agnes/plugin-runtime'
import { normalizePluginExport } from '@agnes/plugin-runtime/host'
import { AGH_DIR } from '@agnes/protocol'
import { scanSkills } from '@agnes/resource-control-worker'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { bootLocal } from '../src/boot/local.js'
import { savedSkillControlFile } from '../src/boot/local-skills.js'
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
  const start = async (): Promise<Booted> => {
    const booted = await bootLocal(parseArgs(['--cwd', workspace]), {
      env: { HOME: root },
      home,
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
  return {
    home,
    workspace,
    provider,
    logged,
    start,
    offered,
    workspaceSkills: join(workspace, AGH_DIR, 'skills'),
    userSkills: join(home, 'skills'),
  }
}

type Session = Awaited<ReturnType<Booted['client']['session']['new']>>
const turn = async (session: Session) => expect((await session.prompt('go')).reason).toBe('completed')

describe('a host embedded in the CLI offers the disk Skills a daemon worker would', () => {
  it('offers only the plugin Skills when no Skill folder exists', async () => {
    const t = await boot()
    const b = await t.start()
    try {
      await turn(await b.client.session.new({ cwd: t.workspace }))
      expect(t.offered()).toEqual(['plugin-skill'])
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
      const session = await b.client.session.new({ cwd: t.workspace })
      await turn(session)
      expect(t.offered()).toEqual(['from-claude-folder', 'personal', 'plugin-skill', 'pre-boot'])
    } finally {
      await b.close()
    }
  })

  it('offers a Skill written during a session to the next session, and to that session after refreshSkills', async () => {
    const t = await boot()
    const b = await t.start()
    try {
      const first = await b.client.session.new({ cwd: t.workspace, sessionKey: 'local-skills-first' })
      await turn(first)
      expect(t.offered()).toEqual(['plugin-skill'])
      skill(t.workspaceSkills, 'saved-later')
      await turn(first)
      expect(t.offered()).toEqual(['plugin-skill'])
      await turn(await b.client.session.new({ cwd: t.workspace, sessionKey: 'local-skills-second' }))
      expect(t.offered()).toEqual(['plugin-skill', 'saved-later'])
      skill(t.workspaceSkills, 'saved-last')
      b.refreshSkills?.()
      await turn(first)
      expect(t.offered()).toEqual(['plugin-skill', 'saved-last', 'saved-later'])
    } finally {
      await b.close()
    }
  })

  it('keeps a Skill the daemon saved as disabled off, and offers the others', async () => {
    const t = await boot()
    skill(t.workspaceSkills, 'switched-off')
    skill(t.workspaceSkills, 'still-on')
    const scan = await scanSkills(t.workspace, undefined, undefined, t.home, t.home, false)
    const off = scan.roots.flatMap((root) => root.candidates).find((c) => c.name === 'switched-off')
    if (!off) throw new Error('scan did not find the skill')
    const file = savedSkillControlFile(dataDir(t.home), 'local-dev')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        profile: 'local-dev',
        // An edited Skill keeps its decision: the saved revision is an older one.
        skills: {
          control: {
            priorities: {},
            removed: [],
            desired: [{ resourceId: off.resourceId, state: 'disabled' }],
            trust: [
              {
                resourceId: off.resourceId,
                revision: 'e'.repeat(64),
                capabilityHash: off.capabilityHash,
                state: 'trusted',
              },
            ],
          },
        },
        mcp: [],
        mcpAuthority: 'resource-control',
      }),
    )
    const b = await t.start()
    try {
      await turn(await b.client.session.new({ cwd: t.workspace }))
      expect(t.offered()).toEqual(['plugin-skill', 'still-on'])
    } finally {
      await b.close()
    }
  })

  it('sends a skipped Skill file to the boot log, not to the terminal', async () => {
    const t = await boot()
    skill(t.workspaceSkills, 'good')
    mkdirSync(join(t.workspaceSkills, 'broken'), { recursive: true })
    writeFileSync(join(t.workspaceSkills, 'broken', 'SKILL.md'), 'no frontmatter here\n')
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
      await turn(await b.client.session.new({ cwd: t.workspace }))
    } finally {
      for (const spy of spies) spy.mockRestore()
      await b?.close()
    }
    expect(writes).toEqual([])
    expect(t.offered()).toEqual(['good', 'plugin-skill'])
    expect(t.logged).toEqual([
      expect.stringMatching(
        /^host warn: agnes: Skill skill\/workspace\/\S+ skipped \(invalid-frontmatter\)$/,
      ),
    ])
  })

  it('offers no disk Skill when the saved decisions cannot be read', async () => {
    const t = await boot()
    skill(t.workspaceSkills, 'pre-boot')
    const file = savedSkillControlFile(dataDir(t.home), 'local-dev')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, '{"version":1,"skills":')
    const b = await t.start()
    try {
      await turn(await b.client.session.new({ cwd: t.workspace }))
      expect(t.offered()).toEqual(['plugin-skill'])
    } finally {
      await b.close()
    }
  })
})
