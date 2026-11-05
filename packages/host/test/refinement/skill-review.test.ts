import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistrySkill,
} from '@agnes/host-infrastructure/refinement-registry'
import { afterEach, describe, expect, it } from 'vitest'
import {
  enforceSkillCap,
  RSI_SKILL_CAP,
  recordSkillRevocation,
  renewSkillForUser,
  reviewSkills,
  rollbackSkillForUser,
} from '../../src/runtime/refinement/skill-review.js'
import { registryOf, skillDoc, skillWorkspace } from './skill-fixtures.js'

const DAY = 86_400_000
const T0 = 1_800_000_000_000
const WORKSPACE = '/work/space'
const REV = (n: number) => String(n).repeat(64).slice(0, 64)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-skill-review-'))
  dirs.push(dataDir)
  let now = T0
  const clock = () => now
  const registry = () => new RefinementRegistry(dataDir, WORKSPACE, clock)
  const skill = (name: string, patch: Partial<RegistrySkill> = {}): RegistrySkill => ({
    name,
    resourceId: `skill/workspace/workspace-agnes/${name.padEnd(64, '0').slice(0, 64)}`,
    revision: REV(1),
    source: {
      sessionKey: 'session-1',
      kind: 'skill',
      entryId: `entry-${name}`,
      contentHash: 'c'.repeat(64),
      initiator: 'auto',
    },
    reviewAfter: T0 + REVIEW_AFTER_MS,
    state: 'active',
    archive: [REV(1)],
    ...patch,
  })
  const seed = (...skills: RegistrySkill[]) => {
    const r = registry()
    r.update((draft) => {
      draft.skills.push(...skills)
    }, r.read().revision)
  }
  const record = (name: string) =>
    registry()
      .read()
      .skills.find((s) => s.name === name)
  /** The installer as the review sees it: it switches the skill off and records `review-disabled`. */
  const calls: unknown[][] = []
  const changedByPerson = new Set<string>()
  const installer = {
    async disable(name: string, expected: { revision: string; reviewAfter?: number }, reason?: 'capacity') {
      calls.push(['disable', name, expected, ...(reason === undefined ? [] : [reason])])
      if (changedByPerson.has(name)) throw Object.assign(new Error('x'), { code: 'SKILL_CHANGED_SINCE' })
      const r = registry()
      r.update((draft) => {
        const found = draft.skills.find((s) => s.name === name)
        if (!found) throw Object.assign(new Error('x'), { code: 'SKILL_NOT_INSTALLED_BY_REFINEMENT' })
        if (expected.reviewAfter !== undefined && found.reviewAfter !== expected.reviewAfter)
          throw Object.assign(new Error('x'), { code: 'SKILL_REVIEW_RENEWED' })
        found.state = 'review-disabled'
        if (reason === 'capacity') found.disabledFor = 'capacity'
      }, r.read().revision)
    },
    async rollback(name: string, toRevision: string) {
      calls.push(['rollback', name, toRevision])
      const r = registry()
      r.update((draft) => {
        const found = draft.skills.find((s) => s.name === name)
        if (found) found.revision = toRevision
      }, r.read().revision)
      return { revision: toRevision }
    },
  }
  return {
    dataDir,
    registry,
    seed,
    skill,
    record,
    installer,
    calls,
    changedByPerson,
    at: (time: number) => {
      now = time
    },
  }
}

describe('the 30-day review of saved skills', () => {
  it('an unconfirmed RSI skill is disabled, not removed, after 30 days', async () => {
    const s = setup()
    s.seed(s.skill('tidy-notes'))
    await reviewSkills(s.registry(), s.installer, T0 + REVIEW_AFTER_MS - 1)
    await reviewSkills(s.registry(), s.installer, T0 + REVIEW_AFTER_MS)
    expect(s.calls).toEqual([])
    await reviewSkills(s.registry(), s.installer, T0 + REVIEW_AFTER_MS + 1)
    // Only `disable` is ever asked for, at the revision and review date the registry holds.
    expect(s.calls).toEqual([
      ['disable', 'tidy-notes', { revision: REV(1), reviewAfter: T0 + REVIEW_AFTER_MS }],
    ])
    expect(s.record('tidy-notes')).toMatchObject({ state: 'review-disabled', revision: REV(1) })
    // Once switched off it is not asked again.
    await reviewSkills(s.registry(), s.installer, T0 + 40 * DAY)
    expect(s.calls).toHaveLength(1)
  })

  it('re-enabling renews it', async () => {
    const s = setup()
    const tidy = s.skill('tidy-notes')
    s.seed(tidy)
    await reviewSkills(s.registry(), s.installer, T0 + 31 * DAY)
    expect(s.record('tidy-notes')?.state).toBe('review-disabled')
    expect(renewSkillForUser(s.registry(), tidy.resourceId, REV(1), T0 + 32 * DAY)).toBe(true)
    expect(s.record('tidy-notes')).toMatchObject({
      state: 'active',
      reviewAfter: T0 + 32 * DAY + REVIEW_AFTER_MS,
    })
    expect(s.registry().read().revocations).toEqual([])
    await reviewSkills(s.registry(), s.installer, T0 + 33 * DAY)
    expect(s.calls).toHaveLength(1)
    // Not ours, or changed by a person since: nothing is renewed.
    expect(renewSkillForUser(s.registry(), tidy.resourceId, REV(2), T0 + 33 * DAY)).toBe(false)
    expect(
      renewSkillForUser(s.registry(), 'skill/workspace/workspace-agnes/other', REV(1), T0 + 33 * DAY),
    ).toBe(false)
  })

  it('a human-modified skill is never disabled by review, and the others still are', async () => {
    const s = setup()
    s.seed(s.skill('edited'), s.skill('plain'))
    s.changedByPerson.add('edited')
    await reviewSkills(s.registry(), s.installer, T0 + 31 * DAY)
    expect(s.record('edited')?.state).toBe('active')
    expect(s.record('plain')?.state).toBe('review-disabled')
  })

  it('a confirmation that renewed the skill meanwhile keeps it on', async () => {
    const s = setup()
    s.seed(s.skill('tidy-notes'))
    const stale = s.registry()
    const snapshot = stale.read()
    // Renewed after the review read the registry, before it acted.
    s.at(T0 + 31 * DAY)
    s.registry().renew({ skillName: 'tidy-notes' })
    const reading = Object.assign(Object.create(stale), { read: () => snapshot })
    await reviewSkills(reading, s.installer, T0 + 31 * DAY)
    expect(s.record('tidy-notes')).toMatchObject({ state: 'active', reviewAfter: T0 + 61 * DAY })
  })

  it('does nothing when the registry cannot be read', async () => {
    const s = setup()
    s.seed(s.skill('tidy-notes'))
    const file = join(s.dataDir, 'refinement', 'workspaces')
    const [name] = readdirSync(file)
    writeFileSync(join(file, String(name)), '{broken')
    await reviewSkills(s.registry(), s.installer, T0 + 40 * DAY)
    expect(s.calls).toEqual([])
  })

  it('review disable is not a revocation', async () => {
    const s = setup()
    const tidy = s.skill('tidy-notes')
    s.seed(tidy)
    await reviewSkills(s.registry(), s.installer, T0 + 31 * DAY)
    expect(s.registry().read().revocations).toEqual([])
    expect(s.registry().revoked(tidy.source, 'tidy-notes')).toBeUndefined()
  })
})

describe('what the user took back', () => {
  it('uninstall by the user is recorded and survives a restart', () => {
    const s = setup()
    const tidy = s.skill('tidy-notes', { revision: REV(2) })
    s.seed(tidy)
    const written = recordSkillRevocation(s.registry(), {
      action: 'skill-uninstalled',
      resourceId: tidy.resourceId,
      revision: REV(2),
      actor: 'local-owner',
      at: T0 + 3 * DAY,
    })
    expect(written).toBe(true)
    // A new registry over the same files, as after a restart.
    const reopened = new RefinementRegistry(s.dataDir, WORKSPACE, () => T0 + 9 * DAY)
    expect(reopened.read().revocations).toEqual([
      {
        sessionKey: 'session-1',
        kind: 'skill',
        entryId: 'entry-tidy-notes',
        contentHash: 'c'.repeat(64),
        skillName: 'tidy-notes',
        action: 'skill-uninstalled',
        revision: REV(2),
        actor: 'local-owner',
        at: T0 + 3 * DAY,
      },
    ])
    expect(reopened.read().skills[0]?.state).toBe('uninstalled')
    // The same lineage and the same name are refused from now on.
    expect(reopened.revoked({ ...tidy.source, entryId: 'renamed' }, 'Tidy-Notes')).toMatchObject({
      action: 'skill-uninstalled',
    })
    expect(reopened.revoked({ ...tidy.source, contentHash: 'd'.repeat(64) })).toBeDefined()
    // Asked again (a retried request): still one record.
    recordSkillRevocation(reopened, {
      action: 'skill-uninstalled',
      resourceId: tidy.resourceId,
      revision: REV(2),
      actor: 'local-owner',
      at: T0 + 4 * DAY,
    })
    expect(reopened.read().revocations).toHaveLength(1)
  })

  it('a skill refinement did not install leaves the registry alone', () => {
    const s = setup()
    expect(
      recordSkillRevocation(s.registry(), {
        action: 'skill-uninstalled',
        resourceId: 'skill/workspace/workspace-agnes/someone-else',
        revision: REV(1),
        actor: 'local-owner',
        at: T0,
      }),
    ).toBe(false)
    expect(existsSync(join(s.dataDir, 'refinement'))).toBe(false)
  })

  it('a rollback by the user is recorded with the revision it replaced; the installer alone records none', async () => {
    const s = setup()
    const tidy = s.skill('tidy-notes', { revision: REV(2), archive: [REV(1), REV(2)] })
    s.seed(tidy)
    // The installer's own rollback (a system step) writes no revocation.
    await s.installer.rollback('tidy-notes', REV(1))
    expect(s.registry().read().revocations).toEqual([])
    await s.installer.rollback('tidy-notes', REV(2))
    expect(
      await rollbackSkillForUser(s.registry(), s.installer, {
        name: 'tidy-notes',
        toRevision: REV(1),
        actor: 'local-owner',
        at: T0 + 5 * DAY,
      }),
    ).toEqual({ revision: REV(1) })
    expect(s.registry().read().revocations).toEqual([
      expect.objectContaining({
        entryId: 'entry-tidy-notes',
        skillName: 'tidy-notes',
        action: 'skill-rolled-back',
        revision: REV(2),
        actor: 'local-owner',
        at: T0 + 5 * DAY,
      }),
    ])
    // Rolled back, still installed: the record stays live at the restored revision.
    expect(s.record('tidy-notes')).toMatchObject({ state: 'active', revision: REV(1) })
  })

  it('a rollback that fails records nothing', async () => {
    const s = setup()
    s.seed(s.skill('tidy-notes'))
    const failing = {
      rollback: async () => {
        throw Object.assign(new Error('x'), { code: 'SKILL_CHANGED_SINCE' })
      },
    }
    await expect(
      rollbackSkillForUser(s.registry(), failing, {
        name: 'tidy-notes',
        toRevision: REV(3),
        actor: 'me',
        at: T0,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_CHANGED_SINCE' })
    expect(s.registry().read().revocations).toEqual([])
  })
})

describe('the cap on saved skills in force in a workspace', () => {
  const names = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => `skill-${String(from + i).padStart(2, '0')}`)

  it('installing the 21st RSI skill disables the one with the earliest review date', async () => {
    const dirs: string[] = []
    try {
      const s = skillWorkspace(dirs)
      const source = (name: string) => ({
        sessionKey: 'session-a',
        kind: 'skill' as const,
        entryId: name,
        contentHash: 'b'.repeat(64),
        initiator: 'auto' as const,
      })
      const draft = (name: string) => ({
        name,
        class: 'instructions' as const,
        files: [{ path: 'SKILL.md', content: skillDoc(name, 'Saved skill', `Steps for ${name}.`) }],
      })
      // A person's own skill in the same folder is never counted or touched.
      mkdirSync(s.skillDir('mine'), { recursive: true })
      writeFileSync(join(s.skillDir('mine'), 'SKILL.md'), skillDoc('mine', 'My skill', 'Mine.'))
      for (const name of names(RSI_SKILL_CAP))
        await s.installer.install(draft(name), {
          workspaceRoot: s.workspace,
          receiptId: name,
          source: source(name),
        })
      const registry = registryOf(s.dataDir, s.workspace)
      // Review dates in a known order, all before the next install's: skill-07 is the one least
      // recently confirmed.
      const base = Date.now()
      registry.update((records) => {
        records.skills.forEach((skill, i) => {
          skill.reviewAfter = base + (skill.name === 'skill-07' ? 0 : i + 1) * DAY
        })
      }, registry.read().revision)
      await enforceSkillCap(registry, s.installer, base)
      expect(registry.read().skills.filter((skill) => skill.state === 'active')).toHaveLength(RSI_SKILL_CAP)
      const [last] = names(1, RSI_SKILL_CAP)
      await s.installer.install(draft(last as string), {
        workspaceRoot: s.workspace,
        receiptId: last as string,
        source: source(last as string),
      })
      const before = registry.read().receipts.length
      await enforceSkillCap(registry, s.installer, Date.now())
      const after = registry.read()
      const off = after.skills.find((skill) => skill.name === 'skill-07')
      expect(off).toMatchObject({ state: 'review-disabled', disabledFor: 'capacity' })
      expect(after.skills.filter((skill) => skill.state === 'active')).toHaveLength(RSI_SKILL_CAP)
      expect(existsSync(join(s.skillDir('skill-07'), 'SKILL.md'))).toBe(true)
      expect(s.fake.entries.get(off?.resourceId as string)).toMatchObject({ desired: 'disabled' })
      expect(existsSync(join(s.skillDir('mine'), 'SKILL.md'))).toBe(true)
      expect(after.skills.some((skill) => skill.name === 'mine')).toBe(false)
      // Each capacity disable leaves a receipt in the registry; no revocation.
      expect(after.receipts.slice(before)).toEqual([
        expect.objectContaining({
          outcome: 'refused',
          target: expect.objectContaining({ kind: 'skill', name: 'skill-07' }),
        }),
      ])
      expect(after.revocations).toEqual([])
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('a workspace with 25 active RSI skills keeps 20 after a session opens', async () => {
    const s = setup()
    s.seed(
      ...names(25).map((name, i) => s.skill(name, { reviewAfter: T0 + REVIEW_AFTER_MS + (25 - i) * DAY })),
    )
    await reviewSkills(s.registry(), s.installer, T0)
    const read = s.registry().read().skills
    expect(read.filter((skill) => skill.state === 'active')).toHaveLength(RSI_SKILL_CAP)
    // The five confirmed longest ago, the last five seeded, are switched off for capacity.
    expect(
      read
        .filter((skill) => skill.disabledFor === 'capacity')
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(names(5, 20))
    expect(s.calls.every((call) => call[3] === 'capacity')).toBe(true)
    // Nothing more to do the next time.
    await reviewSkills(s.registry(), s.installer, T0)
    expect(s.calls).toHaveLength(5)
  })

  it('a skill a person re-enabled is never disabled for capacity, so the count may exceed 20', async () => {
    const s = setup()
    s.seed(
      ...names(RSI_SKILL_CAP).map((name) => s.skill(name, { reviewAfter: T0 + 100 * DAY })),
      s.skill('kept', { state: 'review-disabled', disabledFor: 'capacity', reviewAfter: T0 }),
    )
    const kept = s.record('kept') as RegistrySkill
    expect(renewSkillForUser(s.registry(), kept.resourceId, REV(1), T0)).toBe(true)
    expect(s.record('kept')).toMatchObject({ state: 'active', enabledBy: 'person' })
    expect(s.record('kept')).not.toHaveProperty('disabledFor')
    // Its review date is now the earliest of all, and still it is not the one switched off.
    await enforceSkillCap(s.registry(), s.installer, T0)
    expect(s.calls).toEqual([])
    s.seed(s.skill('one-more', { reviewAfter: T0 + 200 * DAY }))
    await enforceSkillCap(s.registry(), s.installer, T0)
    expect(s.calls.map((call) => call[1])).toEqual(['skill-00'])
    expect(s.record('kept')?.state).toBe('active')
    expect(
      s
        .registry()
        .read()
        .skills.filter((skill) => skill.state === 'active'),
    ).toHaveLength(RSI_SKILL_CAP + 1)
  })

  it('a confirmation does not re-enable a capacity-disabled skill', async () => {
    const s = setup()
    s.seed(s.skill('tidy-notes', { state: 'review-disabled', disabledFor: 'capacity' }))
    s.at(T0 + DAY)
    s.registry().renew({ skillName: 'tidy-notes' })
    expect(s.record('tidy-notes')).toMatchObject({
      state: 'review-disabled',
      disabledFor: 'capacity',
      reviewAfter: T0 + DAY + REVIEW_AFTER_MS,
    })
    await enforceSkillCap(s.registry(), s.installer, T0 + DAY)
    await reviewSkills(s.registry(), s.installer, T0 + DAY)
    expect(s.record('tidy-notes')?.state).toBe('review-disabled')
  })

  it('a skill a person changed is passed over and the next one is switched off instead', async () => {
    const s = setup()
    s.seed(...names(RSI_SKILL_CAP + 1).map((name, i) => s.skill(name, { reviewAfter: T0 + (i + 1) * DAY })))
    s.changedByPerson.add('skill-00')
    await enforceSkillCap(s.registry(), s.installer, T0)
    expect(s.record('skill-00')?.state).toBe('active')
    expect(s.record('skill-01')).toMatchObject({ state: 'review-disabled', disabledFor: 'capacity' })
  })

  it('does nothing when the registry cannot be read', async () => {
    const s = setup()
    s.seed(...names(RSI_SKILL_CAP + 1).map((name) => s.skill(name)))
    const file = join(s.dataDir, 'refinement', 'workspaces')
    const [name] = readdirSync(file)
    writeFileSync(join(file, String(name)), '{broken')
    await enforceSkillCap(s.registry(), s.installer, T0)
    expect(s.calls).toEqual([])
  })
})
