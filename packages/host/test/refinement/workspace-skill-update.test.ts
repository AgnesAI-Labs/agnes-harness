import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceSaveRequest } from '@agnes/core'
import { AGH_DIR } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSkillDraftStore,
  SKILL_DRAFTS_KEEP,
  skillDraftOf,
} from '../../src/runtime/refinement/skill-drafts.js'
import type { WorkspaceSkills } from '../../src/runtime/refinement/skill-update.js'
import { createWorkspaceSave } from '../../src/runtime/refinement/workspace-save.js'
import { registryOf, skillDoc, skillWorkspace } from './skill-fixtures.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NAME = 'lint-fixer'
const TITLE = 'Fix lint errors before a commit'
const V1 = 'Run pnpm lint and fix what it reports.'
const V2 = 'Run pnpm lint --fix first, then fix what is left by hand.'

const ENTRY: WorkspaceSaveRequest['entry'] = {
  kind: 'skill',
  id: NAME,
  version: 2,
  contentHash: 'core-hash',
  title: TITLE,
  content: V2,
  applicability: 'session',
}
let commands = 0

/** A workspace with an installed skill saved by refinement (unless `install: false`) and the save path. */
async function setup(o: { install?: boolean } = {}) {
  const s = skillWorkspace(dirs)
  const now = { value: Date.UTC(2026, 10, 4) }
  const clock = () => now.value
  const switchState = { enabled: true, mode: 'auto' as const, revision: 'r1' }
  const drafts = createSkillDraftStore(s.dataDir)
  let transport: WorkspaceSkills['request'] = s.request
  const save = createWorkspaceSave({
    registry: () => registryOf(s.dataDir, s.workspace, clock),
    settings: () => ({ ...switchState }),
    memory: () => undefined,
    clock,
    skills: { request: (key, params) => transport(key, params), drafts },
  })
  let v1Revision = ''
  if (o.install !== false) {
    const draft = skillDraftOf({ id: NAME, title: TITLE, content: V1 })
    if (!draft) throw new Error('no draft')
    const installed = await s.installer.install(draft, {
      workspaceRoot: s.workspace,
      receiptId: 'install-1',
      source: {
        sessionKey: 'session-0',
        kind: 'skill',
        entryId: NAME,
        contentHash: 'b'.repeat(64),
        initiator: 'auto',
      },
    })
    v1Revision = installed.revision
  }
  const request = (over: Partial<WorkspaceSaveRequest> = {}): WorkspaceSaveRequest => ({
    initiator: 'auto',
    commandId: `cmd-${++commands}`,
    session: { key: 'session-1', lane: 'main', workspaceRoot: s.workspace, lastSeq: 40, child: false },
    settingsRevision: 'r1',
    entry: ENTRY,
    evidenceSeqs: [4, 9],
    evidenceTurn: 1,
    confirmations: 2,
    runId: 'run-7',
    ...over,
  })
  const skillText = (name = NAME) => readFileSync(join(s.skillDir(name), 'SKILL.md'), 'utf8')
  const record = (name = NAME) =>
    registryOf(s.dataDir, s.workspace)
      .read()
      .skills.find((k) => k.name === name)
  return {
    ...s,
    /** The installer request as the daemon answers it. */
    send: s.request,
    now,
    switchState,
    save,
    drafts: drafts(s.workspace),
    request,
    skillText,
    record,
    v1Revision,
    setTransport(next: WorkspaceSkills['request']) {
      transport = next
    },
  }
}
type Setup = Awaited<ReturnType<typeof setup>>

const updates = (s: Setup) => s.requests.filter((r) => r.params.op === 'update')
const v1Doc = skillDoc(NAME, JSON.stringify(TITLE), V1)
const v2Doc = skillDoc(NAME, JSON.stringify(TITLE), V2)

describe('updating a skill refinement installed', () => {
  it('only an unmodified RSI skill is updated, once the new content was seen to hold', async () => {
    const s = await setup()
    expect(s.skillText()).toBe(v1Doc)
    // An automatic save needs the new content seen to hold first.
    expect(await s.save.save(s.request({ confirmations: 0 }))).toMatchObject({
      outcome: 'refused',
      reason: 'unconfirmed',
    })
    expect(updates(s)).toEqual([])
    expect(s.skillText()).toBe(v1Doc)
    // With refinement off nothing is asked and nothing is written.
    s.switchState.enabled = false
    expect(await s.save.save(s.request())).toMatchObject({ outcome: 'refused', reason: 'refinement-off' })
    expect(updates(s)).toEqual([])
    s.switchState.enabled = true

    const receipt = await s.save.save(s.request())
    const after = s.record()
    expect(receipt).toMatchObject({
      outcome: 'installed',
      initiator: 'auto',
      source: { sessionKey: 'session-1', kind: 'skill', entryId: NAME, runId: 'run-7' },
      target: { kind: 'skill', name: NAME, resourceId: after?.resourceId, revision: after?.revision },
    })
    expect(Object.fromEntries(receipt.steps.map((step) => [step.step, step.verdict]))).toMatchObject({
      switch: 'pass',
      revocation: 'pass',
      confirmations: 'pass',
      rules: 'pass',
    })
    expect(s.skillText()).toBe(v2Doc)
    // The update was asked against the revision refinement recorded, from the requesting session.
    expect(updates(s)).toEqual([
      {
        sessionKey: 'session-1',
        params: {
          op: 'update',
          name: NAME,
          draft: { name: NAME, class: 'instructions', files: [{ path: 'SKILL.md', content: v2Doc }] },
          expectedRevision: s.v1Revision,
          // The record's source follows the file: it is the entry this update wrote.
          source: receipt.source,
        },
      },
    ])
    expect(after).toMatchObject({ state: 'active' })
    expect(after?.revision).not.toBe(s.v1Revision)
    expect(after?.archive).toContain(s.v1Revision)
    expect(s.drafts.list()).toEqual([])
    // The receipt is kept in the registry like every other save.
    expect(registryOf(s.dataDir, s.workspace).read().receipts.at(-1)).toEqual(receipt)
    // The model or the user does not need the count.
    const v3 = `${V2} Commit only once lint is clean.`
    expect(
      await s.save.save(
        s.request({ initiator: 'model', confirmations: 0, entry: { ...ENTRY, version: 3, content: v3 } }),
      ),
    ).toMatchObject({ outcome: 'installed' })
    expect(s.skillText()).toBe(skillDoc(NAME, JSON.stringify(TITLE), v3))
  })

  it('a human edit between decision and write turns the update into a draft', async () => {
    const s = await setup()
    const edited = skillDoc(NAME, JSON.stringify(TITLE), 'Our team runs eslint by hand, never --fix.')
    // The decision is taken against the recorded revision; a person saves the file just before the write.
    s.setTransport(async (key, params) => {
      if (params.op === 'update') writeFileSync(join(s.skillDir(NAME), 'SKILL.md'), edited)
      return s.send(key, params)
    })
    const receipt = await s.save.save(s.request())
    expect(receipt).toMatchObject({ outcome: 'refused', reason: 'conflict' })
    expect(receipt.target).toBeUndefined()
    // The person's text is kept byte for byte, and the registry no longer matches it.
    expect(s.skillText()).toBe(edited)
    expect(s.record()).toMatchObject({ state: 'active', revision: s.v1Revision })
    const [draft, ...more] = s.drafts.list()
    expect(more).toEqual([])
    expect(draft).toMatchObject({
      name: NAME,
      reason: 'changed-since',
      base: edited,
      proposed: v2Doc,
      receiptId: receipt.receiptId,
      evidence: {
        sessionKey: 'session-1',
        entryId: NAME,
        entryVersion: 2,
        evidenceSeqs: [4, 9],
        runId: 'run-7',
        commandId: receipt.commandId,
        initiator: 'auto',
      },
    })
    expect(draft?.diff).toContain('-description: "Fix lint errors before a commit"')
    expect(draft?.diff).toContain('+Run pnpm lint --fix first, then fix what is left by hand.')
    expect(draft?.diff).toContain('-Our team runs eslint by hand, never --fix.')

    // From now on it is the person's skill: even the user's own save only drafts, and nothing is written.
    s.setTransport(s.send)
    const again = await s.save.save(s.request({ initiator: 'user', confirmations: 0 }))
    expect(again).toMatchObject({ outcome: 'refused', reason: 'conflict' })
    expect(s.skillText()).toBe(edited)
    expect(s.drafts.list()).toHaveLength(1)
    expect(s.drafts.list()[0]).toMatchObject({ receiptId: again.receiptId, base: edited })
  })

  it("another save that updated the skill first is a conflict, not a person's draft", async () => {
    const s = await setup()
    const other = skillDraftOf({ id: NAME, title: TITLE, content: 'Another process saved this first.' })
    if (!other) throw new Error('no draft')
    // A save in another process updates the skill between this decision and its write.
    s.setTransport(async (key, params) => {
      if (params.op === 'update') await s.installer.update(NAME, other, { revision: s.v1Revision })
      return s.send(key, params)
    })
    expect(await s.save.save(s.request())).toMatchObject({ outcome: 'refused', reason: 'conflict' })
    expect(s.skillText()).toBe(other.files[0]?.content)
    expect(s.drafts.list()).toEqual([])
  })

  it('the previous revision can be restored', async () => {
    const s = await setup()
    const updated = await s.save.save(s.request())
    expect(updated.outcome).toBe('installed')
    expect(s.skillText()).toBe(v2Doc)
    const record = s.record()
    if (!record) throw new Error('no record')
    // The revision the update replaced is kept, and one rollback brings it back exactly.
    const previous = record.archive.filter((revision) => revision !== record.revision).at(-1)
    expect(previous).toBe(s.v1Revision)
    expect(await s.installer.rollback(NAME, previous as string)).toEqual({ revision: s.v1Revision })
    expect(s.skillText()).toBe(v1Doc)
    expect(s.record()).toMatchObject({ revision: s.v1Revision, state: 'active' })
  })

  it('an update the review switched off stays off', async () => {
    const s = await setup()
    await s.installer.disable(NAME, { revision: s.v1Revision })
    expect(await s.save.save(s.request())).toMatchObject({ outcome: 'installed' })
    expect(s.skillText()).toBe(v2Doc)
    const record = s.record()
    expect(record).toMatchObject({ state: 'review-disabled' })
    expect(s.fake.entries.get(String(record?.resourceId))).toMatchObject({ desired: 'disabled' })
    expect(updates(s)[0]?.params).not.toHaveProperty('enable')
  })

  it('an update that adds code, or fails the static check, writes nothing and makes no candidate', async () => {
    const s = await setup()
    // A saved skill is its SKILL.md only: no script, no package, no second file ever comes from an entry.
    expect(skillDraftOf({ id: NAME, title: TITLE, content: 'scripts/run.py:\nprint(1)' })?.files).toEqual([
      { path: 'SKILL.md', content: skillDoc(NAME, JSON.stringify(TITLE), 'scripts/run.py:\nprint(1)') },
    ])
    // Text the installer's static check refuses (a control character).
    const hidden = await s.save.save(s.request({ entry: { ...ENTRY, content: 'Run lint \u0007 and fix.' } }))
    expect(hidden).toMatchObject({ outcome: 'refused', reason: 'static-check' })
    // A name or a description the skill catalogue cannot take is refused before anything is asked.
    for (const entry of [
      { ...ENTRY, id: 'Lint-Fixer' },
      { ...ENTRY, id: 'con' },
      { ...ENTRY, title: 'x'.repeat(201) },
    ])
      expect(await s.save.save(s.request({ entry }))).toMatchObject({
        outcome: 'refused',
        reason: 'static-check',
      })
    expect(updates(s)).toHaveLength(1)
    expect(s.skillText()).toBe(v1Doc)
    expect(s.record()).toMatchObject({ revision: s.v1Revision })
    expect(s.drafts.list()).toEqual([])
    // No plugin candidate, nothing published anywhere but the one skill folder.
    expect(readdirSync(join(s.workspace, AGH_DIR))).toEqual(['skills'])
    expect(readdirSync(join(s.workspace, AGH_DIR, 'skills'))).toEqual([NAME])
    expect(existsSync(join(s.home, 'profiles'))).toBe(false)
  })

  it('a human-written skill only gets a draft', async () => {
    const s = await setup({ install: false })
    const mine = skillDoc(NAME, 'Hand written', 'Lint the way the team agreed.')
    mkdirSync(s.skillDir(NAME), { recursive: true })
    writeFileSync(join(s.skillDir(NAME), 'SKILL.md'), mine)
    const theirs = skillDoc('house-style', 'Hand written', 'Follow the style guide.')
    mkdirSync(join(s.workspace, '.claude', 'skills', 'house-style'), { recursive: true })
    writeFileSync(join(s.workspace, '.claude', 'skills', 'house-style', 'SKILL.md'), theirs)
    for (const initiator of ['auto', 'model', 'user'] as const) {
      s.now.value += 1_000
      const receipt = await s.save.save(s.request({ initiator }))
      expect(receipt, initiator).toMatchObject({ outcome: 'refused', reason: 'conflict' })
    }
    s.now.value += 1_000
    const other = await s.save.save(s.request({ entry: { ...ENTRY, id: 'house-style' } }))
    expect(other).toMatchObject({ outcome: 'refused', reason: 'conflict' })
    // Nothing reached the installer and both files are untouched.
    expect(s.requests).toEqual([])
    expect(s.skillText()).toBe(mine)
    expect(readFileSync(join(s.workspace, '.claude', 'skills', 'house-style', 'SKILL.md'), 'utf8')).toBe(
      theirs,
    )
    // One draft per proposal: the same change asked three times is one draft, the latest receipt.
    const drafts = s.drafts.list()
    expect(drafts.map((draft) => [draft.name, draft.reason, draft.base])).toEqual([
      [NAME, 'human-written', mine],
      ['house-style', 'human-written', theirs],
    ])
    expect(drafts[0]?.evidence.initiator).toBe('user')
    expect(drafts[1]?.proposed).toBe(skillDoc('house-style', JSON.stringify(TITLE), V2))
    // A draft is a person's to take or drop.
    expect(s.drafts.discard(String(drafts[0]?.id))).toBe(true)
    expect(s.drafts.list().map((draft) => draft.name)).toEqual(['house-style'])
  })

  it('a draft never follows a link out of the workspace and the drafts kept are bounded', async () => {
    const s = await setup({ install: false })
    const outside = join(s.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'SKILL.md'), 'private text that is not a skill')
    mkdirSync(join(s.workspace, AGH_DIR, 'skills'), { recursive: true })
    symlinkSync(outside, s.skillDir(NAME), 'junction')
    const receipt = await s.save.save(s.request({ initiator: 'user' }))
    expect(receipt).toMatchObject({ outcome: 'refused', reason: 'conflict' })
    const [draft] = s.drafts.list()
    expect(draft).toMatchObject({ name: NAME, reason: 'human-written', base: null })
    expect(JSON.stringify(s.drafts.list())).not.toContain('private text')
    expect(s.requests).toEqual([])
    // Many different proposals keep only the newest ones.
    for (let i = 0; i < SKILL_DRAFTS_KEEP + 5; i++) {
      s.now.value += 1_000
      await s.save.save(s.request({ initiator: 'user', entry: { ...ENTRY, content: `${V2} (${i})` } }))
    }
    const kept = s.drafts.list()
    expect(kept).toHaveLength(SKILL_DRAFTS_KEEP)
    expect(kept.at(-1)?.proposed).toContain(`(${SKILL_DRAFTS_KEEP + 4})`)
    expect(kept.some((entry) => entry.receiptId === receipt.receiptId)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('a pipe in place of SKILL.md never holds the save up', async () => {
    const s = await setup({ install: false })
    mkdirSync(s.skillDir(NAME), { recursive: true })
    execFileSync('mkfifo', [join(s.skillDir(NAME), 'SKILL.md')])
    expect(await s.save.save(s.request({ initiator: 'user' }))).toMatchObject({ reason: 'conflict' })
    expect(s.drafts.list()).toMatchObject([{ name: NAME, reason: 'human-written', base: null }])
  })
})
