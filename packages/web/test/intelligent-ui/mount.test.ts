import type { UiSurfaceRecord } from '@agnes/protocol'
import { expect, it, vi } from 'vitest'
import { mountIntelligentUi } from '../../src/intelligent-ui/mount.js'
import { financeRecord } from './fixture.js'

const controls = vi.hoisted(() => ({
  clients: [] as { publish(ready: boolean, surfaces: UiSurfaceRecord[]): void }[],
  open: vi.fn(),
}))
vi.mock('../../src/intelligent-ui/client.js', () => ({
  IntelligentUiClient: class {
    snapshot = { ready: false, surfaces: [] as UiSurfaceRecord[] }
    listener?: () => void
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
vi.mock('../../src/intelligent-ui/server.js', () => ({ intelligentUiServer: () => ({}) }))
vi.mock('../../src/intelligent-ui/placements.js', async (original) => ({
  ...(await original<object>()),
  openIntelligentPanel: controls.open,
}))
vi.mock('@agnes/web-client', () => ({ workbenchPanels: { register: () => () => {} } }))
vi.mock('@agnes/web-ui', () => ({
  createDocumentLocaleSource: () => ({ source: {}, dispose() {} }),
  INTELLIGENT_UI_NAMESPACE: 'ui',
  intelligentUiCatalog: {},
}))

it('seeds loaded revisions on every session and reveals only live new revisions', () => {
  let switched!: () => void
  const session = {
    sessionId: 'first',
    subscribe: (listener: () => void) => {
      switched = listener
      return () => {}
    },
  }
  const reveal = vi.fn()
  const dispose = mountIntelligentUi({
    client: { sessions: { get: (id: string) => ({ id }) } } as never,
    registry: { spec: () => ({}), register: () => () => {} } as never,
    session: session as never,
    locale: { register: () => () => {} } as never,
    approval: () => {},
    revealInline: reveal,
  })
  const old = financeRecord()
  old.surface.id = 'loaded-review'
  const live = structuredClone(old)
  live.surface.revision = 2
  try {
    const first = controls.clients.at(-1)!
    first.publish(false, [old])
    first.publish(true, [old])
    first.publish(true, [old])
    expect(reveal).not.toHaveBeenCalled()
    expect(controls.open).not.toHaveBeenCalled()
    first.publish(true, [live])
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(controls.open).toHaveBeenCalledTimes(1)
    first.publish(true, [live])
    expect(reveal).toHaveBeenCalledTimes(1)
    session.sessionId = 'second'
    switched()
    controls.clients.at(-1)!.publish(true, [live])
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(controls.open).toHaveBeenCalledTimes(1)
    const newSurface = structuredClone(live)
    newSurface.surface.id = 'live-review'
    controls.clients.at(-1)!.publish(true, [live, newSurface])
    expect(reveal).toHaveBeenCalledTimes(2)
    expect(controls.open).toHaveBeenCalledTimes(2)
  } finally {
    dispose()
  }
})
