import { Context } from '@agnes/cordis'
import type { UiSurfaceRecord } from '@agnes/protocol'
import {
  SlotRegistry,
  conversationCards as testCards,
  workbenchPanels as testPanels,
} from '@agnes/web-client'
import { expect, it, vi } from 'vitest'
import { mountIntelligentUi } from '../../../web-conversation/src/intelligent-ui/mount.js'
import { financeRecord } from './fixture.js'

const controls = vi.hoisted(() => ({
  clients: [] as { publish(ready: boolean, surfaces: UiSurfaceRecord[]): void }[],
  open: vi.fn(),
  panel: undefined as
    | undefined
    | {
        when(context: unknown): boolean
        title(context: unknown): string
        count: { read(context: unknown): number | undefined; subscribe(listener: () => void): () => void }
      },
}))
vi.mock('../../../web-conversation/src/intelligent-ui/client.js', () => ({
  IntelligentUiClient: class {
    snapshot = { ready: false, surfaces: [] as UiSurfaceRecord[] }
    listener: (() => void) | undefined
    constructor(readonly sessionId: string) {
      controls.clients.push(this)
    }
    subscribe(listener: () => void) {
      this.listener = listener
      return () => {
        this.listener = undefined
      }
    }
    getSnapshot() {
      return this.snapshot
    }
    start() {
      return Promise.resolve()
    }
    dispose() {
      this.listener = undefined
    }
    publish(ready: boolean, surfaces: UiSurfaceRecord[]) {
      this.snapshot = { ready, surfaces }
      this.listener?.()
    }
  },
}))
vi.mock('../../../web-conversation/src/intelligent-ui/server.js', () => ({ intelligentUiServer: () => ({}) }))
vi.mock('../../../web-conversation/src/intelligent-ui/placements.js', async (original) => ({
  ...(await original<object>()),
  openIntelligentPanel: controls.open,
}))
// Mount lifecycle coverage keeps the real placement policy without loading document renderers.
vi.mock('@agnes/web-ui/conversation', () => ({ DocumentPreview: () => null }))
vi.mock('@agnes/web-client', async (original) => ({
  ...(await original<typeof import('@agnes/web-client')>()),
  conversationCards: {
    get: () => undefined,
    register: () => () => {},
    subscribe: () => () => {},
    entries: () => [],
  },
  workbenchPanels: {
    // The views tab is the one under test; the deliverables tab registers beside it.
    register: (entry: typeof controls.panel & { id: string }) => {
      if (entry?.id === 'intelligent-ui') controls.panel = entry
      return () => {}
    },
    get: () => undefined,
  },
}))
vi.mock('@agnes/web-ui', () => ({
  createDocumentLocaleSource: () => ({ source: {}, dispose() {} }),
  INTELLIGENT_UI_NAMESPACE: 'ui',
  intelligentUiCatalog: {},
  // The finance fixtures carry tables and forms, never only text, files or questions.
  isTextOnly: () => false,
  isDeliverableList: () => false,
  questionForm: () => undefined,
}))

it('seeds loaded surfaces on every session and reveals only first appearances', async () => {
  const ctx = new Context()
  const registry = new SlotRegistry(ctx)
  let switched!: () => void
  let readinessChanged!: () => void
  let status = 'history-only'
  const previous = controls.clients.length
  const session = {
    sessionId: 'first',
    readiness: {
      getSnapshot: () => ({ status }),
      subscribe: (listener: () => void) => {
        readinessChanged = listener
        return () => {}
      },
    },
    subscribe: (listener: () => void) => {
      switched = listener
      return () => {}
    },
  }
  const reveal = vi.fn()
  const dispose = mountIntelligentUi({
    contributions: { conversationCards: testCards, workbenchPanels: testPanels },
    client: { sessions: { get: (id: string) => ({ id }) } } as never,
    registry,
    session: session as never,
    locale: { register: () => () => {} } as never,
    approval: () => {},
    revealInline: reveal,
  })
  expect(registry.entries('conversation.view')).toHaveLength(0)
  registry.declare('conversation.view', { kind: 'list', scope: 'session' })
  expect(registry.entries('conversation.view').map((entry) => entry.id)).toEqual(['builtin-intelligent-ui'])
  const old = financeRecord()
  old.surface.id = 'loaded-review'
  const live = structuredClone(old)
  live.surface.revision = 2
  try {
    expect(controls.clients.length).toBe(previous)
    status = 'connecting'
    readinessChanged()
    expect(controls.clients.length).toBe(previous)
    status = 'ready'
    readinessChanged()
    const first = controls.clients.at(-1)!
    first.publish(false, [old])
    first.publish(true, [old])
    first.publish(true, [old])
    expect(reveal).not.toHaveBeenCalled()
    expect(controls.open).not.toHaveBeenCalled()
    first.publish(true, [live])
    expect(reveal).not.toHaveBeenCalled()
    expect(controls.open).not.toHaveBeenCalled()
    first.publish(true, [live])
    expect(reveal).not.toHaveBeenCalled()
    session.sessionId = 'second'
    switched()
    controls.clients.at(-1)!.publish(true, [live])
    expect(reveal).not.toHaveBeenCalled()
    expect(controls.open).not.toHaveBeenCalled()
    const newSurface = structuredClone(live)
    newSurface.surface.id = 'live-review'
    controls.clients.at(-1)!.publish(true, [live, newSurface])
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(controls.open).not.toHaveBeenCalled()
    const workbenchOnly = structuredClone(newSurface)
    workbenchOnly.surface.id = 'workbench-only'
    workbenchOnly.surface.placement = { inline: false, workbench: true }
    controls.clients.at(-1)!.publish(true, [live, newSurface, workbenchOnly])
    expect(reveal).toHaveBeenCalledTimes(2)
    expect(controls.open).toHaveBeenCalledTimes(1)
  } finally {
    dispose()
    expect(registry.entries('conversation.view')).toHaveLength(0)
    await ctx.fiber.dispose()
  }
})

it('names the tab «Views» and counts the panels it lists', async () => {
  const ctx = new Context()
  const registry = new SlotRegistry(ctx)
  registry.declare('conversation.view', { kind: 'list', scope: 'session' })
  const session = {
    sessionId: 'counted',
    subscribe: () => () => {},
    readiness: { getSnapshot: () => ({ status: 'ready' }), subscribe: () => () => {} },
  }
  const dispose = mountIntelligentUi({
    contributions: { conversationCards: testCards, workbenchPanels: testPanels },
    client: { sessions: { get: (id: string) => ({ id }) } } as never,
    registry,
    session: session as never,
    locale: { register: () => () => {}, t: (key: string) => `t:${key}` } as never,
    approval: () => {},
  })
  expect(registry.entries('conversation.view').map((entry) => entry.id)).toEqual(['builtin-intelligent-ui'])
  const context = { t: (key: string) => key, data: { session: { id: 'counted' } } }
  try {
    const client = controls.clients.at(-1)!
    client.publish(true, [])
    expect(controls.panel?.when(context)).toBe(false)
    const one = financeRecord()
    const two = financeRecord()
    two.surface.id = 'second-review'
    const inlineOnly = financeRecord()
    inlineOnly.surface.id = 'inline-only'
    inlineOnly.surface.placement = { inline: true, workbench: false }
    client.publish(true, [one, two, inlineOnly])
    expect(controls.panel?.when(context)).toBe(true)
    expect(controls.panel?.title(context)).toBe('t:ui.title')
    expect(controls.panel?.count.read(context)).toBe(2)
    const changed = vi.fn()
    const stop = controls.panel!.count.subscribe(changed)
    client.publish(true, [one])
    expect(changed).toHaveBeenCalled()
    expect(controls.panel?.count.read(context)).toBe(1)
    stop()
    expect(controls.panel?.when({ ...context, data: { session: { id: 'other' } } })).toBe(false)
  } finally {
    dispose()
    expect(registry.entries('conversation.view')).toHaveLength(0)
    await ctx.fiber.dispose()
  }
})
