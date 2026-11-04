import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkillRoot, skillRoots } from '@agnes/base'
import {
  createResourceControlService,
  createSkillResourceStore,
  RESOURCE_ALL_PERMISSIONS,
} from '@agnes/resource-control-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readInstallBundle } from '../../host-extensions/src/resources/skill-install-files.js'
import { removeFilesystemSkill } from '../../resource-control-worker/src/skill-remove.js'
import { createRefinementSkillRequests } from '../src/supervisor/refinement-skill-requests.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const doc = (name: string, body: string) => `---\nname: ${name}\ndescription: Saved skill\n---\n${body}\n`
const draft = (name: string, body: string) => ({
  name,
  class: 'instructions',
  files: [{ path: 'SKILL.md', content: doc(name, body) }],
})
const source = {
  sessionKey: 'session',
  kind: 'skill',
  entryId: 'entry-1',
  contentHash: 'c'.repeat(64),
  initiator: 'auto',
}
const ADMIN = {
  audience: 'admin' as const,
  principalId: 'local',
  clientId: 'client',
  permissions: RESOURCE_ALL_PERMISSIONS,
}

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agnes-refine-skill-e2e-')))
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
  const handler = createRefinementSkillRequests({
    dataDir,
    profile: 'local-dev',
    agnesHome: home,
    service,
    workspace: (key) => (key === 'session' || key === 'ended' ? workspace : undefined),
    owner: (key) => (key === 'session' ? { active: true } : key === 'ended' ? { active: false } : undefined),
    enabled: () => enabled,
    pollMs: 5,
  })
  const save = (params: Record<string, unknown>, sessionKey = 'session') =>
    handler(sessionKey, params) as Promise<Record<string, unknown>>
  const get = (resourceId: string) =>
    service.call('_agnes/v1/resources.get', { profile: 'local-dev', resourceId }, ADMIN) as Promise<
      Record<string, unknown>
    >
  const folder = (name: string) => join(workspace, '.agh', 'skills', name)
  return {
    home,
    dataDir,
    workspace,
    call,
    save,
    get,
    folder,
    off: () => {
      enabled = false
    },
  }
}

describe('refinement skill saves in the daemon', () => {
  it('installs through real resource control without a turn or an approval', async () => {
    const s = setup()
    const out = await s.save({
      op: 'install',
      draft: draft('tidy-notes', 'One.'),
      receiptId: 'receipt-1',
      source,
    })
    expect(out).toMatchObject({ ok: true, authorizedBy: 'refinement-enabled' })
    const made = [...s.call.mock.calls]
    expect(await s.get(String(out.resourceId))).toMatchObject({
      revision: out.revision,
      trust: 'trusted',
      desired: 'enabled',
      actual: 'ready',
      resolution: { winner: true },
    })
    expect(readFileSync(join(s.folder('tidy-notes'), 'SKILL.md'), 'utf8')).toBe(doc('tidy-notes', 'One.'))
    // Its own principal, and only the methods it needs.
    expect(made.length).toBeGreaterThan(0)
    for (const [method, , authority] of made) {
      expect(authority?.principalId).toBe('system:refinement')
      expect(method).toMatch(
        /skills\.(refresh|trust\.set|remove)|resources\.(get|desired\.set|operation\.get|list)$/,
      )
    }
    expect(existsSync(join(s.home, 'skills'))).toBe(false)
  })

  it('does nothing while refinement is off, and takes the workspace from the session only', async () => {
    const s = setup()
    s.off()
    expect(
      await s.save({ op: 'install', draft: draft('tidy-notes', 'One.'), receiptId: 'r1', source }),
    ).toEqual({
      ok: false,
      reason: 'refinement-off',
    })
    expect(s.call).not.toHaveBeenCalled()
    expect(existsSync(join(s.workspace, '.agh'))).toBe(false)
    expect(existsSync(join(s.dataDir, 'refinement'))).toBe(false)
    await expect(
      s.save({ op: 'install', draft: draft('x', 'y'), receiptId: 'r1', source, workspaceRoot: '/elsewhere' }),
    ).rejects.toMatchObject({ message: 'INVALID_PARAMS' })
  })

  it('acts only for a live session: an unknown or ended one gets nothing', async () => {
    const s = setup()
    for (const key of ['nobody', 'ended'])
      expect(
        await s.save({ op: 'install', draft: draft('tidy-notes', 'One.'), receiptId: 'r1', source }, key),
        key,
      ).toEqual({ ok: false, reason: 'unavailable', code: 'SKILL_WORKSPACE_UNAVAILABLE' })
    expect(s.call).not.toHaveBeenCalled()
    expect(existsSync(join(s.workspace, '.agh'))).toBe(false)
  })

  it('refuses a name that a person already uses', async () => {
    const s = setup()
    mkdirSync(s.folder('mine'), { recursive: true })
    writeFileSync(join(s.folder('mine'), 'SKILL.md'), doc('mine', 'Hand written.'))
    expect(
      await s.save({ op: 'install', draft: draft('mine', 'Machine.'), receiptId: 'r1', source }),
    ).toMatchObject({
      ok: false,
      reason: 'static-check',
      code: 'SKILL_TARGET_CONFLICT',
    })
    expect(readFileSync(join(s.folder('mine'), 'SKILL.md'), 'utf8')).toBe(doc('mine', 'Hand written.'))
    expect(await s.save({ op: 'uninstall', name: 'mine' })).toMatchObject({
      ok: false,
      code: 'SKILL_NOT_INSTALLED_BY_REFINEMENT',
    })
    expect(existsSync(join(s.folder('mine'), 'SKILL.md'))).toBe(true)
  })

  it('updates through removal and reinstall, rolls back, and stops at a person’s edit', async () => {
    const s = setup()
    const one = await s.save({ op: 'install', draft: draft('tidy-notes', 'One.'), receiptId: 'r1', source })
    const two = await s.save({
      op: 'update',
      name: 'tidy-notes',
      draft: draft('tidy-notes', 'Two.'),
      expectedRevision: one.revision,
    })
    expect(two).toMatchObject({ ok: true, revision: expect.any(String) })
    expect(two.revision).not.toBe(one.revision)
    expect(await s.get(String(one.resourceId))).toMatchObject({ revision: two.revision, actual: 'ready' })
    expect(await s.save({ op: 'rollback', name: 'tidy-notes', toRevision: one.revision })).toEqual({
      ok: true,
      revision: one.revision,
    })
    expect(readFileSync(join(s.folder('tidy-notes'), 'SKILL.md'), 'utf8')).toBe(doc('tidy-notes', 'One.'))
    expect(await s.get(String(one.resourceId))).toMatchObject({ revision: one.revision, actual: 'ready' })
    // A person edits it: no update, no removal.
    writeFileSync(join(s.folder('tidy-notes'), 'SKILL.md'), doc('tidy-notes', 'Mine now.'))
    expect(
      await s.save({
        op: 'update',
        name: 'tidy-notes',
        draft: draft('tidy-notes', 'Three.'),
        expectedRevision: one.revision,
      }),
    ).toEqual({ ok: true, draft: 'changed-since' })
    expect(await s.save({ op: 'uninstall', name: 'tidy-notes' })).toMatchObject({
      ok: false,
      reason: 'conflict',
      code: 'SKILL_CHANGED_SINCE',
    })
    expect(readFileSync(join(s.folder('tidy-notes'), 'SKILL.md'), 'utf8')).toBe(
      doc('tidy-notes', 'Mine now.'),
    )
  })

  it('keeps a skill the review switched off disabled through an update unless asked to enable it', async () => {
    const s = setup()
    const one = await s.save({ op: 'install', draft: draft('tidy-notes', 'One.'), receiptId: 'r1', source })
    await s.save({ op: 'disable', name: 'tidy-notes', expectedRevision: one.revision })
    const two = await s.save({
      op: 'update',
      name: 'tidy-notes',
      draft: draft('tidy-notes', 'Two.'),
      expectedRevision: one.revision,
    })
    expect(two).toMatchObject({ ok: true, revision: expect.any(String) })
    expect(await s.get(String(one.resourceId))).toMatchObject({ revision: two.revision, desired: 'disabled' })
    expect(
      await s.save({ op: 'rollback', name: 'tidy-notes', toRevision: one.revision, enable: true }),
    ).toEqual({ ok: true, revision: one.revision })
    expect(await s.get(String(one.resourceId))).toMatchObject({
      revision: one.revision,
      desired: 'enabled',
      actual: 'ready',
    })
    await expect(
      s.save({ op: 'rollback', name: 'tidy-notes', toRevision: one.revision, enable: 'yes' }),
    ).rejects.toMatchObject({ message: 'INVALID_PARAMS' })
    // Only instructions: a script class is a malformed request.
    await expect(
      s.save({ op: 'install', draft: { ...draft('other', 'x'), class: 'script' }, receiptId: 'r2', source }),
    ).rejects.toMatchObject({ message: 'INVALID_PARAMS' })
  })

  it('uninstalls an unchanged saved skill with the careful removal', async () => {
    const s = setup()
    const one = await s.save({ op: 'install', draft: draft('tidy-notes', 'One.'), receiptId: 'r1', source })
    expect(await s.save({ op: 'disable', name: 'tidy-notes', expectedRevision: one.revision })).toEqual({
      ok: true,
    })
    expect(await s.get(String(one.resourceId))).toMatchObject({ desired: 'disabled' })
    expect(await s.save({ op: 'uninstall', name: 'tidy-notes' })).toEqual({ ok: true })
    expect(existsSync(s.folder('tidy-notes'))).toBe(false)
    expect(await s.save({ op: 'recover' })).toEqual({ ok: true, finished: 0 })
  })
})
