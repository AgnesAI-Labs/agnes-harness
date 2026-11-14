import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  type Stats,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultPrompts, Prompts } from '../../src/app/prompts.js'
import { createHookState, NOTICE_ORDER, POLICY_SECTION } from '../../src/runtime/hooks.js'
import { aghHome, PromptBinding, SkillFiles } from '../../src/runtime/prompt.js'
import { SessionRegistry } from '../../src/runtime/sessions.js'
import { tempStore, ticket } from './helpers.js'
import { hookHarness } from './hook-harness.js'

let temp: ReturnType<typeof tempStore>
beforeEach(() => {
  temp = tempStore()
})
afterEach(() => temp.close())

function setup(notes: Record<string, string> = {}, service: { unavailable?: string } = {}) {
  const prompts = new Prompts(
    temp.store,
    () => 100_000,
    () => undefined,
    () => false,
  )
  const registry = new SessionRegistry(temp.store)
  registry.record({ kind: 'orchestrator' }, 'superagent:orchestrator')
  registry.record({ kind: 'worker', ticketId: 't1' }, 'superagent:worker:t1')
  temp.store.tickets.save(
    ticket('t1', {
      mandate: {
        strength: 'inferred',
        policyVersion: '',
        basis: { via: 'listed', rules: ['r1'] },
        actor: { source: 'github', id: 'alice' },
        scope: '',
      },
    }),
  )
  const skills = join(temp.dir, 'agh', 'skills')
  const binding = new PromptBinding({
    prompts,
    store: temp.store,
    environment: () => [],
    skills: new SkillFiles(prompts, skills),
  })
  const hooks = hookHarness()
  hooks.cell.set(
    createHookState({
      registry,
      store: temp.store,
      unavailable: () => service.unavailable,
      prompt: binding,
      liveNote: (id) => (notes[id] ? { id: 'superagent-notices', content: notes[id]! } : undefined),
    }),
  )
  return { prompts, binding, hooks, skills }
}

describe('the Superagent prompt section', () => {
  it('rebuilds the section on every request from the revision, the composed team prompt and the mandate', () => {
    const { prompts, hooks } = setup()
    const first = hooks.context('superagent:worker:t1') as { refreshOnRequest: boolean; sections: unknown[] }
    const composed = prompts.compose(prompts.current().config, 'worker', [])
    expect(first).toEqual({
      refreshOnRequest: true,
      sections: [
        {
          id: 'superagent:policy',
          order: POLICY_SECTION.order,
          content: expect.stringMatching(/^\[dsh-superagent prompt revision 0\]\n/),
        },
      ],
    })
    const content = (first.sections[0] as { content: string }).content
    expect(content).toBe(
      `[dsh-superagent prompt revision 0]\n${composed}\nThis ticket has limited proactive authorization. Independently verify that it is a small change internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product decisions or clarification, stop and report dropped; do not expand scope.`,
    )
    // Unchanged content: the next request's section is byte for byte the same.
    expect(JSON.stringify(hooks.context('superagent:worker:t1'))).toBe(JSON.stringify(first))
  })

  it('carries a saved revision at the very next request, and binds each session to the revisions it worked under', () => {
    const { prompts, binding, hooks } = setup()
    hooks.context('superagent:orchestrator')
    hooks.context('superagent:worker:t1')
    prompts.save({ ...defaultPrompts(), communication: 'Answer in one sentence.' }, 0, 'panel')
    const next = hooks.context('superagent:orchestrator') as { sections: { content: string }[] }
    expect(next.sections[0]!.content).toMatch(/^\[dsh-superagent prompt revision 1\]\n/)
    expect(next.sections[0]!.content).toContain('Answer in one sentence.')
    expect(binding.promptVersion('superagent:orchestrator').revision).toBe(1)
    expect(binding.mayRead('superagent:orchestrator', 0)).toBe(true)
    // The worker has not made a request since: it works under revision 0 and may not read revision 1 yet.
    expect(binding.mayRead('superagent:worker:t1', 1)).toBe(false)
  })

  it("rolls the session's one live note forward after the stable section", () => {
    const { hooks } = setup({ 'superagent:orchestrator': 'Settings saved: policy' })
    expect((hooks.context('superagent:orchestrator') as { sections: unknown[] }).sections[1]).toEqual({
      id: 'superagent-notices',
      order: NOTICE_ORDER,
      content: 'Settings saved: policy',
      delivery: 'live-note',
    })
    expect((hooks.context('superagent:worker:t1') as { sections: unknown[] }).sections).toHaveLength(1)
  })

  it('keeps showing the live note while Superagent is not ready, so the platform never records it withdrawn', () => {
    const service: { unavailable?: string } = {}
    const { hooks } = setup({ 'superagent:orchestrator': 'Settings saved: policy' }, service)
    for (const reason of [
      'Superagent is starting',
      'Superagent is waiting for setup: The GitHub Source names no repository.',
      'Superagent is stopping',
    ]) {
      service.unavailable = reason
      expect(hooks.context('superagent:orchestrator'), reason).toEqual({
        refreshOnRequest: true,
        sections: [
          {
            id: 'superagent-notices',
            order: NOTICE_ORDER,
            content: 'Settings saved: policy',
            delivery: 'live-note',
          },
        ],
      })
    }
  })

  it("writes the revision's skills into the AGH home skill directory and rewrites them when it changes", () => {
    const { prompts, hooks, skills } = setup()
    mkdirSync(join(skills, 'dsh-superagent-mine'), { recursive: true })
    writeFileSync(join(skills, 'dsh-superagent-mine', 'SKILL.md'), 'owner')
    hooks.context('superagent:worker:t1')
    const github = readFileSync(join(skills, 'dsh-superagent-github', 'SKILL.md'), 'utf8')
    expect(github).toMatch(/^---\nname: dsh-superagent-github\ndescription: "Read GitHub issues/)
    prompts.save(
      { ...defaultPrompts(), skills: { deploy: 'Deploy with the release checklist.' } },
      0,
      'panel',
    )
    hooks.context('superagent:worker:t1')
    expect(readFileSync(join(skills, 'dsh-superagent-deploy', 'SKILL.md'), 'utf8')).toContain(
      'Deploy with the release checklist.',
    )
    prompts.save({ ...defaultPrompts() }, 1, 'panel')
    hooks.context('superagent:worker:t1')
    expect(existsSync(join(skills, 'dsh-superagent-deploy'))).toBe(false)
    // A skill directory Superagent did not write stays as it is.
    expect(readFileSync(join(skills, 'dsh-superagent-mine', 'SKILL.md'), 'utf8')).toBe('owner')
    expect(aghHome({ AGH_HOME: '/srv/agh', HOME: '/srv/user' })).toBe('/srv/agh')
    expect(aghHome({ HOME: '/srv/user' })).toBe(join('/srv/user', AGH_DIR))
  })

  it('leaves the skill files untouched when a later start finds them as they were, and replaces a changed one whole', () => {
    const { prompts, skills } = setup()
    const dir = join(skills, 'dsh-superagent-github')
    const skill = join(dir, 'SKILL.md')
    const mark = join(dir, '.superagent-revision')
    new SkillFiles(prompts, skills).write(prompts.current())
    const text = readFileSync(skill, 'utf8')
    const old = new Date('2020-01-01T00:00:00Z')
    for (const path of [skill, mark]) utimesSync(path, old, old)
    const first = { skill: statSync(skill), mark: statSync(mark) }
    const unchanged = (path: string, before: Stats) => {
      const now = statSync(path)
      expect({ ino: now.ino, mtimeMs: now.mtimeMs }, path).toEqual({
        ino: before.ino,
        mtimeMs: before.mtimeMs,
      })
    }
    // A new start, as after a re-enable: a new writer, the same revision and the same skills.
    new SkillFiles(prompts, skills).write(prompts.current())
    unchanged(skill, first.skill)
    unchanged(mark, first.mark)
    // A changed skill file is replaced by a rename (a new file, never a partial write), leaving no temporary file.
    writeFileSync(skill, 'stale')
    const stale = statSync(skill)
    new SkillFiles(prompts, skills).write(prompts.current())
    expect(readFileSync(skill, 'utf8')).toBe(text)
    expect(statSync(skill).ino).not.toBe(stale.ino)
    unchanged(mark, first.mark)
    expect(readdirSync(dir).sort()).toEqual(['.superagent-revision', 'SKILL.md'])
    // A new revision with the same skills rewrites only the mark.
    const current = statSync(skill)
    prompts.save({ ...defaultPrompts() }, prompts.current().revision, 'panel')
    expect(prompts.current().revision).toBeGreaterThan(0)
    new SkillFiles(prompts, skills).write(prompts.current())
    unchanged(skill, current)
    expect(readFileSync(mark, 'utf8')).toBe(`${prompts.current().revision}\n`)
    expect(statSync(mark).ino).not.toBe(first.mark.ino)
  })
})
