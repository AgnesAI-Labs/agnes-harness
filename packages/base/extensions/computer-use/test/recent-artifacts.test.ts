import type { ArtifactRef, SessionRef, ToolContext } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { createRecentArtifactMetadataIndex } from '../../artifacts-local/src/recent-metadata.js'
import type {
  ComputerUseBackend,
  ComputerUseBackendProvider,
  NormalizedComputerUseArgs,
} from '../src/backend.js'
import { ComputerUseToolRuntime } from '../src/tool.js'

const imageRef = (digit: string): ArtifactRef => ({
  sha256: digit.repeat(64),
  size: 20,
  mime: 'image/png',
})

function capture(ref: ArtifactRef, elements: readonly unknown[] = []) {
  return {
    mode: 'som',
    width: 100,
    height: 80,
    target: { app: 'Notes', pid: 7, window_id: 9, snapshot_id: ref.sha256 },
    elements,
    image: {
      ref,
      mime: 'image/png',
      width: 100,
      height: 80,
      digest: ref.sha256,
    },
  }
}

function context(key: string, lane: string): ToolContext {
  const ctx = fakeToolContext()
  ;(ctx as unknown as { session: SessionRef }).session = { key, lane, workspaceRoot: ctx.cwd }
  return ctx
}

function runtime(
  respond: (args: NormalizedComputerUseArgs, session: SessionRef) => unknown | Promise<unknown>,
) {
  const provider: ComputerUseBackendProvider = {
    async acquire(session) {
      return backend(session, respond)
    },
  }
  const index = createRecentArtifactMetadataIndex()
  return { runtime: new ComputerUseToolRuntime(provider, {}, index), index }
}

function backend(
  session: SessionRef,
  respond: (args: NormalizedComputerUseArgs, session: SessionRef) => unknown | Promise<unknown>,
): ComputerUseBackend {
  return {
    profileHash: 'profile-a',
    generation: 1,
    runtimePolicy: {
      mode: 'standard',
      authorization: 'driver-standard',
      sessionKey: session.key,
      lane: session.lane,
    },
    modifierActions: ['click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll'],
    call: (args, options) => Promise.resolve(respond(args, options.session)),
  }
}

describe('computer_use recent artifact metadata wiring', () => {
  it('supports 100 recent captures and rejects 101 as a configured limit', async () => {
    let next = imageRef('a')
    const provider: ComputerUseBackendProvider = {
      async acquire(session) {
        return backend(session, () => capture(next))
      },
    }
    expect(() => new ComputerUseToolRuntime(provider, { maxRecentPerSession: 101 })).toThrow(/1 to 100/)
    const toolRuntime = new ComputerUseToolRuntime(provider, { maxRecentPerSession: 100 })
    const ctx = context('hundred', 'main')
    for (let value = 1; value <= 101; value++) {
      next = { ...imageRef('a'), sha256: value.toString(16).padStart(64, '0') }
      await toolRuntime.tool.execute({ action: 'capture' }, ctx)
    }
    const artifacts = toolRuntime.recentArtifactMetadata(ctx.session).artifacts
    expect(artifacts).toHaveLength(100)
    expect(artifacts[0]?.sha256).toBe((101).toString(16).padStart(64, '0'))
    expect(artifacts.at(-1)?.sha256).toBe((2).toString(16).padStart(64, '0'))
  })
  it('applies a profile-tightened recent metadata window', async () => {
    let next = imageRef('a')
    const provider: ComputerUseBackendProvider = {
      async acquire(session) {
        return backend(session, () => capture(next))
      },
    }
    const toolRuntime = new ComputerUseToolRuntime(provider, { maxRecentPerSession: 2 })
    const ctx = context('session', 'main')
    for (const digit of ['a', 'b', 'c']) {
      next = imageRef(digit)
      await toolRuntime.tool.execute({ action: 'capture' }, ctx)
    }
    expect(toolRuntime.recentArtifactMetadata(ctx.session).artifacts).toEqual([imageRef('c'), imageRef('b')])
  })

  it('records successful screenshot artifacts newest-first with exact session and lane isolation', async () => {
    let next = imageRef('a')
    const fixture = runtime(() => capture(next))
    const main = context('session', 'main')
    const branch = context('session', 'branch')

    await fixture.runtime.tool.execute({ action: 'capture' }, main)
    next = imageRef('b')
    await fixture.runtime.tool.execute({ action: 'capture' }, main)
    next = imageRef('c')
    await fixture.runtime.tool.execute({ action: 'capture' }, branch)

    expect(fixture.runtime.recentArtifactMetadata(main.session).artifacts).toEqual([
      imageRef('b'),
      imageRef('a'),
    ])
    expect(fixture.runtime.recentArtifactMetadata(branch.session).artifacts).toEqual([imageRef('c')])
    expect(fixture.runtime.recentArtifactMetadata(main.session).gcDeletionAuthority).toBe(false)
  })

  it('does not commit metadata when capture parsing or full-element spill fails', async () => {
    let result: unknown = { invalid: true }
    const fixture = runtime(() => result)
    const ctx = context('session', 'main')

    await expect(fixture.runtime.tool.execute({ action: 'capture' }, ctx)).rejects.toThrow(/capture.mode/)
    expect(fixture.runtime.recentArtifactMetadata(ctx.session).artifacts).toEqual([])

    result = capture(
      imageRef('a'),
      Array.from({ length: 101 }, (_, index) => ({
        index: index + 1,
        role: 'button',
        label: `button-${index}`,
        bounds: [1, 2, 3, 4],
      })),
    )
    const failedSpill = context('session', 'main')
    failedSpill.artifacts.put = vi.fn(async () => {
      throw new Error('spill failed')
    })
    await expect(fixture.runtime.tool.execute({ action: 'capture' }, failedSpill)).rejects.toThrow(
      'spill failed',
    )
    expect(fixture.runtime.recentArtifactMetadata(ctx.session).artifacts).toEqual([])
  })

  it('lets compaction, session reset and dispose clear metadata without deleting artifacts', async () => {
    let next = imageRef('a')
    const fixture = runtime(() => capture(next))
    const first = context('session-a', 'main')
    const second = context('session-b', 'main')
    await fixture.runtime.tool.execute({ action: 'capture' }, first)
    next = imageRef('b')
    await fixture.runtime.tool.execute({ action: 'capture' }, second)

    fixture.runtime.resetScreenshotDedup(first.session)
    expect(fixture.runtime.recentArtifactMetadata(first.session).artifacts).toEqual([])
    expect(fixture.runtime.recentArtifactMetadata(second.session).artifacts).toEqual([imageRef('b')])

    fixture.runtime.resetSession(second.session)
    expect(fixture.runtime.recentArtifactMetadata(second.session).artifacts).toEqual([])
    next = imageRef('c')
    await fixture.runtime.tool.execute({ action: 'capture' }, first)
    fixture.runtime.clear()
    expect(fixture.runtime.recentArtifactMetadata(first.session).artifacts).toEqual([])
    expect('delete' in fixture.index).toBe(false)
  })

  it('does not repopulate metadata from a capture whose spill crosses compaction', async () => {
    const elements = Array.from({ length: 101 }, (_, index) => ({
      index: index + 1,
      role: 'button',
      label: `button-${index}`,
      bounds: [1, 2, 3, 4],
    }))
    const fixture = runtime(() => capture(imageRef('a'), elements))
    const ctx = context('session', 'main')
    let release: ((ref: ArtifactRef) => void) | undefined
    ctx.artifacts.put = vi.fn(
      () =>
        new Promise<ArtifactRef>((resolve) => {
          release = resolve
        }),
    )

    const pending = fixture.runtime.tool.execute({ action: 'capture' }, ctx)
    await vi.waitFor(() => expect(ctx.artifacts.put).toHaveBeenCalledOnce())
    fixture.runtime.resetScreenshotDedup(ctx.session)
    release?.({ sha256: 'd'.repeat(64), size: 2, mime: 'application/json' })
    await pending

    expect(fixture.runtime.recentArtifactMetadata(ctx.session).artifacts).toEqual([])
  })

  it.each(['compaction', 'session reset', 'dispose'] as const)(
    'does not repopulate metadata when a direct capture backend call crosses %s',
    async (reset) => {
      let release: ((result: unknown) => void) | undefined
      const respond = vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            release = resolve
          }),
      )
      const fixture = runtime(respond)
      const ctx = context('session', 'main')

      const pending = fixture.runtime.tool.execute({ action: 'capture' }, ctx)
      await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce())
      if (reset === 'compaction') fixture.runtime.resetScreenshotDedup(ctx.session)
      else if (reset === 'session reset') fixture.runtime.resetSession(ctx.session)
      else fixture.runtime.clear()
      release?.(capture(imageRef('a')))
      await pending

      expect(fixture.runtime.recentArtifactMetadata(ctx.session).artifacts).toEqual([])
    },
  )

  it('does not repopulate metadata when capture_after backend dispatch crosses compaction', async () => {
    let release: ((result: unknown) => void) | undefined
    const respond = vi.fn((args: NormalizedComputerUseArgs) => {
      if (args.action !== 'capture') return { ok: true, action: args.action, effect: 'confirmed' }
      return new Promise<unknown>((resolve) => {
        release = resolve
      })
    })
    const fixture = runtime(respond)
    const ctx = context('session', 'main')

    const pending = fixture.runtime.tool.execute(
      { action: 'click', coordinate: [1, 2], capture_after: true },
      ctx,
    )
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2))
    fixture.runtime.resetScreenshotDedup(ctx.session)
    release?.(capture(imageRef('a')))
    await pending

    expect(fixture.runtime.recentArtifactMetadata(ctx.session).artifacts).toEqual([])
  })

  it.each(['session reset', 'dispose'] as const)(
    'does not create state or dispatch when provider acquire crosses %s',
    async (reset) => {
      let release: ((value: ComputerUseBackend) => void) | undefined
      const acquire = vi.fn(
        () =>
          new Promise<ComputerUseBackend>((resolve) => {
            release = resolve
          }),
      )
      const provider: ComputerUseBackendProvider = { acquire }
      const runtime = new ComputerUseToolRuntime(provider)
      const ctx = context('session', 'main')
      const call = vi.fn(() => capture(imageRef('a')))

      const pending = runtime.tool.execute({ action: 'capture' }, ctx)
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())
      if (reset === 'session reset') runtime.resetSession(ctx.session)
      else runtime.clear()
      release?.(backend(ctx.session, call))

      await expect(pending).resolves.toMatchObject({
        structured: { code: 'session_lifecycle_changed' },
      })
      expect(call).not.toHaveBeenCalled()
      expect(runtime.recentArtifactMetadata(ctx.session).artifacts).toEqual([])
    },
  )

  it.each(['session reset', 'dispose'] as const)(
    'does not dispatch capture_after when the mutation backend call crosses %s',
    async (reset) => {
      let release: ((result: unknown) => void) | undefined
      const respond = vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            release = resolve
          }),
      )
      const fixture = runtime(respond)
      const ctx = context('session', 'main')

      const pending = fixture.runtime.tool.execute(
        { action: 'click', coordinate: [1, 2], capture_after: true },
        ctx,
      )
      await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce())
      if (reset === 'session reset') fixture.runtime.resetSession(ctx.session)
      else fixture.runtime.clear()
      release?.({ ok: true, action: 'click', effect: 'confirmed' })

      await expect(pending).resolves.toMatchObject({
        structured: {
          ok: true,
          warning: 'capture_after skipped because the session lifecycle changed',
        },
      })
      expect(respond).toHaveBeenCalledOnce()
      expect(fixture.runtime.recentArtifactMetadata(ctx.session).artifacts).toEqual([])
    },
  )

  it('does not inspect or expose a backend rejection after dispatched capture_after is reset', async () => {
    const secret = 'Bearer provider-secret-backend'
    let rejectFollow: ((reason: unknown) => void) | undefined
    const respond = vi.fn((args: NormalizedComputerUseArgs) => {
      if (args.action !== 'capture') return { ok: true, action: args.action, effect: 'confirmed' }
      return new Promise<unknown>((_resolve, reject) => {
        rejectFollow = reject
      })
    })
    const fixture = runtime(respond)
    const ctx = context('session', 'main')
    const warn = vi.fn()
    ctx.log.warn = warn

    const pending = fixture.runtime.tool.execute(
      { action: 'click', coordinate: [1, 2], capture_after: true },
      ctx,
    )
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(2))
    fixture.runtime.resetSession(ctx.session)
    rejectFollow?.(new Error(secret))
    const result = await pending

    expect(result.structured).toMatchObject({
      warning: 'capture_after skipped because the session lifecycle changed',
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
    expect(warn).not.toHaveBeenCalled()
  })

  it('uses a fixed warning and log code for a current-lifecycle capture_after rejection', async () => {
    const secret = 'Bearer current-provider-secret'
    const fixture = runtime((args) => {
      if (args.action === 'capture') throw new Error(secret)
      return { ok: true, action: args.action, effect: 'confirmed' }
    })
    const ctx = context('session', 'main')
    const warn = vi.fn()
    ctx.log.warn = warn

    const result = await fixture.runtime.tool.execute(
      { action: 'click', coordinate: [1, 2], capture_after: true },
      ctx,
    )

    expect(result.structured).toMatchObject({ warning: 'capture_after failed' })
    expect(warn).toHaveBeenCalledWith('computer_use capture_after failed', {
      action: 'click',
      code: 'capture_after_failed',
    })
    expect(`${JSON.stringify(result)}${JSON.stringify(warn.mock.calls)}`).not.toContain(secret)
  })

  it('does not inspect or expose a spill rejection after capture_after is disposed', async () => {
    const secret = 'sk-provider-secret-spill'
    const elements = Array.from({ length: 101 }, (_, index) => ({
      index: index + 1,
      role: 'button',
      label: `button-${index}`,
      bounds: [1, 2, 3, 4],
    }))
    const fixture = runtime((args) =>
      args.action === 'capture'
        ? capture(imageRef('a'), elements)
        : { ok: true, action: args.action, effect: 'confirmed' },
    )
    const ctx = context('session', 'main')
    const warn = vi.fn()
    ctx.log.warn = warn
    let rejectSpill: ((reason: unknown) => void) | undefined
    ctx.artifacts.put = vi.fn(
      () =>
        new Promise<ArtifactRef>((_resolve, reject) => {
          rejectSpill = reject
        }),
    )

    const pending = fixture.runtime.tool.execute(
      { action: 'click', coordinate: [1, 2], capture_after: true },
      ctx,
    )
    await vi.waitFor(() => expect(ctx.artifacts.put).toHaveBeenCalledOnce())
    fixture.runtime.clear()
    rejectSpill?.(new Error(secret))
    const result = await pending

    expect(result.structured).toMatchObject({
      warning: 'capture_after skipped because the session lifecycle changed',
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each(['session reset', 'dispose'] as const)(
    'returns a fixed refusal when provider acquire rejects after %s',
    async (reset) => {
      const secret = `Bearer acquire-secret-${reset}`
      let rejectAcquire: ((reason: unknown) => void) | undefined
      const acquire = vi.fn(
        () =>
          new Promise<ComputerUseBackend>((_resolve, reject) => {
            rejectAcquire = reject
          }),
      )
      const runtime = new ComputerUseToolRuntime({ acquire })
      const ctx = context('session', 'main')

      const pending = runtime.tool.execute({ action: 'capture' }, ctx)
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())
      if (reset === 'session reset') runtime.resetSession(ctx.session)
      else runtime.clear()
      rejectAcquire?.(new Error(secret))
      const result = await pending

      expect(result.structured).toMatchObject({ code: 'session_lifecycle_changed' })
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(runtime.recentArtifactMetadata(ctx.session).artifacts).toEqual([])
    },
  )

  it.each(['session reset', 'dispose'] as const)(
    'returns a fixed refusal when a direct capture backend rejects after %s',
    async (reset) => {
      const secret = `sk-direct-backend-${reset}`
      let rejectCapture: ((reason: unknown) => void) | undefined
      const respond = vi.fn(
        () =>
          new Promise<unknown>((_resolve, reject) => {
            rejectCapture = reject
          }),
      )
      const fixture = runtime(respond)
      const ctx = context('session', 'main')

      const pending = fixture.runtime.tool.execute({ action: 'capture' }, ctx)
      await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce())
      if (reset === 'session reset') fixture.runtime.resetSession(ctx.session)
      else fixture.runtime.clear()
      rejectCapture?.(new Error(secret))
      const result = await pending

      expect(result.structured).toMatchObject({ code: 'session_lifecycle_changed' })
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(fixture.runtime.recentArtifactMetadata(ctx.session).artifacts).toEqual([])
    },
  )

  it.each(['session reset', 'dispose'] as const)(
    'returns a fixed refusal when direct capture spill rejects after %s',
    async (reset) => {
      const secret = `Bearer direct-spill-${reset}`
      const elements = Array.from({ length: 101 }, (_, index) => ({
        index: index + 1,
        role: 'button',
        label: `button-${index}`,
        bounds: [1, 2, 3, 4],
      }))
      const fixture = runtime(() => capture(imageRef('a'), elements))
      const ctx = context('session', 'main')
      let rejectSpill: ((reason: unknown) => void) | undefined
      ctx.artifacts.put = vi.fn(
        () =>
          new Promise<ArtifactRef>((_resolve, reject) => {
            rejectSpill = reject
          }),
      )

      const pending = fixture.runtime.tool.execute({ action: 'capture' }, ctx)
      await vi.waitFor(() => expect(ctx.artifacts.put).toHaveBeenCalledOnce())
      if (reset === 'session reset') fixture.runtime.resetSession(ctx.session)
      else fixture.runtime.clear()
      rejectSpill?.(new Error(secret))
      const result = await pending

      expect(result.structured).toMatchObject({ code: 'session_lifecycle_changed' })
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(fixture.runtime.recentArtifactMetadata(ctx.session).artifacts).toEqual([])
    },
  )
})
