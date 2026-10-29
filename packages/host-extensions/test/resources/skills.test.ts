import { describe, expect, it, vi } from 'vitest'
import { createExtensionActivationBarrier } from '../../src/ext-host/activation-barrier.js'
import { createSkillCandidateRegistry, type SkillCandidate } from '../../src/resources/skills.js'

const candidate = (overrides: Partial<SkillCandidate> = {}): SkillCandidate => ({
  resourceId: `skill/workspace/workspace-agnes/${'a'.repeat(64)}`,
  name: 'review',
  description: 'Review changes',
  revision: 'b'.repeat(64),
  capabilityHash: 'c'.repeat(64),
  sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'a'.repeat(64) },
  priority: 500,
  body: 'private skill body',
  ...overrides,
})
const activate = (registry: ReturnType<typeof createSkillCandidateRegistry>, id = 'skills-1') =>
  registry.activate(id, async () => undefined)

describe('skill candidate registry', () => {
  it('keeps LKG after a root failure, publishes only after activation, and never exposes path or body in actual state', async () => {
    const registry = createSkillCandidateRegistry({ barrier: createExtensionActivationBarrier() })
    const skill = candidate()
    registry.replaceRoot('workspace-agnes', [skill])
    registry.setControl({
      desired: [{ resourceId: skill.resourceId, state: 'enabled' }],
      trust: [
        {
          resourceId: skill.resourceId,
          revision: skill.revision,
          capabilityHash: skill.capabilityHash,
          state: 'trusted',
        },
      ],
    })
    expect(registry.actual()).toEqual([])
    await activate(registry)
    registry.failRoot('workspace-agnes', new Error('/private/path private skill body'))
    await activate(registry, 'skills-2')
    expect(registry.actual()).toMatchObject([{ resourceId: skill.resourceId, actual: 'ready', stale: true }])
    expect(JSON.stringify(registry.actual())).not.toContain('/private/path')
    expect(JSON.stringify(registry.actual())).not.toContain('private skill body')
    expect(registry.read(skill.resourceId, { sessionKey: 's' })).toEqual(
      expect.objectContaining({
        ok: true,
        content: 'private skill body',
      }),
    )

    // The durable LKG supplies only a prior body. Current control still wins, so an intervening
    // remove/disable cannot be undone when a later root scan fails.
    registry.setControl({
      desired: [{ resourceId: skill.resourceId, state: 'disabled' }],
      trust: [
        {
          resourceId: skill.resourceId,
          revision: skill.revision,
          capabilityHash: skill.capabilityHash,
          state: 'trusted',
        },
      ],
    })
    await activate(registry, 'skills-3')
    expect(registry.actual()).toMatchObject([
      { resourceId: skill.resourceId, actual: 'disabled', stale: true },
    ])
    expect(registry.read(skill.resourceId, { sessionKey: 's' })).toEqual({ ok: false, code: 'DISABLED' })
  })

  it('does not publish a new revision until its exact trusted revision is applied', async () => {
    const registry = createSkillCandidateRegistry({ barrier: createExtensionActivationBarrier() })
    const old = candidate()
    registry.replaceRoot('workspace-agnes', [old])
    registry.setControl({
      desired: [{ resourceId: old.resourceId, state: 'enabled' }],
      trust: [
        {
          resourceId: old.resourceId,
          revision: old.revision,
          capabilityHash: old.capabilityHash,
          state: 'trusted',
        },
      ],
    })
    await activate(registry)
    const changed = candidate({ revision: 'd'.repeat(64), body: 'changed body' })
    registry.replaceRoot('workspace-agnes', [changed])
    expect(registry.actual()).toMatchObject([{ revision: old.revision, actual: 'ready' }])
    await activate(registry, 'skills-2')
    expect(registry.actual()).toMatchObject([
      { actual: 'unavailable', desired: 'enabled', lastSafeError: { code: 'UNTRUSTED_REVISION' } },
    ])
    expect(registry.read(changed.resourceId, { sessionKey: 's' })).toEqual({
      ok: false,
      code: 'UNTRUSTED_REVISION',
    })
  })

  it('captures an immutable active snapshot and publishes it only at a drained turn boundary', async () => {
    const barrier = createExtensionActivationBarrier()
    const registry = createSkillCandidateRegistry({ barrier })
    const skill = candidate()
    registry.replaceRoot('workspace-agnes', [skill])
    registry.setControl({
      desired: [{ resourceId: skill.resourceId, state: 'enabled' }],
      trust: [
        {
          resourceId: skill.resourceId,
          revision: skill.revision,
          capabilityHash: skill.capabilityHash,
          state: 'trusted',
        },
      ],
    })
    const active = barrier.admit('turn')
    let captured: ReturnType<typeof registry.snapshot> | undefined
    const apply = vi.fn(async (input: ReturnType<typeof registry.snapshot>) => {
      captured = input
    })
    const pending = registry.activate('skills-refresh-1', apply)
    expect(barrier.snapshot().state).toBe('quiescing')
    expect(apply).not.toHaveBeenCalled()
    active.finish()
    await pending
    registry.setControl({ desired: [{ resourceId: skill.resourceId, state: 'disabled' }], trust: [] })
    expect(captured?.list()).toMatchObject([{ actual: 'ready' }])
    expect(captured?.read(skill.resourceId, { sessionKey: 's' })).toEqual(
      expect.objectContaining({
        ok: true,
        content: 'private skill body',
      }),
    )
    expect(registry.actual()).toMatchObject([{ actual: 'ready' }])
  })

  it('accepts priority-50 package contributions without promoting them over a filesystem winner', async () => {
    const registry = createSkillCandidateRegistry({ barrier: createExtensionActivationBarrier() })
    const filesystem = candidate()
    const packageSkill = candidate({
      resourceId: `skill/package/package/${'d'.repeat(64)}`,
      priority: 50,
      body: 'package body',
      sourceIdentity: { scope: 'package', rootKey: 'package', sourceId: 'd'.repeat(64) },
    })
    registry.replaceRoot('workspace-agnes', [filesystem])
    registry.replacePackage([packageSkill])
    registry.setControl({
      desired: [
        { resourceId: filesystem.resourceId, state: 'enabled' },
        { resourceId: packageSkill.resourceId, state: 'enabled' },
      ],
      trust: [
        {
          resourceId: filesystem.resourceId,
          revision: filesystem.revision,
          capabilityHash: filesystem.capabilityHash,
          state: 'trusted',
        },
        {
          resourceId: packageSkill.resourceId,
          revision: packageSkill.revision,
          capabilityHash: packageSkill.capabilityHash,
          state: 'trusted',
        },
      ],
    })
    await activate(registry)
    const actual = registry.actual()
    expect(actual.find((item) => item.resourceId === filesystem.resourceId)).toMatchObject({
      actual: 'ready',
      resolution: { winner: true },
    })
    expect(actual.find((item) => item.resourceId === packageSkill.resourceId)).toMatchObject({
      actual: 'unavailable',
      resolution: { winner: false },
    })
  })

  it('does not publish staged controls when the daemon apply callback fails', async () => {
    const registry = createSkillCandidateRegistry({ barrier: createExtensionActivationBarrier() })
    const skill = candidate()
    registry.replaceRoot('workspace-agnes', [skill])
    registry.setControl({
      desired: [{ resourceId: skill.resourceId, state: 'enabled' }],
      trust: [
        {
          resourceId: skill.resourceId,
          revision: skill.revision,
          capabilityHash: skill.capabilityHash,
          state: 'trusted',
        },
      ],
    })
    await expect(
      registry.activate('skills-failed-apply', async () => {
        throw new Error('reload failed')
      }),
    ).rejects.toThrow('reload failed')
    expect(registry.actual()).toEqual([])
  })
})
