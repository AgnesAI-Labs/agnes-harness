import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizedContentHash, REVIEW_AFTER_MS } from '@agnes/host-infrastructure/refinement-registry'
import { afterEach, describe, expect, it } from 'vitest'
import { skillDraftOf } from '../../src/runtime/refinement/skill-drafts.js'
import { rollbackSkillForUser } from '../../src/runtime/refinement/skill-review.js'
import { createWorkspaceRefs } from '../../src/runtime/refinement/workspace-refs.js'
import { registryOf, skillWorkspace } from './skill-fixtures.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NAME = 'lint-fixer'
const AT = { key: 'session-b', lane: 'main' }

/** A workspace with one skill refinement installed, and the confirmation adapter over it. */
async function setup() {
  const s = skillWorkspace(dirs)
  const now = { value: Date.UTC(2026, 10, 4) }
  const clock = () => now.value
  const draft = skillDraftOf({
    id: NAME,
    title: `Fix lint errors before a commit ${'and more '.repeat(30)}`.slice(0, 200),
    content: 'Run pnpm lint and fix what it reports.\nThen run it again.',
  })
  if (!draft) throw new Error('no draft')
  await s.installer.install(draft, {
    workspaceRoot: s.workspace,
    receiptId: 'install-1',
    source: {
      sessionKey: 'session-a',
      kind: 'skill',
      entryId: NAME,
      contentHash: 'b'.repeat(64),
      initiator: 'auto',
    },
  })
  const refs = createWorkspaceRefs({
    dataDir: s.dataDir,
    session: () => ({ workspaceRoot: s.workspace }),
    clock,
  })
  const file = join(s.skillDir(NAME), 'SKILL.md')
  const record = () =>
    registryOf(s.dataDir, s.workspace)
      .read()
      .skills.find((k) => k.name === NAME)
  return { ...s, now, refs, file, record }
}

describe('saved skills a plan may confirm', () => {
  it('lists an installed skill by its description and first line, at the hash of its SKILL.md', async () => {
    const t = await setup()
    const listed = await t.refs.list(AT)
    expect(listed).toEqual([
      {
        ref: `workspace-skill/${NAME}`,
        title: expect.stringMatching(/^Fix lint errors before a commit/u),
        summary: 'Run pnpm lint and fix what it reports.',
        version: normalizedContentHash(readFileSync(t.file, 'utf8')),
        source: { sessionKey: 'session-a', kind: 'skill', entryId: NAME },
      },
    ])
    expect(listed[0]?.title.length).toBeLessThanOrEqual(200)
  })

  it('renews only at the text the planner saw, and only a skill that is on and in force', async () => {
    const t = await setup()
    const [listed] = await t.refs.list(AT)
    if (!listed) throw new Error('not listed')
    const before = t.record()?.reviewAfter as number
    t.now.value += 86_400_000
    expect(await t.refs.renew(AT, listed.ref, 'f'.repeat(64))).toBe(false)
    expect(t.record()?.reviewAfter).toBe(before)
    expect(await t.refs.renew(AT, listed.ref, listed.version)).toBe(true)
    expect(t.record()?.reviewAfter).toBe(t.now.value + REVIEW_AFTER_MS)
    // A person's edit makes it another version: not renewed at the old one.
    writeFileSync(t.file, `${readFileSync(t.file, 'utf8')}Also check the types.\n`)
    expect(await t.refs.renew(AT, listed.ref, listed.version)).toBe(false)
    // Switched off by the review: neither listed nor renewed.
    const edited = (await t.refs.list(AT))[0]
    registryOf(t.dataDir, t.workspace).update((draft) => {
      const skill = draft.skills.find((k) => k.name === NAME)
      if (skill) skill.state = 'review-disabled'
    }, registryOf(t.dataDir, t.workspace).read().revision)
    expect(await t.refs.list(AT)).toEqual([])
    expect(await t.refs.renew(AT, `workspace-skill/${NAME}`, edited?.version as string)).toBe(false)
  })

  it('past its review date, or uninstalled, a skill is neither listed nor renewed', async () => {
    const t = await setup()
    const [listed] = await t.refs.list(AT)
    if (!listed) throw new Error('not listed')
    t.now.value = (t.record()?.reviewAfter as number) + 1
    expect(await t.refs.list(AT)).toEqual([])
    expect(await t.refs.renew(AT, listed.ref, listed.version)).toBe(false)
    t.now.value = Date.UTC(2026, 10, 5)
    await t.installer.uninstall(NAME)
    expect(await t.refs.list(AT)).toEqual([])
    expect(await t.refs.renew(AT, listed.ref, listed.version)).toBe(false)
  })

  it('after the user rolls a skill back, the version kept is listed and renewable at its text', async () => {
    const t = await setup()
    const v1 = t.record()?.revision as string
    const next = skillDraftOf({ id: NAME, title: 'Fix lint errors', content: 'Run pnpm lint --fix first.' })
    if (!next) throw new Error('no draft')
    expect(await t.installer.update(NAME, next, { revision: v1 })).toMatchObject({
      revision: expect.any(String),
    })
    await rollbackSkillForUser(registryOf(t.dataDir, t.workspace), t.installer, {
      name: NAME,
      toRevision: v1,
      actor: 'local',
      at: t.now.value,
    })
    expect(registryOf(t.dataDir, t.workspace).read().revocations).toEqual([
      expect.objectContaining({ action: 'skill-rolled-back' }),
    ])
    const [listed] = await t.refs.list(AT)
    expect(listed).toMatchObject({
      ref: `workspace-skill/${NAME}`,
      version: normalizedContentHash(readFileSync(t.file, 'utf8')),
      summary: 'Run pnpm lint and fix what it reports.',
    })
    t.now.value += 86_400_000
    expect(await t.refs.renew(AT, listed?.ref as string, listed?.version as string)).toBe(true)
    expect(t.record()?.reviewAfter).toBe(t.now.value + REVIEW_AFTER_MS)
  })
})
