import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceSaveRequest } from '@agnes/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createSkillDraftStore } from '../../src/runtime/refinement/skill-drafts.js'
import { savedSkillFolderGone } from '../../src/runtime/refinement/skill-folders.js'
import { recordSkillRevocation } from '../../src/runtime/refinement/skill-review.js'
import { skillSender } from '../../src/runtime/refinement/skill-sender.js'
import type { WorkspaceSkills } from '../../src/runtime/refinement/skill-update.js'
import { createWorkspaceSave } from '../../src/runtime/refinement/workspace-save.js'
import { registryOf, skillDoc, skillWorkspace } from './skill-fixtures.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NAME = 'lint-fixer'
const TITLE = 'Fix lint errors before a commit'
const BODY = 'Run pnpm lint and fix what it reports.'
let commands = 0

/** A workspace with no saved skill yet, and the save path wired to the real installer. */
function setup() {
  const s = skillWorkspace(dirs)
  const now = { value: Date.UTC(2026, 10, 4) }
  const clock = () => now.value
  const switchState = { enabled: true, mode: 'auto' as const, revision: 'r1' }
  const drafts = createSkillDraftStore(s.dataDir)
  let transport: WorkspaceSkills['request'] = s.request
  const gone = (root: string, name: string) => savedSkillFolderGone(s.dataDir, root, name)
  const save = createWorkspaceSave({
    registry: () => registryOf(s.dataDir, s.workspace, clock),
    settings: () => ({ ...switchState }),
    memory: () => undefined,
    clock,
    skills: { request: (key, params) => transport(key, params), drafts, gone },
  })
  const request = (
    over: Partial<Omit<WorkspaceSaveRequest, 'entry'>> & {
      entry?: Partial<WorkspaceSaveRequest['entry']>
    } = {},
  ) => {
    const { entry, ...rest } = over
    return {
      initiator: 'auto',
      commandId: `cmd-${++commands}`,
      session: { key: 'session-1', lane: 'main', workspaceRoot: s.workspace, lastSeq: 40, child: false },
      settingsRevision: 'r1',
      evidenceSeqs: [4, 9],
      evidenceTurn: 1,
      confirmations: 2,
      runId: 'run-7',
      ...rest,
      entry: {
        kind: 'skill',
        id: NAME,
        version: 1,
        contentHash: 'core-hash',
        title: TITLE,
        content: BODY,
        applicability: 'session',
        ...entry,
      },
    } as WorkspaceSaveRequest
  }
  const record = (name = NAME) =>
    registryOf(s.dataDir, s.workspace)
      .read()
      .skills.find((k) => k.name === name)
  const ops = (op: string) => s.requests.filter((r) => r.params.op === op)
  return {
    ...s,
    /** The installer request as the daemon answers it. */
    send: s.request,
    now,
    switchState,
    save,
    request,
    record,
    ops,
    drafts: drafts(s.workspace),
    setTransport(next: WorkspaceSkills['request']) {
      transport = next
    },
  }
}

/** The user removes the saved skill on the skills page: resource control removes it, the page records it. */
async function userUninstall(s: ReturnType<typeof setup>, name = NAME) {
  const record = s.record(name)
  if (!record) throw new Error('not installed')
  await s.fake.resources('_agnes/v1/skills.remove', {
    resourceId: record.resourceId,
    expectedRevision: record.revision,
    commandId: 'user-remove',
  })
  recordSkillRevocation(registryOf(s.dataDir, s.workspace), {
    action: 'skill-uninstalled',
    resourceId: record.resourceId,
    revision: record.revision,
    actor: 'local-owner',
    at: s.now.value,
  })
}

describe('installing confirmed skills into the workspace', () => {
  it('an entry confirmed twice is installed, trusted and enabled without a turn or an approval', async () => {
    const s = setup()
    expect(await s.save.save(s.request({ confirmations: 1 }))).toMatchObject({ reason: 'unconfirmed' })
    expect(s.ops('install')).toEqual([])
    const receipt = await s.save.save(s.request())
    const record = s.record()
    expect(receipt).toMatchObject({
      outcome: 'installed',
      initiator: 'auto',
      target: { kind: 'skill', name: NAME, resourceId: record?.resourceId, revision: record?.revision },
    })
    expect(record).toMatchObject({ state: 'active', source: { sessionKey: 'session-1', entryId: NAME } })
    expect(readFileSync(join(s.skillDir(NAME), 'SKILL.md'), 'utf8')).toBe(
      skillDoc(NAME, JSON.stringify(TITLE), BODY),
    )
    const listed = s.fake.entries.get(record?.resourceId as string)
    expect(listed).toMatchObject({ trust: 'trusted', desired: 'enabled', removed: false })
    // Only the workspace: nothing under the user's home skill folders.
    expect(existsSync(join(s.home, 'skills'))).toBe(false)
    // The install went out for the requesting session with the receipt id it is kept under.
    expect(s.ops('install')).toHaveLength(1)
    expect(s.ops('install')[0]).toMatchObject({
      sessionKey: 'session-1',
      params: { receiptId: receipt.receiptId, source: { kind: 'skill', entryId: NAME } },
    })
  })

  it('a skill is instructions with a short description: a longer one is refused before anything is sent', async () => {
    const s = setup()
    const long = 'x'.repeat(201)
    expect(await s.save.save(s.request({ initiator: 'user', entry: { title: long } }))).toMatchObject({
      outcome: 'refused',
      reason: 'static-check',
    })
    expect(s.ops('install')).toEqual([])
    expect(existsSync(s.skillDir(NAME))).toBe(false)
  })

  it('a skill entry bound to an approved skill or plugin is never installed as a workspace skill', async () => {
    const s = setup()
    const bound = s.request({
      initiator: 'user',
      entry: { reference: `skill/user/plugin/abc@${'a'.repeat(64)}` },
    })
    expect(await s.save.save(bound)).toMatchObject({ outcome: 'refused', reason: 'static-check' })
    expect(s.ops('install')).toEqual([])
  })

  it("a person's skill of the same name elsewhere keeps the change as a draft for them", async () => {
    const s = setup()
    // The person's own skill in their user skill folder.
    const theirs = join(s.home, 'skills', NAME)
    mkdirSync(theirs, { recursive: true })
    writeFileSync(join(theirs, 'SKILL.md'), skillDoc(NAME, 'Mine', 'My own steps.'))
    const receipt = await s.save.save(s.request({ initiator: 'user' }))
    expect(receipt).toMatchObject({ outcome: 'refused', reason: 'conflict' })
    expect(existsSync(s.skillDir(NAME))).toBe(false)
    expect(s.drafts.list()).toEqual([
      expect.objectContaining({ name: NAME, reason: 'human-written', receiptId: receipt.receiptId }),
    ])
  })
})

describe('what the user took back wins', () => {
  it('a renamed entry with revoked content or a revoked skill name is refused as user-revoked', async () => {
    const s = setup()
    expect(await s.save.save(s.request())).toMatchObject({ outcome: 'installed' })
    await userUninstall(s)
    expect(existsSync(s.skillDir(NAME))).toBe(false)
    // The same skill again, from the same entry: refused for the model and for an automatic save.
    for (const initiator of ['auto', 'model'] as const)
      expect(await s.save.save(s.request({ initiator }))).toMatchObject({
        outcome: 'refused',
        reason: 'user-revoked',
      })
    // The same name with new content, from another session.
    expect(
      await s.save.save(
        s.request({
          initiator: 'model',
          session: { key: 'session-9', lane: 'main', workspaceRoot: s.workspace, lastSeq: 40, child: false },
          entry: { content: 'Run eslint instead.' },
        }),
      ),
    ).toMatchObject({ reason: 'user-revoked' })
    // The same content under a new name (spacing and case do not matter).
    expect(
      await s.save.save(
        s.request({
          initiator: 'model',
          entry: { id: 'lint-fixer-2', content: `  ${BODY.toUpperCase()}  ` },
        }),
      ),
    ).toMatchObject({ reason: 'user-revoked' })
    expect(await s.save.save(s.request({ entry: { id: 'lint-fixer-3', content: BODY } }))).toMatchObject({
      reason: 'user-revoked',
    })
    expect(s.ops('install')).toHaveLength(1)
    expect(existsSync(s.skillDir('lint-fixer-2'))).toBe(false)
  })

  it('install now by the user clears the revocation', async () => {
    const s = setup()
    expect(await s.save.save(s.request())).toMatchObject({ outcome: 'installed' })
    await userUninstall(s)
    expect(registryOf(s.dataDir, s.workspace).read().revocations).toHaveLength(1)
    const receipt = await s.save.save(s.request({ initiator: 'user' }))
    expect(receipt).toMatchObject({ outcome: 'installed' })
    expect(Object.fromEntries(receipt.steps.map((step) => [step.step, step.verdict]))).toMatchObject({
      revocation: 'pass',
    })
    expect(registryOf(s.dataDir, s.workspace).read().revocations).toEqual([])
    expect(s.record()).toMatchObject({ state: 'active' })
    // With the record cleared, a later automatic save of the same skill is no longer refused for it.
    expect(await s.save.save(s.request())).toMatchObject({ outcome: 'installed' })
  })

  it('a person deleting the saved skill folder counts as an uninstall', async () => {
    const s = setup()
    expect(await s.save.save(s.request())).toMatchObject({ outcome: 'installed' })
    rmSync(s.skillDir(NAME), { recursive: true })
    expect(
      await s.save.save(s.request({ initiator: 'model', entry: { content: 'Changed steps.' } })),
    ).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    const snapshot = registryOf(s.dataDir, s.workspace).read()
    expect(snapshot.skills.find((k) => k.name === NAME)?.state).toBe('uninstalled')
    expect(snapshot.revocations).toEqual([
      expect.objectContaining({ skillName: NAME, action: 'skill-uninstalled', entryId: NAME }),
    ])
    expect(existsSync(s.skillDir(NAME))).toBe(false)
  })

  it('the content of a skill whose folder a person deleted is barred under any other name too', async () => {
    const s = setup()
    expect(await s.save.save(s.request())).toMatchObject({ outcome: 'installed' })
    rmSync(s.skillDir(NAME), { recursive: true })
    expect(
      await s.save.save(s.request({ initiator: 'model', entry: { id: 'lint-fixer-copy', content: BODY } })),
    ).toMatchObject({ outcome: 'refused', reason: 'user-revoked' })
    expect(existsSync(s.skillDir('lint-fixer-copy'))).toBe(false)
  })

  it('a folder missing only because an interrupted update is not finished yet is not a deletion', async () => {
    const s = setup()
    expect(await s.save.save(s.request())).toMatchObject({ outcome: 'installed' })
    const save = createWorkspaceSave({
      registry: () => registryOf(s.dataDir, s.workspace),
      settings: () => ({ ...s.switchState }),
      memory: () => undefined,
      clock: () => s.now.value,
      skills: { request: s.send, drafts: createSkillDraftStore(s.dataDir), gone: () => false },
    })
    rmSync(s.skillDir(NAME), { recursive: true })
    expect(
      await save.save(s.request({ initiator: 'model', entry: { content: 'Changed.' } })),
    ).not.toMatchObject({
      reason: 'user-revoked',
    })
    expect(registryOf(s.dataDir, s.workspace).read().revocations).toEqual([])
  })
})

describe('the request to the installer', () => {
  it('an install cut off on the way is sent again with the same receipt id, and recovery runs once', async () => {
    const s = setup()
    const sent: Record<string, unknown>[] = []
    let failures = 1
    const transport = async (key: string, params: Record<string, unknown>) => {
      sent.push(structuredClone(params))
      if (params.op === 'install' && failures-- > 0) {
        // The daemon got the request and finished the install, but the reply was lost.
        await s.send(key, params)
        throw new Error('worker channel closed')
      }
      return s.send(key, params)
    }
    const enabled = { value: true }
    s.setTransport(skillSender(transport, { enabled: () => enabled.value }))
    const receipt = await s.save.save(s.request())
    expect(receipt).toMatchObject({ outcome: 'installed' })
    const installs = sent.filter((p) => p.op === 'install')
    expect(installs).toHaveLength(2)
    expect(installs[1]?.receiptId).toBe(installs[0]?.receiptId)
    expect(sent[0]).toEqual({ op: 'recover' })
    expect(sent.filter((p) => p.op === 'recover')).toHaveLength(1)
    // Off: no recovery is sent (the save path refuses before any request in any case).
    const off = skillSender(transport, { enabled: () => false })
    sent.length = 0
    await off('session-2', { op: 'uninstall', name: 'x' }).catch(() => undefined)
    expect(sent.filter((p) => p.op === 'recover')).toEqual([])
  })

  it('an update is never sent twice: a lost reply reads unavailable', async () => {
    const s = setup()
    expect(await s.save.save(s.request())).toMatchObject({ outcome: 'installed' })
    let updates = 0
    s.setTransport(
      skillSender(
        async (key, params) => {
          if (params.op === 'update') {
            updates++
            throw new Error('worker channel closed')
          }
          return s.send(key, params)
        },
        { enabled: () => true },
      ),
    )
    expect(await s.save.save(s.request({ entry: { content: 'Changed steps.' } }))).toMatchObject({
      outcome: 'refused',
      reason: 'unavailable',
    })
    expect(updates).toBe(1)
  })
})

describe('a saved skill folder a person deleted', () => {
  it('counts as gone only while the installer has no unfinished work on it', () => {
    const s = setup()
    mkdirSync(s.skillDir(NAME), { recursive: true })
    expect(savedSkillFolderGone(s.dataDir, s.workspace, NAME)).toBe(false)
    rmSync(s.skillDir(NAME), { recursive: true })
    expect(savedSkillFolderGone(s.dataDir, s.workspace, NAME)).toBe(true)
    // An update cut off between removing the old folder and publishing the new one.
    const journal = join(
      s.dataDir,
      'refinement',
      'skill-installs',
      createHash('sha256').update(s.workspace).digest('hex'),
    )
    mkdirSync(journal, { recursive: true })
    writeFileSync(join(journal, `${'1'.repeat(64)}.json`), JSON.stringify({ name: 'other-skill' }))
    expect(savedSkillFolderGone(s.dataDir, s.workspace, NAME)).toBe(true)
    writeFileSync(join(journal, `${'2'.repeat(64)}.json`), JSON.stringify({ name: NAME }))
    expect(savedSkillFolderGone(s.dataDir, s.workspace, NAME)).toBe(false)
    // A name no saved skill may have is never looked up.
    expect(savedSkillFolderGone(s.dataDir, s.workspace, '../x')).toBe(false)
  })

  it('a workspace, or its skill folder, that is not there is not a deletion', async () => {
    const s = setup()
    expect(await s.save.save(s.request())).toMatchObject({ outcome: 'installed' })
    // The whole skill folder is gone (an unmounted or moved workspace looks the same): cannot tell.
    rmSync(join(s.workspace, '.agh', 'skills'), { recursive: true })
    expect(savedSkillFolderGone(s.dataDir, s.workspace, NAME)).toBe(false)
    expect(savedSkillFolderGone(s.dataDir, join(s.workspace, 'moved'), NAME)).toBe(false)
    expect(
      await s.save.save(s.request({ initiator: 'model', entry: { content: 'Changed.' } })),
    ).not.toMatchObject({
      reason: 'user-revoked',
    })
    expect(registryOf(s.dataDir, s.workspace).read().revocations).toEqual([])
  })
})
