import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REVIEW_AFTER_MS,
  RefinementRegistry,
  type RegistrySkill,
} from '@agnes/host-infrastructure/refinement-registry'
import { afterEach, describe, expect, it } from 'vitest'
import {
  recordSkillRevocation,
  renewSkillForUser,
  reviewSkills,
  rollbackSkillForUser,
} from '../../src/runtime/refinement/skill-review.js'

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
    async disable(name: string, expected: { revision: string; reviewAfter?: number }) {
      calls.push(['disable', name, expected])
      if (changedByPerson.has(name)) throw Object.assign(new Error('x'), { code: 'SKILL_CHANGED_SINCE' })
      const r = registry()
      r.update((draft) => {
        const found = draft.skills.find((s) => s.name === name)
        if (!found) throw Object.assign(new Error('x'), { code: 'SKILL_NOT_INSTALLED_BY_REFINEMENT' })
        if (expected.reviewAfter !== undefined && found.reviewAfter !== expected.reviewAfter)
          throw Object.assign(new Error('x'), { code: 'SKILL_REVIEW_RENEWED' })
        found.state = 'review-disabled'
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
