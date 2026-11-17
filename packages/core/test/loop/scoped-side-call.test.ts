import { describe, expect, it } from 'vitest'
import { createScopedSideCallPort, namespacedInvocationId } from '../../src/loop/scoped-side-call.js'
import { data, gated, options, sideCosts, signal, withSession } from '../helpers/side-call-session.js'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected fixture value')
  return value
}

const scope = (caller = 'ext:sample/main', scopeId = 'one') => ({ caller, scopeId, kind: 'hook' as const })

describe('scoped side calls', () => {
  it('refuses a call prepared in another scope as foreign', async () => {
    await withSession({}, async ({ session }) => {
      const a = createScopedSideCallPort(session, scope())
      const b = createScopedSideCallPort(session, scope('ext:sample/main', 'two'))
      await expect(b.invoke(await a.prepare(options()), signal())).rejects.toMatchObject({
        code: 'E_REQUEST_FROZEN',
        detail: { reason: 'foreign' },
      })
      await Promise.all([a.close(), b.close()])
    })
  })
  it('namespaces invocation ids per caller', async () => {
    await withSession({}, async ({ session }) => {
      const a = createScopedSideCallPort(session, scope())
      const b = createScopedSideCallPort(session, scope('ext:other/main'))
      await a.invoke(await a.prepare(options()), signal())
      expect(await b.status('call-1')).toMatchObject({ status: 'absent' })
      expect(await a.status('call-1')).toMatchObject({ status: 'finished' })
      expect(await b.invoke(await b.prepare(options()), signal())).toMatchObject({
        status: 'ok',
        replayed: false,
      })
      await Promise.all([a.close(), b.close()])
    })
  })
  it('records the caller on the cost row', async () => {
    await withSession({}, async ({ session, rows }) => {
      const a = createScopedSideCallPort(session, scope())
      await a.invoke(await a.prepare(options()), signal())
      expect(data(sideCosts(await rows())[0])).toMatchObject({ caller: 'ext:sample/main' })
      await a.close()
    })
  })
  it('close aborts and waits for in-flight calls without closing another scope of the same caller', async () => {
    const gate = gated()
    const other = gated()
    let started = 0
    await withSession(
      { script: (...args) => (started++ === 0 ? gate.script : other.script)(...args) },
      async ({ session, rows }) => {
        const a = createScopedSideCallPort(session, scope())
        const b = createScopedSideCallPort(session, scope('ext:sample/main', 'two'))
        const pending = a.invoke(await a.prepare(options()), signal())
        await gate.reached
        const another = b.invoke(await b.prepare(options({ invocationId: 'other' })), signal())
        await other.reached
        await a.close()
        expect(await pending).toMatchObject({ status: 'failed', reason: 'cancelled' })
        expect(sideCosts(await rows())).toHaveLength(1)
        await expect(a.prepare(options())).rejects.toMatchObject({ code: 'E_CLOSED' })
        gate.open()
        expect(await b.status('other')).toMatchObject({ status: 'in-flight' })
        other.open()
        expect(await another).toMatchObject({ status: 'ok' })
        await b.close()
      },
    )
  })
  it('plugin in-flight calls do not block the loop finishing', async () => {
    const gate = gated()
    await withSession({ script: gate.script }, async ({ session, ctx, rows }) => {
      const a = createScopedSideCallPort(session, scope())
      const pending = a.invoke(await a.prepare(options()), signal())
      await gate.reached
      await expect(ctx.events.finish('completed')).resolves.toMatchObject({ phase: 'terminal' })
      expect(await pending).toMatchObject({ status: 'failed', reason: 'cancelled' })
      const events = await rows()
      expect(required(sideCosts(events)[0]).seq).toBeLessThan(
        required(events.find((row) => row.type === 'turn/end')).seq,
      )
      await a.close()
      gate.open()
    })
  })
  it('replays a recorded result for the same namespaced id', async () => {
    await withSession({}, async ({ session, provider }) => {
      const a = createScopedSideCallPort(session, scope())
      await a.invoke(await a.prepare(options()), signal())
      await a.close()
      const b = createScopedSideCallPort(session, scope('ext:sample/main', 'two'))
      expect(await b.invoke(await b.prepare(options()), signal())).toMatchObject({
        status: 'ok',
        replayed: true,
      })
      expect(provider.calls).toHaveLength(1)
      await b.close()
    })
  })
  it('bounds caller ids before prefixing', () => {
    expect(namespacedInvocationId('ext:sample/main', 'a'.repeat(112))).toMatch(/^c[0-9a-f]{8}:a{112}$/)
    expect(() => namespacedInvocationId('ext:sample/main', 'a'.repeat(113))).toThrow(/E_REQUEST/)
  })
})

it('fits a real tool invocation and closes its port before returning the result', async () => {
  const { ToolRegistry } = await import('../../src/registry/tools.js')
  const { readTool } = await import('../helpers/open-session.js')
  const registry = new ToolRegistry()
  let port: import('@agnes/extension-api').SideCallPort | undefined
  registry.add(
    readTool(async (_args, ctx) => {
      port = ctx.sideCall
      expect(port).toBeDefined()
      const result = await required(port).invoke(await required(port).prepare(options()), ctx.signal)
      return { content: [{ type: 'text', text: result.status }] }
    }),
    { source: 'plugin/owner', trust: 'trusted', sideCall: true, pluginRowId: 'ext:sample/tool' },
  )
  await withSession({ extra: { registry } }, async ({ ctx, rows }) => {
    await ctx.tools.execute({ name: 'read', args: {} }, signal())
    expect(sideCosts(await rows()).map(data)).toEqual([
      expect.objectContaining({ caller: 'ext:sample/tool' }),
    ])
    await expect(required(port).status('call-1')).rejects.toMatchObject({ code: 'E_CLOSED' })
  })
})

it('keeps a late receipt when a tool already has a loop-scoped session', async () => {
  const { sessionForLoop } = await import('../../src/loop/scope.js')
  const { disposeLoopContext } = await import('../../src/loop/ports.js')
  const gate = gated()
  await withSession({ script: gate.script }, async ({ session, ctx, rows }) => {
    const port = createScopedSideCallPort(sessionForLoop(session), scope())
    const pending = port.invoke(await port.prepare(options()), signal())
    await gate.reached
    disposeLoopContext(ctx)
    await pending.catch(() => undefined)
    await port.close()
    const events = await rows()
    expect(events.filter((row) => row.type === 'x/core/late-effect-receipt')).toHaveLength(1)
    expect(data(sideCosts(events)[0])).toMatchObject({ caller: 'ext:sample/main' })
    gate.open()
  })
})

it('rejects retained prepared calls and ports after their turn ends', async () => {
  const { actor } = await import('../helpers/open-session.js')
  await withSession({}, async ({ session, ctx }) => {
    const a = createScopedSideCallPort(session, scope())
    const prepared = await a.prepare(options())
    await ctx.events.finish('completed')
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'next' }] })
    await ctx.input.accept()
    const b = createScopedSideCallPort(session, scope())
    await expect(a.invoke(prepared, signal())).rejects.toMatchObject({ detail: { reason: 'foreign' } })
    await expect(b.invoke(prepared, signal())).rejects.toMatchObject({ detail: { reason: 'foreign' } })
    await expect(a.prepare(options())).rejects.toMatchObject({ detail: { reason: 'foreign' } })
    await Promise.all([a.close(), b.close()])
  })
})

it.each(['returns', 'throws', 'times out', 'is cancelled'] as const)(
  'settles a tool side call before its invocation %s',
  async (ending) => {
    const { ToolRegistry } = await import('../../src/registry/tools.js')
    const { readTool } = await import('../helpers/open-session.js')
    const { presetDefaults } = await import('@agnes/core-common/step/preset')
    const gate = gated()
    const registry = new ToolRegistry()
    let pending: Promise<import('@agnes/extension-api').SideCallResult> | undefined
    let finishTool: (() => void) | undefined
    registry.add(
      readTool(async (_args, ctx) => {
        pending = required(ctx.sideCall).invoke(await required(ctx.sideCall).prepare(options()), ctx.signal)
        await gate.reached
        if (ending === 'throws') throw new Error('synthetic tool failure')
        if (ending !== 'returns')
          await new Promise<void>((resolve) => {
            finishTool = resolve
          })
        return { content: [{ type: 'text', text: 'done' }] }
      }),
      { source: 'plugin/owner', trust: 'trusted', sideCall: true, pluginRowId: 'ext:sample/tool' },
    )
    const preset = presetDefaults()
    if (ending === 'times out') preset.tools.timeoutMs = 50
    await withSession({ script: gate.script, preset, extra: { registry } }, async ({ ctx, rows }) => {
      const controller = new AbortController()
      const running = ctx.tools.execute({ name: 'read', args: {} }, controller.signal)
      await gate.reached
      if (ending === 'is cancelled') controller.abort()
      await running
      finishTool?.()
      expect(await pending).toMatchObject({ status: 'failed', reason: 'cancelled' })
      const events = await rows()
      expect(required(sideCosts(events)[0]).seq).toBeLessThan(
        required(events.find((row) => row.type === 'tool/result')).seq,
      )
      gate.open()
    })
  },
)

it('closes a hook scope before reporting its return while the turn stays open', async () => {
  const { HookEngine } = await import('../../src/hooks/engine.js')
  const gate = gated()
  await withSession({ script: gate.script }, async ({ session, rows }) => {
    let port: import('@agnes/extension-api').SideCallPort | undefined
    let pending: Promise<import('@agnes/extension-api').SideCallResult> | undefined
    const engine = new HookEngine({
      platform: { shell: 'posix', fs: { caseSensitive: true, pathSep: '/' }, terminal: { color: false } },
      onFailure() {},
      diag() {},
      sideCallFor: (caller) => createScopedSideCallPort(session, scope(caller)),
    })
    engine.on(
      'turn_stopping',
      async (_payload, ctx) => {
        port = ctx.sideCall
        pending = required(port).invoke(await required(port).prepare(options()), ctx.signal)
        await gate.reached
        return { action: 'stop' }
      },
      { source: 'plugin/owner', trust: 'trusted', sideCall: true, pluginRowId: 'ext:sample/stop' },
    )
    await engine.dispatch('turn_stopping', () => ({ turn: 1, step: 0, proposedReason: 'completed' }), {
      session: { key: session.key, lane: session.lane, workspaceRoot: '/w' },
      signal: signal(),
      replayed: false,
      log: session.d.logger,
      lease: { expiresAt: '2099-01-01T00:00:00Z', scope: {}, budget: { remaining: 1 } },
    })
    expect(session.op()).not.toBeNull()
    expect(sideCosts(await rows())).toHaveLength(1)
    expect(await pending).toMatchObject({ status: 'failed', reason: 'cancelled' })
    await expect(required(port).status('call-1')).rejects.toMatchObject({ code: 'E_CLOSED' })
    gate.open()
  })
})

it.each(['unused', 'prepare', 'status', 'invoke'] as const)(
  'keeps trusted tool refusal proof truthful after sideCall %s',
  async (operation) => {
    const { hostPortRequest } = await import('@agnes/core')
    const { ToolRegistry } = await import('../../src/registry/tools.js')
    const { readTool } = await import('../helpers/open-session.js')
    const registry = new ToolRegistry()
    registry.add(
      readTool(async (_args, ctx) => {
        const port = required(ctx.sideCall)
        if (operation === 'prepare') await port.prepare(options())
        if (operation === 'status') expect(await port.status('call-1')).toMatchObject({ status: 'absent' })
        if (operation === 'invoke')
          expect(await port.invoke(await port.prepare(options()), ctx.signal)).toMatchObject({ status: 'ok' })
        return hostPortRequest(
          ctx,
          () => Promise.reject(new Error('synthetic host refusal')),
          () => ({ code: 'INVALID_PARAMS', message: 'refused before changing anything' }),
        )
      }),
      { source: 'plugin/owner', trust: 'trusted', sideCall: true, pluginRowId: 'ext:sample/tool' },
    )
    await withSession({ extra: { registry } }, async ({ ctx, rows }) => {
      await ctx.tools.execute({ name: 'read', args: {} }, signal())
      const events = await rows()
      const result = data(events.find((row) => row.type === 'tool/result'))
      expect(result).toMatchObject({ isError: true })
      if (operation === 'invoke') {
        expect(sideCosts(events)).toHaveLength(1)
        expect(result).not.toHaveProperty('structured.effect', 'none')
        expect(result).not.toHaveProperty('code', 'TOOL_REJECTED_BEFORE_EFFECT')
      } else {
        expect(sideCosts(events)).toHaveLength(0)
        expect(result).toMatchObject({
          code: 'TOOL_REJECTED_BEFORE_EFFECT',
          structured: { effect: 'none', code: 'INVALID_PARAMS' },
        })
      }
    })
  },
)
