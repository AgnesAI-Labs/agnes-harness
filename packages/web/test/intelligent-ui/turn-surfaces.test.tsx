/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UITurn } from '@agnes/protocol'
import type { UiReadParams, UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import { createDocumentLocaleSource } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IntelligentUiClient } from '../../../web-conversation/src/intelligent-ui/client.js'
import {
  IntelligentInline,
  newSurfacePlacements,
  type UiPlacementBinding,
} from '../../../web-conversation/src/intelligent-ui/placements.js'
import {
  attachIntelligentBinding,
  TurnViews,
} from '../../../web-conversation/src/intelligent-ui/turn-views.js'
import { uiPage } from './fixture.js'

/** The owner's case: a display-only outline the model rendered with ui_render. */
const outline = (
  text = 'D1 抵达 · 新街口 | D2 玄武湖 · 城墙',
  revision = 1,
  status: UiSurfaceRecord['status'] = 'open',
  preferred: 'inline' | 'workbench' = 'inline',
): UiSurfaceRecord => ({
  owner: 'agnes/intelligent-ui',
  lane: 'main',
  taskId: 'outline',
  createdSeq: 3,
  updatedSeq: 3 + revision,
  status,
  surface: {
    id: 'outline',
    revision,
    title: '行程框架',
    placement: { inline: true, workbench: true, preferred },
    components: [{ id: 'note', kind: 'text', dataKey: 'note' }],
    data: { note: text },
    actions: [],
  },
})
const table = (preferred: 'inline' | 'workbench'): UiSurfaceRecord => ({
  ...outline(),
  surface: {
    id: 'routes',
    revision: 1,
    title: 'Routes',
    placement: { inline: true, workbench: true, preferred },
    components: [
      {
        id: 'rows',
        kind: 'table',
        dataKey: 'rows',
        rowKey: 'id',
        selection: 'none',
        columns: [{ key: 'day', label: 'Day' }],
      },
    ],
    data: { rows: [{ id: '1', day: 'D1' }] },
    actions: [],
  },
})

const turn = { id: 'turn-1', turn: 1, startSeq: 1, endSeq: 10, nodeIds: [] } as unknown as UITurn

async function mount(server: { records: UiSurfaceRecord[] }, surfaceIds: string[] = []) {
  const reads: UiReadParams[] = []
  const client = new IntelligentUiClient('session-finance', {
    // Like the service: the page lists open surfaces; a surface id reads that one, open or closed.
    read: async (params) => {
      reads.push(params)
      return {
        ...uiPage(server.records[0], [], 20),
        surfaces: server.records.filter((record) =>
          params.surfaceId ? record.surface.id === params.surfaceId : record.status === 'open',
        ),
      }
    },
    refresh: async () => server.records[0]!,
    action: async () => {
      throw new Error('no actions')
    },
    listen: () => () => {},
    attach: async () => {},
  })
  await client.start()
  const locale = createDocumentLocaleSource({})
  const binding: UiPlacementBinding = {
    subscribe: (listener) => client.subscribe(listener),
    getSnapshot: () => client,
    getVersion: () => client.getVersion(),
    locale: locale.source,
    target: () => undefined,
    expand: vi.fn(),
    approval: vi.fn(),
  }
  const detach = attachIntelligentBinding(binding)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(
        'div',
        {},
        createElement('div', { 'data-testid': 'turn' }, createElement(TurnViews, { turn, surfaceIds })),
        createElement(IntelligentInline, { binding }),
      ),
    ),
  )
  await act(async () => {})
  return {
    host,
    client,
    binding,
    reads,
    cleanup: async () => {
      await act(async () => root.unmount())
      detach()
      client.dispose()
      locale.dispose()
      host.remove()
    },
  }
}
const inTurn = (host: HTMLElement, id: string) =>
  host.querySelector<HTMLElement>(`[data-testid="turn"] [data-testid="ui-surface-${id}"]`)

describe('views inside the answer', () => {
  it('shows an inline-preferred view as a card in its answer, with no chip and no workbench', async () => {
    const view = await mount({ records: [outline()] })
    try {
      const card = inTurn(view.host, 'outline')
      expect(card?.getAttribute('data-in-answer')).toBe('true')
      expect(card?.textContent).toContain('D1 抵达')
      expect(view.host.querySelector('[data-testid="ui-dock"]')).toBeNull()
      expect(
        view.host.querySelector('[data-testid="intelligent-ui-inline"] [data-testid^="ui-surface-"]'),
      ).toBeNull()
      expect(newSurfacePlacements(new Set(), [outline()]).showWorkbench).toBe(false)
      // A workbench-only view follows its placement, text or not: it opens the workbench once.
      const workbenchOnly = outline()
      workbenchOnly.surface.placement = { inline: false, workbench: true }
      expect(newSurfacePlacements(new Set(), [workbenchOnly]).showWorkbench).toBe(true)
    } finally {
      await view.cleanup()
    }
  })

  it('opens the workbench only from the card menu', async () => {
    const view = await mount({ records: [outline()] })
    try {
      const card = inTurn(view.host, 'outline')!
      expect(card.querySelector('[data-testid="ui-expand"]')).toBeNull()
      await act(async () => card.querySelector<HTMLButtonElement>('header .agh-menu-anchor button')!.click())
      await act(async () => document.querySelector<HTMLElement>('[data-testid="ui-expand"]')!.click())
      expect(view.binding.expand).toHaveBeenCalledWith('outline', 1)
    } finally {
      await view.cleanup()
    }
  })

  it('updates the card in place and keeps a closed card after reload', async () => {
    const server = { records: [outline()] }
    const view = await mount(server, ['outline'])
    try {
      server.records = [outline('D1 抵达 · 夫子庙夜景', 2)]
      await act(async () => view.client.refresh())
      expect(view.host.querySelectorAll('[data-testid="turn"] [data-testid^="ui-surface-"]')).toHaveLength(1)
      expect(inTurn(view.host, 'outline')?.getAttribute('data-revision')).toBe('2')
      expect(inTurn(view.host, 'outline')?.textContent).toContain('夫子庙夜景')
    } finally {
      await view.cleanup()
    }
    // Reload: the session page lists open views only; the turn's ui_render result names the closed one.
    const reloaded = await mount({ records: [outline('D1 抵达 · 夫子庙夜景', 2, 'closed')] }, ['outline'])
    try {
      expect(reloaded.reads.some((params) => params.surfaceId === 'outline')).toBe(true)
      const card = inTurn(reloaded.host, 'outline')
      expect(card?.textContent).toContain('夫子庙夜景')
      expect(card?.textContent).toContain('Closed')
    } finally {
      await reloaded.cleanup()
    }
  })

  it('caps a large view with «show all», and leaves workbench-preferred views as chips', async () => {
    // Layout is not computed here: report a capped body taller than its box.
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900)
    const view = await mount({
      records: [
        table('inline'),
        { ...table('workbench'), createdSeq: 4, surface: { ...table('workbench').surface, id: 'wide' } },
      ],
    })
    try {
      const card = inTurn(view.host, 'routes')!
      expect(card.querySelector('.agnes-intelligent-body')?.hasAttribute('data-capped')).toBe(true)
      await act(async () => card.querySelector<HTMLElement>('[data-testid="ui-card-more"]')!.click())
      expect(card.querySelector('.agnes-intelligent-body')?.hasAttribute('data-capped')).toBe(false)
      expect(inTurn(view.host, 'wide')).toBeNull()
      expect(
        view.host.querySelector('[data-testid="ui-dock"] [data-testid="ui-surface-wide"]'),
      ).not.toBeNull()
    } finally {
      height.mockRestore()
      await view.cleanup()
    }
  })
})

describe('placement flags on the special paths', () => {
  it('keeps a workbench-only text view out of the answer and points at it from the conversation', async () => {
    const record = outline()
    record.surface.placement = { inline: false, workbench: true }
    const view = await mount({ records: [record] })
    try {
      expect(inTurn(view.host, 'outline')).toBeNull()
      expect(
        view.host.querySelector('[data-testid="intelligent-ui-inline"] [data-testid="ui-surface-outline"]'),
      ).not.toBeNull()
    } finally {
      await view.cleanup()
    }
  })
})
