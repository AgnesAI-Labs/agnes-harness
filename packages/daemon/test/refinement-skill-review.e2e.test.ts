import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkillRoot, skillRoots } from '@agnes/base'
import { createSkillDraftStore, REVIEW_AFTER_MS, RefinementRegistry } from '@agnes/host'
import {
  createResourceControlService,
  createSkillResourceStore,
  RESOURCE_ALL_PERMISSIONS,
} from '@agnes/resource-control-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readInstallBundle } from '../../host-extensions/src/resources/skill-install-files.js'
import { removeFilesystemSkill } from '../../resource-control-worker/src/skill-remove.js'
import { createSavedSkills } from '../src/supervisor/refinement-saved-skills.js'
import { createRefinementSkillRequests } from '../src/supervisor/refinement-skill-requests.js'

const DAY = 86_400_000
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const doc = (name: string, body: string) => `---\nname: ${name}\ndescription: Saved skill\n---\n${body}\n`
const draft = (name: string, body: string) => ({
  name,
  class: 'instructions' as const,
  files: [{ path: 'SKILL.md', content: doc(name, body) }],
})
const source = {
  sessionKey: 'session',
  kind: 'skill' as const,
  entryId: 'entry-1',
  contentHash: 'c'.repeat(64),
  initiator: 'auto' as const,
}
/** A person on the skills page (Web or TUI): the resource control endpoint's own authority. */
const USER = {
  audience: 'admin' as const,
  principalId: 'local',
  clientId: 'client',
  permissions: RESOURCE_ALL_PERMISSIONS,
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-skill-review-e2e-')))
  roots.push(root)
  const home = join(root, 'home')
  const dataDir = join(home, 'data')
  const workspace = join(root, 'workspace')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(workspace)
  const skillRoot = () => {
    const found = skillRoots({ workspaceRoot: workspace, osHomeDir: home, agnesHomeDir: home })[0]
    if (!found) throw new Error('missing workspace skill root')
    return found
  }
  const removal = {
    cwd: workspace,
    osHomeDir: home,
    agnesHomeDir: home,
    stateDirectory: join(dataDir, 'deletions'),
  }
  const store = createSkillResourceStore({
    directory: join(dataDir, 'resources'),
    scope: { allowedProfiles: ['local-dev'] },
    adapter: {
      validateRemove: ({ descriptor }) =>
        removeFilesystemSkill({ ...removal, descriptor, validateOnly: true }),
      remove: ({ descriptor }) => removeFilesystemSkill({ ...removal, descriptor }),
      refresh: async () => {
        const target = skillRoot()
        const control = await store.workerControl('local-dev')
        const out = []
        for (const name of existsSync(target.path) ? readdirSync(target.path) : []) {
          if (name.startsWith('.')) continue
          const { candidate: c } = await readInstallBundle(join(target.path, name), target, [], {
            discover: discoverSkillRoot,
          })
          const removed = control.removed.includes(c.resourceId)
          out.push({
            capabilityHash: c.capabilityHash,
            descriptor: {
              kind: 'skill' as const,
              resourceId: c.resourceId,
              name: c.name,
              description: c.description,
              revision: c.revision,
              sourceIdentity: c.sourceIdentity,
              priority: c.priority,
              resolution: { winner: !removed, shadowed: [] },
              trust: 'untrusted' as const,
              desired: 'disabled' as const,
              actual: removed ? ('unavailable' as const) : ('disabled' as const),
              stale: false,
              ...(c.workspaceId ? { workspaceId: c.workspaceId } : {}),
            },
          })
        }
        return out
      },
      reconcile: async ({ resources }) => {
        const removed = new Set((await store.workerControl('local-dev')).removed)
        return resources.map((r) => ({
          resourceId: r.resourceId,
          actual:
            r.desired === 'enabled' && r.trust === 'trusted' ? ('ready' as const) : ('disabled' as const),
          resolution: { winner: !removed.has(r.resourceId), shadowed: [] },
        }))
      },
    },
  })
  const service = createResourceControlService(store)
  const call = vi.spyOn(service, 'call')
  let enabled = true
  let now = Date.now()
  const bound: ((workspaceId: string, root: string) => void)[] = []
  const catalog = {
    onBound(listener: (workspaceId: string, root: string) => void) {
      bound.push(listener)
      return () => bound.splice(bound.indexOf(listener), 1)
    },
    list: async () => ({ items: [{ path: workspace, available: true }] }),
  }
  const start = () =>
    createSavedSkills({
      dataDir,
      profile: 'local-dev',
      agnesHome: home,
      service,
      catalog,
      enabled: () => enabled,
      clock: () => now,
      pollMs: 5,
    })
  const saved = start()
  const handler = createRefinementSkillRequests({
    dataDir,
    profile: 'local-dev',
    agnesHome: home,
    service,
    installers: saved.installers,
    workspace: () => workspace,
    owner: () => ({ active: true }),
    enabled: () => enabled,
    pollMs: 5,
  })
  const install = async (name: string, body = 'One.') => {
    const out = (await handler('session', {
      op: 'install',
      draft: draft(name, body),
      receiptId: `r-${name}-${body}`,
      source,
    })) as { ok: boolean; resourceId: string; revision: string }
    expect(out).toMatchObject({ ok: true })
    return out
  }
  const get = (resourceId: string) =>
    service.call('_agnes/v1/resources.get', { profile: 'local-dev', resourceId }, USER) as Promise<
      Record<string, unknown>
    >
  const settle = async (receipt: unknown) => {
    const { operationId } = receipt as { operationId: string }
    for (let i = 0; i < 400; i++) {
      const op = (await service.call(
        '_agnes/v1/resources.operation.get',
        { profile: 'local-dev', operationId },
        USER,
      )) as {
        state: string
      }
      if (['succeeded', 'failed', 'cancelled'].includes(op.state)) return op.state
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('operation did not settle')
  }
  /** A person's click on the skills page goes through the endpoint's service. */
  let command = 0
  const user = (method: string, params: Record<string, unknown>) =>
    saved.endpoint.call(
      method as never,
      { profile: 'local-dev', commandId: `user-${++command}`, clientId: 'client', ...params },
      USER,
    )
  const sessionOpens = async () => {
    for (const listener of [...bound]) listener(sha256(workspace), workspace)
    await saved.idle()
  }
  const registry = () => new RefinementRegistry(dataDir, workspace, () => now).read()
  const folder = (name: string) => join(workspace, '.agh', 'skills', name)
  return {
    dataDir,
    workspace,
    service,
    call,
    saved,
    start,
    handler,
    install,
    get,
    settle,
    user,
    sessionOpens,
    registry,
    folder,
    bound,
    later: (ms: number) => {
      now += ms
    },
    now: () => now,
    off: () => {
      enabled = false
    },
    on: () => {
      enabled = true
    },
  }
}

describe('the 30-day review of saved skills in the daemon', () => {
  it('an unconfirmed RSI skill is disabled, not removed, after 30 days, when a session opens', async () => {
    const s = setup()
    const old = await s.install('tidy-notes')
    s.later(20 * DAY)
    const recent = await s.install('fresh-notes')
    s.later(11 * DAY)
    await s.sessionOpens()
    expect(await s.get(old.resourceId)).toMatchObject({ desired: 'disabled', revision: old.revision })
    expect(existsSync(join(s.folder('tidy-notes'), 'SKILL.md'))).toBe(true)
    expect(await s.get(recent.resourceId)).toMatchObject({ desired: 'enabled', actual: 'ready' })
    expect(s.registry().skills.map((skill) => [skill.name, skill.state])).toEqual([
      ['tidy-notes', 'review-disabled'],
      ['fresh-notes', 'active'],
    ])
    // Review disable is not a revocation.
    expect(s.registry().revocations).toEqual([])
  })

  it('re-enabling it on the skills page renews it', async () => {
    const s = setup()
    const one = await s.install('tidy-notes')
    s.later(31 * DAY)
    await s.sessionOpens()
    expect(await s.get(one.resourceId)).toMatchObject({ desired: 'disabled' })
    s.later(DAY)
    expect(
      await s.settle(
        await s.user('_agnes/v1/resources.desired.set', {
          resourceId: one.resourceId,
          expectedRevision: one.revision,
          state: 'enabled',
        }),
      ),
    ).toBe('succeeded')
    expect(s.registry().skills[0]).toMatchObject({
      state: 'active',
      reviewAfter: s.now() + REVIEW_AFTER_MS,
    })
    expect(s.registry().revocations).toEqual([])
    // Not due again until the new date.
    s.later(29 * DAY)
    await s.sessionOpens()
    expect(await s.get(one.resourceId)).toMatchObject({ desired: 'enabled', actual: 'ready' })
  })

  it('a human-modified skill is never disabled by review', async () => {
    const s = setup()
    const one = await s.install('tidy-notes')
    const plain = await s.install('plain-notes')
    writeFileSync(join(s.folder('tidy-notes'), 'SKILL.md'), doc('tidy-notes', 'Mine now.'))
    s.later(31 * DAY)
    await s.sessionOpens()
    expect(await s.get(one.resourceId)).toMatchObject({ desired: 'enabled' })
    expect(s.registry().skills[0]).toMatchObject({ name: 'tidy-notes', state: 'active' })
    // The unchanged one next to it is switched off as usual.
    expect(await s.get(plain.resourceId)).toMatchObject({ desired: 'disabled' })
    expect(s.registry().skills[1]).toMatchObject({ name: 'plain-notes', state: 'review-disabled' })
  })

  it('does nothing while refinement is off; switching it on reviews the workspaces in use', async () => {
    const s = setup()
    const one = await s.install('tidy-notes')
    s.off()
    s.later(31 * DAY)
    s.call.mockClear()
    await s.sessionOpens()
    expect(s.call).not.toHaveBeenCalled()
    expect(s.registry().skills[0]).toMatchObject({ state: 'active' })
    s.on()
    s.saved.switchedOn()
    await s.saved.idle()
    expect(await s.get(one.resourceId)).toMatchObject({ desired: 'disabled' })
    expect(s.registry().skills[0]).toMatchObject({ state: 'review-disabled' })
  })
})

describe("the user's uninstall of a saved skill", () => {
  it('uninstall by the user is recorded and survives a restart', async () => {
    const s = setup()
    const one = await s.install('tidy-notes')
    s.later(DAY)
    const at = s.now()
    expect(
      await s.settle(
        await s.user('_agnes/v1/skills.remove', {
          resourceId: one.resourceId,
          expectedRevision: one.revision,
        }),
      ),
    ).toBe('succeeded')
    expect(existsSync(s.folder('tidy-notes'))).toBe(false)
    s.saved.close()
    // After a restart the record is still there and bars the same entry and the same name.
    const registry = new RefinementRegistry(s.dataDir, s.workspace, Date.now)
    expect(registry.read().revocations).toEqual([
      {
        sessionKey: 'session',
        kind: 'skill',
        entryId: 'entry-1',
        contentHash: 'c'.repeat(64),
        skillName: 'tidy-notes',
        action: 'skill-uninstalled',
        revision: one.revision,
        actor: 'local',
        at,
      },
    ])
    expect(registry.read().skills[0]).toMatchObject({ state: 'uninstalled' })
    expect(registry.revoked({ ...source, entryId: 'other' }, 'tidy-notes')).toBeDefined()
    expect(registry.revoked(source)).toBeDefined()
  })

  it("the installer's own rollback and uninstall, and the review, write no revocation", async () => {
    const s = setup()
    const one = await s.install('tidy-notes')
    const two = (await s.handler('session', {
      op: 'update',
      name: 'tidy-notes',
      draft: draft('tidy-notes', 'Two.'),
      expectedRevision: one.revision,
    })) as { revision: string }
    expect(
      await s.handler('session', { op: 'rollback', name: 'tidy-notes', toRevision: one.revision }),
    ).toEqual({ ok: true, revision: one.revision })
    expect(two.revision).not.toBe(one.revision)
    s.later(31 * DAY)
    await s.sessionOpens()
    expect(await s.handler('session', { op: 'uninstall', name: 'tidy-notes' })).toEqual({ ok: true })
    expect(s.registry().revocations).toEqual([])
    expect(s.registry().skills[0]).toMatchObject({ state: 'uninstalled' })
  })

  it('a skill refinement did not install is removed exactly as before, and the registry is never written', async () => {
    const s = setup()
    mkdirSync(s.folder('mine'), { recursive: true })
    writeFileSync(join(s.folder('mine'), 'SKILL.md'), doc('mine', 'Hand written.'))
    expect(
      await s.settle(
        await s.service.call(
          '_agnes/v1/skills.refresh',
          {
            profile: 'local-dev',
            rootKey: 'workspace-agnes',
            workspaceId: sha256(s.workspace),
            commandId: 'refresh-1',
            clientId: 'client',
          },
          USER,
        ),
      ),
    ).toBe('succeeded')
    const listed = (await s.service.call('_agnes/v1/resources.list', { profile: 'local-dev' }, USER)) as {
      items: { resourceId: string; name: string; revision: string }[]
    }
    const mine = listed.items.find((item) => item.name === 'mine')
    if (!mine) throw new Error('not listed')
    s.call.mockClear()
    // Methods other than the user's removal and re-enabling pass straight through.
    await s.saved.endpoint.call('_agnes/v1/resources.list', { profile: 'local-dev' }, USER)
    expect(s.call.mock.calls).toEqual([['_agnes/v1/resources.list', { profile: 'local-dev' }, USER]])
    s.call.mockClear()
    const params = {
      profile: 'local-dev',
      resourceId: mine.resourceId,
      expectedRevision: mine.revision,
      commandId: 'remove-1',
      clientId: 'client',
    }
    const receipt = await s.saved.endpoint.call('_agnes/v1/skills.remove', params, USER)
    expect(receipt).toMatchObject({ operationId: expect.any(String), state: 'received' })
    expect(await s.settle(receipt)).toBe('succeeded')
    expect(existsSync(s.folder('mine'))).toBe(false)
    // The user's call went through unchanged; the only other call was one read under refinement's own name.
    const calls = s.call.mock.calls.filter(([method]) => method !== '_agnes/v1/resources.operation.get')
    expect(calls).toEqual([
      ['_agnes/v1/resources.get', { profile: 'local-dev', resourceId: mine.resourceId }, expect.anything()],
      ['_agnes/v1/skills.remove', params, USER],
    ])
    expect(calls[0]?.[2]).toMatchObject({ principalId: 'system:refinement', permissions: ['resources.read'] })
    expect(existsSync(join(s.dataDir, 'refinement'))).toBe(false)
  })
})

describe("the owner's saved skills over the refinement.skills method", () => {
  it('lists the drafts kept for skills a person wrote, with the ids the draft store gives them', async () => {
    const t = setup()
    const kept = createSkillDraftStore(t.dataDir)(t.workspace).put({
      name: 'notes',
      reason: 'human-written',
      base: 'Mine.\n',
      proposed: 'Theirs.\n',
      receiptId: 'receipt-1',
      evidence: {
        sessionKey: 'session-1',
        entryId: 'entry-1',
        entryVersion: 1,
        contentHash: 'c'.repeat(64),
        evidenceSeqs: [1],
        commandId: 'command-1',
        initiator: 'user',
      },
      at: 5,
    })
    const listed = await t.saved.manage({ cwd: t.workspace }, 'local')
    expect(listed.drafts).toEqual([
      { id: kept.id, name: 'notes', reason: 'human-written', diff: kept.diff, at: 5 },
    ])
    expect(kept.id).toMatch(/^[a-f0-9]{32}$/)
  })

  it('lists saved skills with their state, rolls one back and uninstalls it, recording both', async () => {
    const t = setup()
    const first = await t.install('notes', 'One.')
    const second = (await t.handler('session', {
      op: 'update',
      name: 'notes',
      draft: draft('notes', 'Two.'),
      expectedRevision: first.revision,
    })) as { ok: boolean; revision: string }
    expect(second).toMatchObject({ ok: true })
    const listed = await t.saved.manage({ cwd: t.workspace }, 'local')
    expect(listed.skills).toEqual([
      expect.objectContaining({
        name: 'notes',
        revision: second.revision,
        state: 'active',
        initiator: 'auto',
        previous: [first.revision],
      }),
    ])
    expect(listed.drafts).toEqual([])
    // A workspace the daemon does not list is refused.
    await expect(t.saved.manage({ cwd: join(t.workspace, '..') }, 'local')).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    // Back to the previous revision: recorded as the user's rollback of the one it replaced.
    const rolled = await t.saved.manage({ cwd: t.workspace, action: 'rollback', name: 'notes' }, 'local')
    expect(rolled.skills[0]).toMatchObject({ revision: first.revision })
    expect(t.registry().revocations).toEqual([
      expect.objectContaining({
        skillName: 'notes',
        action: 'skill-rolled-back',
        revision: second.revision,
        actor: 'local',
      }),
    ])
    // Uninstalled: gone from the folder, no longer listed, and recorded.
    const gone = await t.saved.manage({ cwd: t.workspace, action: 'uninstall', name: 'notes' }, 'local')
    expect(gone.skills).toEqual([])
    expect(existsSync(t.folder('notes'))).toBe(false)
    expect(t.registry().revocations.map((r) => r.action)).toEqual(['skill-rolled-back', 'skill-uninstalled'])
    // Nothing left to act on.
    await expect(
      t.saved.manage({ cwd: t.workspace, action: 'uninstall', name: 'notes' }, 'local'),
    ).rejects.toMatchObject({ data: { reason: 'SKILL_NOT_INSTALLED_BY_REFINEMENT' } })
  })

  it('a skill with no earlier revision cannot be rolled back, and a person-changed one is left alone', async () => {
    const t = setup()
    await t.install('notes', 'One.')
    await expect(
      t.saved.manage({ cwd: t.workspace, action: 'rollback', name: 'notes' }, 'local'),
    ).rejects.toMatchObject({ data: { reason: 'SKILL_NO_EARLIER_REVISION' } })
    writeFileSync(join(t.folder('notes'), 'SKILL.md'), doc('notes', 'Changed by a person.'))
    await expect(
      t.saved.manage({ cwd: t.workspace, action: 'uninstall', name: 'notes' }, 'local'),
    ).rejects.toMatchObject({ data: { reason: 'SKILL_CHANGED_SINCE' } })
    expect(existsSync(t.folder('notes'))).toBe(true)
    expect(t.registry().revocations).toEqual([])
  })
})
