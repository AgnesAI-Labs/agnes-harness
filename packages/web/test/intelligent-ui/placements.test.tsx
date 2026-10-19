/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UITurn } from '@agnes/protocol'
import type { ClientResourceService } from '@agnes/web-client'
import { conversationCards } from '@agnes/web-client'
import { createDocumentLocaleSource } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IntelligentUiClient } from '../../../web-conversation/src/intelligent-ui/client.js'
import {
  hiddenSurfaces,
  IntelligentInline,
  IntelligentPanel,
  locateInConversation,
  type UiPlacementBinding,
  workbenchSurfaces,
} from '../../../web-conversation/src/intelligent-ui/placements.js'
import {
  attachIntelligentBinding,
  TurnViews,
} from '../../../web-conversation/src/intelligent-ui/turn-views.js'
import { financeRecord, uiPage, uiReceipt } from './fixture.js'

const turn = { id: 'turn-1', turn: 1, startSeq: 1 } as UITurn

const deliverablesRecord = () => {
  const record = financeRecord()
  record.surface = {
    ...record.surface,
    id: 'card-deliverable',
    title: 'Deliverables',
    titleKey: 'ui.deliverables',
    placement: { inline: true, workbench: true, preferred: 'inline' },
    components: [{ id: 'file-0', kind: 'artifact-file', dataKey: 'file-0' }],
    data: {
      'file-0': {
        name: 'report.html',
        description: 'data-report: final',
        artifact: { sha256: 'a'.repeat(64), size: 1024, mime: 'text/html' },
      },
    },
    summary: 'report.html — data-report: final',
    actions: [],
  }
  return record
}

const mounted = async (
  receipt = uiReceipt('pending-approval'),
  record = financeRecord(),
  resources?: ClientResourceService,
  extra: Partial<UiPlacementBinding> = {},
) => {
  const client = new IntelligentUiClient('session-finance', {
    read: async () => uiPage(record, [receipt], 20),
    refresh: async () => record,
    action: async () => receipt,
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
    ...(resources ? { resources } : {}),
    target: () => undefined,
    expand: vi.fn(),
    approval: vi.fn(),
    ...extra,
  }
  const host = document.createElement('div'),
    root = createRoot(host)
  const detach = attachIntelligentBinding(binding)
  await act(async () =>
    root.render(
      createElement(
        'div',
        {},
        createElement('div', { 'data-testid': 'turn' }, createElement(TurnViews, { turn })),
        createElement(IntelligentInline, { binding }),
        createElement(IntelligentPanel, {
          binding,
          context: { t: (key) => key, data: { session: { id: 'session-finance' } } },
        }),
      ),
    ),
  )
  return {
    client,
    binding,
    locale,
    host,
    root,
    cleanup: async () => {
      await act(async () => root.unmount())
      detach()
      client.dispose()
      locale.dispose()
    },
  }
}

describe('shared Intelligent UI placements', () => {
  it('renders the same revision/receipt in both places and opens the original approval', async () => {
    const { host, binding, cleanup } = await mounted()
    try {
      const surfaces = host.querySelectorAll('[data-testid="ui-surface-finance-review"]')
      expect(surfaces).toHaveLength(2)
      expect([...surfaces].map((node) => node.getAttribute('data-revision'))).toEqual(['1', '1'])
      // The answer and the workbench show the same complete view, receipts included.
      expect(host.querySelectorAll('[data-status="pending-approval"]')).toHaveLength(2)
      // Inside the answer the view opens in the workbench from its ⋯ menu.
      const card = host.querySelector('[data-testid="turn"] [data-testid="ui-surface-finance-review"]')!
      expect(card.getAttribute('data-in-answer')).toBe('true')
      await act(async () => card.querySelector<HTMLButtonElement>('header .agh-menu-anchor button')!.click())
      await act(async () => document.querySelector<HTMLElement>('[data-testid="ui-expand"]')!.click())
      expect(binding.expand).toHaveBeenCalledWith('finance-review', 1)
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="ui-open-approval"]')!.click(),
      )
      expect(binding.approval).toHaveBeenCalledWith(uiReceipt('pending-approval'))
      const ids = [...host.querySelectorAll('[id]')].map((node) => node.id)
      expect(new Set(ids).size).toBe(ids.length)
    } finally {
      await cleanup()
    }
  })

  it('reflects a shared edit and selection in both placements', async () => {
    const { host, client, cleanup } = await mounted(uiReceipt('succeeded'))
    try {
      await act(async () => {
        client.setInput('finance-review', 'adjustment', { reason: 'Human review' })
        client.setSelection('finance-review', 'differences', ['txn-1'])
      })
      expect(
        [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(
          (input) => input.checked,
        ),
      ).toBe(true)
      const reasons = [...host.querySelectorAll<HTMLInputElement>('[data-testid="ui-form-adjustment"] input')]
      expect(reasons.map((input) => input.value)).toEqual(['Human review', 'Human review'])
    } finally {
      await cleanup()
    }
  })

  it('localizes unknown effect lock and omits retry', async () => {
    document.documentElement.lang = 'zh-CN'
    const { host, cleanup } = await mounted(
      uiReceipt('failed', {
        failure: { code: 'GAP', message: 'Unknown', retryable: false, outcomeUnknown: true },
      }),
    )
    try {
      expect(host.textContent).toContain('结果未知')
      expect(host.querySelector('[data-testid="ui-retry"]')).toBeNull()
      expect(
        [...host.querySelectorAll<HTMLButtonElement>('[data-testid="ui-action-confirm"]')].every(
          (button) => button.disabled,
        ),
      ).toBe(true)
    } finally {
      await cleanup()
      document.documentElement.lang = 'en'
    }
  })
})

describe('the workbench «Views» tab', () => {
  const panel = (host: HTMLElement) =>
    host.querySelector<HTMLElement>('[data-testid="intelligent-ui-panel"]')!
  const menuItem = async (scope: HTMLElement, id: string) => {
    await act(async () => scope.querySelector<HTMLButtonElement>('header .agh-menu-anchor button')!.click())
    return document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
  }

  it('closes a panel here only, lists it as closed and shows it again', async () => {
    sessionStorage.clear()
    const { host, cleanup } = await mounted(uiReceipt('succeeded'))
    try {
      const view = panel(host)
      expect(view.className).toContain('agnes-intelligent-panel')
      expect(view.querySelector('[data-testid="ui-panel-foot"]')?.textContent).toContain(
        'Actions here go through the usual permission approval',
      )
      await act(async () => (await menuItem(view, 'ui-close')).click())
      expect(view.querySelector('[data-testid="ui-surface-finance-review"]')).toBeNull()
      // The conversation keeps its card: closing is a workbench presentation choice.
      expect(
        host.querySelector('[data-testid="turn"] [data-testid="ui-surface-finance-review"]'),
      ).not.toBeNull()
      expect(view.querySelector('[data-testid="ui-panel-closed"]')?.textContent).toBe('1 closed')
      expect(hiddenSurfaces('panel', 'session-finance').has('finance-review')).toBe(true)
      expect(sessionStorage.getItem('agnes.ui.panel.closed:session-finance')).toBe('["finance-review"]')
      await act(async () =>
        view.querySelector<HTMLButtonElement>('[data-testid="ui-panel-restore"]')!.click(),
      )
      expect(view.querySelector('[data-testid="ui-surface-finance-review"]')).not.toBeNull()
      expect(view.querySelector('[data-testid="ui-panel-closed"]')).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('finds the surface in the conversation from its ⋯ menu', async () => {
    const locate = vi.fn()
    const { host, cleanup } = await mounted(uiReceipt('succeeded'), undefined, undefined, { locate })
    try {
      await act(async () => (await menuItem(panel(host), 'ui-locate')).click())
      expect(locate).toHaveBeenCalledWith('finance-review')
    } finally {
      await cleanup()
    }
  })

  it('hides and shows a docked chip in the conversation from the workbench', async () => {
    sessionStorage.clear()
    const record = financeRecord()
    record.surface.placement = { inline: true, workbench: true, preferred: 'workbench' }
    const { host, cleanup } = await mounted(uiReceipt('succeeded'), record)
    try {
      const chip = () =>
        host.querySelector('[data-testid="intelligent-ui-inline"] [data-testid="ui-surface-finance-review"]')
      expect(chip()).not.toBeNull()
      await act(async () => (await menuItem(panel(host), 'ui-dismiss')).click())
      expect(chip()).toBeNull()
      await act(async () => (await menuItem(panel(host), 'ui-restore')).click())
      expect(chip()).not.toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('reports the latest action state in the panel footer and locates its approval', async () => {
    const { host, binding, cleanup } = await mounted()
    try {
      const state = panel(host).querySelector('[data-testid="ui-footer"] [data-testid="ui-action-state"]')!
      expect(state.getAttribute('data-state')).toBe('pending-approval')
      await act(async () =>
        state.querySelector<HTMLButtonElement>('[data-testid="ui-locate-approval"]')!.click(),
      )
      expect(binding.approval).toHaveBeenCalledWith(uiReceipt('pending-approval'))
    } finally {
      await cleanup()
    }
  })

  it('yields surfaces to a matching presentation contribution independently of panel identity', () => {
    const files = deliverablesRecord()
    const view = financeRecord()
    expect(workbenchSurfaces([files, view]).map((record) => record.surface.id)).toEqual([
      'card-deliverable',
      'finance-review',
    ])
    const remove = conversationCards.register({
      id: 'community-surface-claim',
      order: 0,
      matches: (card) => card.kind === 'intelligent-ui.surface' && card.data === files,
      component: () => null,
    })
    try {
      expect(workbenchSurfaces([files, view]).map((record) => record.surface.id)).toEqual(['finance-review'])
    } finally {
      remove()
    }
  })

  it('scrolls to and marks the conversation card', () => {
    vi.useFakeTimers()
    const card = document.createElement('article')
    card.dataset.testid = 'ui-surface-renewals'
    card.dataset.placement = 'inline'
    const scroll = vi.fn()
    card.scrollIntoView = scroll
    document.body.append(card)
    try {
      expect(locateInConversation('renewals')).toBe(true)
      expect(scroll).toHaveBeenCalledOnce()
      expect(card.dataset.located).toBe('true')
      expect(document.activeElement).toBe(card)
      vi.advanceTimersByTime(2000)
      expect(card.dataset.located).toBeUndefined()
      expect(locateInConversation('missing')).toBe(false)
    } finally {
      card.remove()
      vi.useRealTimers()
    }
  })
})
