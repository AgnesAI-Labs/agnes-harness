import { Context, FiberState } from '@agnes/cordis'
import { describe, expect, it } from 'vitest'
import { createSkillCandidateRegistry } from '../src/skills.js'
import { bindSkillRuntimeRows, createSkillCordisService } from '../src/skills-cordis.js'

const barrier = {
  quiesce: async <T>(_id: string, publish: (permit: unknown) => Promise<T>) => publish({}),
}

function tree() {
  const registry = createSkillCandidateRegistry({ barrier })
  const root = new Context()
  root.provide('skills', createSkillCordisService(registry))
  return { registry, root }
}

const skill = (name: string, body = `${name} body`) => ({
  name,
  description: `${name} description`,
  body,
})

describe('cordis skill contribution', () => {
  it('shows a skill registered during apply and removes it when the plugin is disposed', async () => {
    const { registry, root } = tree()
    const seen = registry.snapshot()
    const fiber = root.plugin((ctx) => {
      ctx.skills.register(skill('review-helper', 'read me'))
    })
    await fiber
    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(seen.list()).toMatchObject([
      { name: 'review-helper', actual: 'ready', trust: 'trusted', desired: 'enabled', priority: 450 },
    ])
    const listed = seen.list()
    const resourceId = listed[0]?.resourceId
    expect(resourceId).toBeTruthy()
    expect(seen.read(resourceId as string, { sessionKey: 's' })).toEqual(
      expect.objectContaining({ ok: true, content: 'read me' }),
    )
    await fiber.dispose()
    expect(seen.list()).toEqual([])
    expect(seen.read(resourceId as string, { sessionKey: 's' })).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('treats a second disposer call as a no-op', async () => {
    const { registry, root } = tree()
    let dispose: () => void = () => undefined
    const fiber = root.plugin((ctx) => {
      dispose = ctx.skills.register(skill('once'))
    })
    await fiber
    dispose()
    dispose()
    expect(registry.snapshot().list()).toEqual([])
    expect(fiber.state).toBe(FiberState.ACTIVE)
  })

  it('fails only the plugin that registers an invalid skill', async () => {
    const { registry, root } = tree()
    const good = root.plugin((ctx) => {
      ctx.skills.register(skill('kept-skill', 'kept'))
    })
    await good
    const bad = root.plugin((ctx) => {
      ctx.skills.register({ name: 'Not Kebab', description: 'bad', body: 'nope' })
    })
    await expect(bad).rejects.toThrow('runtime skill name must be kebab-case')
    expect(bad.state).toBe(FiberState.FAILED)
    expect(good.state).toBe(FiberState.ACTIVE)
    expect(registry.snapshot().list()).toMatchObject([{ name: 'kept-skill', actual: 'ready' }])
    expect(
      registry.snapshot().read(registry.snapshot().list()[0]?.resourceId ?? '', { sessionKey: 's' }),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        content: 'kept',
      }),
    )
  })

  it('fails a plugin that repeats a runtime name and leaves the first contribution', async () => {
    const { registry, root } = tree()
    const first = root.plugin((ctx) => {
      ctx.skills.register(skill('shared-name', 'first'))
    })
    await first
    const second = root.plugin((ctx) => {
      ctx.skills.register(skill('shared-name', 'second'))
    })
    await expect(second).rejects.toThrow('runtime skill name already registered')
    expect(second.state).toBe(FiberState.FAILED)
    expect(first.state).toBe(FiberState.ACTIVE)
    expect(registry.snapshot().list()).toMatchObject([{ name: 'shared-name' }])
    expect(
      registry.snapshot().read(registry.snapshot().list()[0]?.resourceId ?? '', { sessionKey: 's' }),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        content: 'first',
      }),
    )
  })

  it('rejects an over-long description or body without publishing the skill', async () => {
    const { registry, root } = tree()
    const longDescription = root.plugin((ctx) => {
      ctx.skills.register({ name: 'too-long', description: 'd'.repeat(1025), body: 'body' })
    })
    await expect(longDescription).rejects.toThrow('runtime skill description is empty or too long')
    const longBody = root.plugin((ctx) => {
      ctx.skills.register({ name: 'huge-body', description: 'ok', body: 'x'.repeat(192 * 1024 + 1) })
    })
    await expect(longBody).rejects.toThrow('runtime skill body is too long')
    expect(registry.snapshot().list()).toEqual([])
  })

  it('registers a provider during apply and drops its skills when the provider fiber is disposed', async () => {
    const { registry, root } = tree()
    let invalidate: () => void = () => undefined
    const provider = root.plugin((ctx) => {
      ctx.skills.registerProvider((control) => {
        invalidate = () => control.invalidate()
        return {
          skills: () => [skill('from-provider', 'provided')],
        }
      })
    })
    await provider
    const other = root.plugin((ctx) => {
      ctx.skills.register(skill('from-register', 'direct'))
    })
    await other
    expect(
      registry
        .snapshot()
        .list()
        .map((item) => item.name)
        .sort(),
    ).toEqual(['from-provider', 'from-register'])
    invalidate()
    expect(
      registry.snapshot().read(
        registry
          .snapshot()
          .list()
          .find((item) => item.name === 'from-provider')?.resourceId ?? '',
        { sessionKey: 's' },
      ),
    ).toEqual(expect.objectContaining({ ok: true, content: 'provided' }))
    await provider.dispose()
    invalidate()
    expect(
      registry
        .snapshot()
        .list()
        .map((item) => item.name),
    ).toEqual(['from-register'])
  })

  it('keeps a successor tree active while the predecessor still holds the same name', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const service = createSkillCordisService(registry)
    const seen = registry.snapshot()
    const readyBody = () => {
      const winner = seen.list().find((item) => item.name === 'handoff' && item.actual === 'ready')
      if (!winner) return undefined
      const read = seen.read(winner.resourceId, { sessionKey: 's' })
      return read.ok ? read.content : undefined
    }
    const predecessorRoot = new Context()
    predecessorRoot.provide('skills', service)
    const predecessor = predecessorRoot.plugin((ctx) => {
      ctx.skills.register(skill('handoff', 'old'))
    })
    await predecessor
    expect(readyBody()).toBe('old')

    const successorRoot = new Context()
    successorRoot.provide('skills', service)
    const successor = successorRoot.plugin((ctx) => {
      ctx.skills.register(skill('handoff', 'new'))
    })
    await successor
    expect(successor.state).toBe(FiberState.ACTIVE)
    expect(predecessor.state).toBe(FiberState.ACTIVE)

    await predecessor.dispose()
    expect(predecessor.state).toBe(FiberState.DISPOSED)
    expect(successor.state).toBe(FiberState.ACTIVE)
    expect(readyBody()).toBe('new')
  })

  it('accepts the next fiber of the same row while the previous fiber is still mounted', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const service = createSkillCordisService(registry)
    const root = new Context()
    root.provide('skills', service)
    const rows = new WeakMap<object, string>()
    bindSkillRuntimeRows(root, {
      lookup: (fiber) => {
        const rowId = rows.get(fiber)
        return rowId === undefined ? undefined : { rowId }
      },
    })
    const seen = registry.snapshot()
    const readyBody = () => {
      const winner = seen.list().find((item) => item.name === 'handoff' && item.actual === 'ready')
      if (!winner) return undefined
      const read = seen.read(winner.resourceId, { sessionKey: 's' })
      return read.ok ? read.content : undefined
    }
    const predecessor = root.plugin((ctx) => {
      rows.set(ctx.fiber, 'host:test-seam')
      ctx.skills.register(skill('handoff', 'old'))
    })
    await predecessor
    const successor = root.plugin((ctx) => {
      rows.set(ctx.fiber, 'host:test-seam')
      ctx.skills.register(skill('handoff', 'new'))
    })
    await successor
    expect(successor.state).toBe(FiberState.ACTIVE)
    expect(predecessor.state).toBe(FiberState.ACTIVE)
    await predecessor.dispose()
    expect(successor.state).toBe(FiberState.ACTIVE)
    expect(readyBody()).toBe('new')
  })

  it('fails a different row on the same tree that repeats a runtime name', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const service = createSkillCordisService(registry)
    const root = new Context()
    root.provide('skills', service)
    const rows = new WeakMap<object, string>()
    bindSkillRuntimeRows(root, {
      lookup: (fiber) => {
        const rowId = rows.get(fiber)
        return rowId === undefined ? undefined : { rowId }
      },
    })
    const seen = registry.snapshot()
    const first = root.plugin((ctx) => {
      rows.set(ctx.fiber, 'host:test-seam')
      ctx.skills.register(skill('handoff', 'old'))
    })
    await first
    const second = root.plugin((ctx) => {
      rows.set(ctx.fiber, 'host:other-seam')
      ctx.skills.register(skill('handoff', 'new'))
    })
    await expect(second).rejects.toThrow('runtime skill name already registered')
    expect(second.state).toBe(FiberState.FAILED)
    expect(first.state).toBe(FiberState.ACTIVE)
    const listed = seen.list()
    expect(listed).toMatchObject([{ name: 'handoff', actual: 'ready' }])
    expect(seen.read(listed[0]?.resourceId ?? '', { sessionKey: 's' })).toEqual(
      expect.objectContaining({ ok: true, content: 'old' }),
    )
  })

  it('drops an aborted successor and keeps the predecessor body', async () => {
    const registry = createSkillCandidateRegistry({ barrier })
    const service = createSkillCordisService(registry)
    const seen = registry.snapshot()
    const readyBody = () => {
      const winner = seen.list().find((item) => item.name === 'handoff' && item.actual === 'ready')
      if (!winner) return undefined
      const read = seen.read(winner.resourceId, { sessionKey: 's' })
      return read.ok ? read.content : undefined
    }
    const predecessorRoot = new Context()
    predecessorRoot.provide('skills', service)
    const predecessor = predecessorRoot.plugin((ctx) => {
      ctx.skills.register(skill('handoff', 'old'))
    })
    await predecessor
    const successorRoot = new Context()
    successorRoot.provide('skills', service)
    const successor = successorRoot.plugin((ctx) => {
      ctx.skills.register(skill('handoff', 'new'))
    })
    await successor
    await successor.dispose()
    expect(successor.state).toBe(FiberState.DISPOSED)
    expect(predecessor.state).toBe(FiberState.ACTIVE)
    expect(readyBody()).toBe('old')
  })

  it('does not expose list or read on the contribution service', () => {
    const { root } = tree()
    const service = root.skills
    expect(service).not.toHaveProperty('list')
    expect(service).not.toHaveProperty('read')
    expect(service).not.toHaveProperty('readFile')
  })
})
