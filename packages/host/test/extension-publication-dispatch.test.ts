import { ProjectionRegistry, type RuntimeSlotFill } from '@agnes/core'
import type {
  HookContext,
  HookHandler,
  SessionRef,
  SlotContext,
  ToolContext,
  ToolDef,
} from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { bindExtensionInvocations } from '../src/assemble/extension-ports.js'
import type { RegMeta } from '../src/ext-host/ports.js'
import { PublicationDispatch } from '../src/publication-dispatch.js'
import { PublicationGate } from '../src/publication-gate.js'
import { fixtureTool } from './fixtures/tool.js'

const meta: RegMeta = { source: 'fixture/publication', trust: 'trusted' }
const sessionRef: SessionRef = { key: 'session', lane: 'main', workspaceRoot: '/workspace' }

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function fakeSession(name: string) {
  return {
    name,
    key: sessionRef.key,
    lane: sessionRef.lane,
    d: { cwd: sessionRef.workspaceRoot },
    closingOrClosed: false,
    lastSeq: 0,
    scan: vi.fn(async () => []),
    diag: vi.fn(async () => 0),
    appendExtensionEvent: vi.fn(async () => 1),
  }
}

function setup() {
  let registeredTool: ToolDef | undefined
  let registeredHook: HookHandler<'before_step'> | undefined
  let registeredSlot: RuntimeSlotFill<'status.line'> | undefined
  const first = fakeSession('first')
  const replacement = fakeSession('replacement')
  let current = first
  const resolve = vi.fn(() => {
    const captured = current
    current = replacement
    return captured
  })
  const projections = new ProjectionRegistry()
  projections.register(
    {
      key: `${meta.source}/state`,
      stateVersion: 1,
      init: () => ({ calls: 0 }),
      apply: (state) => state,
    },
    { owner: meta.source },
  )
  const gate = new PublicationGate()
  const publication = new PublicationDispatch(gate)
  const ports = bindExtensionInvocations(
    {
      tools: {
        add(def) {
          registeredTool = def
          return () => {}
        },
      },
      hooks: {
        on(event, handler) {
          if (event === 'before_step') registeredHook = handler as unknown as HookHandler<'before_step'>
          return () => {}
        },
      },
      slots: {
        register(slot, fill) {
          if (slot === 'status.line') registeredSlot = fill as RuntimeSlotFill<'status.line'>
          return () => {}
        },
      },
      projections,
      resources: { register: () => () => {} },
      registrations: () => [],
    },
    resolve as unknown as Parameters<typeof bindExtensionInvocations>[1],
    (session) => ({ key: session.key, lane: session.lane, workspaceRoot: session.d.cwd }),
    resolve as unknown as Parameters<typeof bindExtensionInvocations>[3],
    projections,
    undefined,
    publication,
  )
  return {
    first,
    replacement,
    resolve,
    gate,
    ports,
    takeTool: () => {
      if (!registeredTool) throw new Error('tool was not registered')
      return registeredTool
    },
    takeHook: () => {
      if (!registeredHook) throw new Error('hook was not registered')
      return registeredHook
    },
    takeSlot: () => {
      if (!registeredSlot) throw new Error('slot was not registered')
      return registeredSlot
    },
  }
}

type Entry = 'tool' | 'hook' | 'slot'

function registerEntry(
  entry: Entry,
  harness: ReturnType<typeof setup>,
  started: () => void,
  hold: Promise<void>,
): () => Promise<unknown> {
  const invoke = async () => {
    await harness.ports.extEvents.append('x/fixture/publication/invoked', { entry }, meta)
    started()
    await hold
  }
  if (entry === 'tool') {
    const def = fixtureTool('fixture_tool')
    def.execute = async () => {
      await invoke()
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    harness.ports.tools.add(def, meta)
    return () =>
      harness
        .takeTool()
        .execute({}, { session: sessionRef, signal: new AbortController().signal } as ToolContext)
  }
  if (entry === 'hook') {
    harness.ports.hooks.on(
      'before_step',
      async () => {
        await invoke()
        return {}
      },
      meta,
    )
    return async () =>
      harness.takeHook()({ turn: 1, step: 1, depth: 0, budget: { remaining: 1, cap: null } }, {
        session: sessionRef,
        signal: new AbortController().signal,
      } as HookContext)
  }
  harness.ports.slots.register(
    'status.line',
    async () => {
      await invoke()
      return { text: 'ready', level: 'info' }
    },
    meta,
  )
  return async () =>
    harness.takeSlot()(
      {
        session: sessionRef,
        surface: 'tui',
        trigger: { kind: 'tick' },
      } as SlotContext,
      new AbortController().signal,
    )
}

describe('extension publication dispatch', () => {
  it.each(['tool', 'hook', 'slot'] as const)(
    'queues %s session resolution while closed, captures that session, and releases before settlement',
    async (entry) => {
      const harness = setup()
      const writerHold = deferred()
      const writer = harness.gate.withClosed(() => writerHold.promise)
      const handlerHold = deferred()
      const handlerStarted = deferred()
      const call = registerEntry(entry, harness, handlerStarted.resolve, handlerHold.promise)()

      await Promise.resolve()
      expect(harness.resolve).not.toHaveBeenCalled()
      expect(harness.first.appendExtensionEvent).not.toHaveBeenCalled()

      writerHold.resolve()
      await writer
      await handlerStarted.promise
      expect(harness.resolve).toHaveBeenCalledOnce()
      expect(harness.first.appendExtensionEvent).toHaveBeenCalledOnce()
      expect(harness.replacement.appendExtensionEvent).not.toHaveBeenCalled()

      const nextWriter = vi.fn()
      await harness.gate.withClosed(nextWriter)
      expect(nextWriter).toHaveBeenCalledOnce()

      handlerHold.resolve()
      await call
    },
  )

  it('queues projection reads while closed, then uses the invocation-captured session and releases before scan settles', async () => {
    const harness = setup()
    const beginProjection = deferred()
    const projectionStarted = deferred()
    const scanHold = deferred()
    harness.first.scan.mockImplementation(async () => {
      projectionStarted.resolve()
      await scanHold.promise
      return []
    })
    const tool = fixtureTool('fixture_projection')
    tool.execute = async () => {
      await beginProjection.promise
      const result = await harness.ports.projections.read(`${meta.source}/state`, meta, () => {})
      return { content: [{ type: 'text', text: JSON.stringify(result.unit) }] }
    }
    harness.ports.tools.add(tool, meta)
    const call = harness
      .takeTool()
      .execute({}, { session: sessionRef, signal: new AbortController().signal } as ToolContext)

    await vi.waitFor(() => expect(harness.resolve).toHaveBeenCalledOnce())
    const writerHold = deferred()
    const writer = harness.gate.withClosed(() => writerHold.promise)
    beginProjection.resolve()
    await Promise.resolve()
    expect(harness.first.scan).not.toHaveBeenCalled()
    expect(harness.replacement.scan).not.toHaveBeenCalled()

    writerHold.resolve()
    await writer
    await projectionStarted.promise
    expect(harness.first.scan).toHaveBeenCalledOnce()
    expect(harness.replacement.scan).not.toHaveBeenCalled()

    const nextWriter = vi.fn()
    await harness.gate.withClosed(nextWriter)
    expect(nextWriter).toHaveBeenCalledOnce()

    scanHold.resolve()
    await call
  })
})
