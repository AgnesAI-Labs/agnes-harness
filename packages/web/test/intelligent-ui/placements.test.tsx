/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UITurn } from '@agnes/protocol'
import type { ClientResourceService } from '@agnes/web-client'
import { workbenchPanels } from '@agnes/web-client'
import { createDocumentLocaleSource } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IntelligentUiClient } from '../../src/intelligent-ui/client.js'
import {
  hiddenSurfaces,
  IntelligentInline,
  IntelligentPanel,
  locateInConversation,
  newSurfacePlacements,
  type UiPlacementBinding,
  workbenchSurfaces,
} from '../../src/intelligent-ui/placements.js'
import { attachTurnDeliverables, TurnDeliverables } from '../../src/intelligent-ui/turn-deliverables.js'
import { WorkbenchDeliverables } from '../../src/intelligent-ui/workbench-deliverables.js'
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
        description: 'contract-review: final',
        artifact: { sha256: 'a'.repeat(64), size: 1024, mime: 'text/html' },
      },
    },
    summary: 'report.html — contract-review: final',
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
  // As in the app: file lists have their own tab, so the views tab leaves them out.
  const removeFilesTab = workbenchPanels.register({
    id: 'deliverables',
    order: 55,
    edge: 'right',
    titleKey: 'workbench.deliverables.title',
    component: () => null,
  })
  const detach = attachTurnDeliverables(binding)
  await act(async () =>
    root.render(
      createElement(
        'div',
        {},
        createElement('div', { 'data-testid': 'turn' }, createElement(TurnDeliverables, { turn })),
        createElement(IntelligentInline, { binding }),
        createElement(IntelligentPanel, {
          binding,
          context: { t: (key) => key, data: { session: { id: 'session-finance' } } },
        }),
        createElement(WorkbenchDeliverables, {
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
      removeFilesTab()
    },
  }
}

describe('shared Intelligent UI placements', () => {
  it.each([
    { inline: true, workbench: false },
    { inline: false, workbench: true },
  ] as const)('renders the complete view only in the enabled placement: %j', async (placement) => {
    const record = deliverablesRecord()
    record.surface.placement = placement
    const { host, cleanup } = await mounted(uiReceipt('succeeded'), record)
    try {
      const inline = host.querySelector('[data-testid="intelligent-ui-inline"]')!
      const workbench = host.querySelector('[data-testid="intelligent-ui-workbench"]')!
      // A file list is shown inside the answer of its turn, never again after the conversation.
      expect(inline.querySelector('[data-agnes-intelligent-ui="catalog"]')).toBeNull()
      expect(host.querySelector('[data-testid="turn-deliverables"]') !== null).toBe(placement.inline)
      // A file list is never one of the workbench views: the 交付物 tab lists its files instead.
      expect(workbench.querySelector('[data-agnes-intelligent-ui="catalog"]')).toBeNull()
      // Only a file list the workbench may show is listed there.
      const listed = host.querySelector(
        '[data-testid="workbench-deliverables"] [data-testid="deliverable-file"]',
      )?.textContent
      expect(listed?.includes('report.html') ?? false).toBe(placement.workbench)
      expect(newSurfacePlacements(new Set(), [record]).showWorkbench).toBe(!placement.inline)
    } finally {
      await cleanup()
    }
  })

  it('shows an actionable deliverables surface in the conversation and the workbench', async () => {
    const releasePreview = vi.fn(),
      releaseDownload = vi.fn()
    const loadPreview = vi.fn(async () => ({
      kind: 'html',
      artifact: deliverablesRecord().surface.data['file-0'],
      content: '<h1>Cities</h1><script>window.bad=1</script><img src="https://external.test">',
      release: releasePreview,
    }))
    const loadDownload = vi.fn(async () => ({ url: 'blob:synthetic', release: releaseDownload }))
    const resources = {
      documents: { load: loadPreview },
      files: { load: loadDownload },
    } as unknown as ClientResourceService
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.download).toBe('report.html')
      expect(this.href).toBe('blob:synthetic')
    })
    const { host, cleanup } = await mounted(uiReceipt('succeeded'), deliverablesRecord(), resources)
    try {
      const workbenchCopy = host.querySelector('[data-testid="workbench-deliverables"]')
      expect(
        workbenchCopy?.querySelector('[data-testid="deliverable-file"]')?.getAttribute('data-placement'),
      ).toBe('workbench')
      // The file list itself is no longer a card among the workbench views.
      expect(host.querySelectorAll('[data-testid="ui-surface-card-deliverable"]')).toHaveLength(0)
      const articles = [host.querySelector('[data-testid="turn-deliverables"]'), workbenchCopy]
      for (const article of articles) {
        expect(article?.textContent).toContain('report.html')
        // The version is said in plain words, without the package that wrote it.
        expect(article?.textContent).toContain('Final')
        expect(article?.textContent).not.toContain('contract-review')
        expect(article?.textContent).not.toContain('a'.repeat(64))
        if (article === workbenchCopy)
          expect(article?.querySelector('[data-testid="deliverable-open"]')?.textContent).toBe('Open')
        else {
          expect(article?.querySelector('[data-testid="deliverable-open"]')).toBeNull()
          expect(article?.querySelector('[data-testid="deliverable-target"]')).toBeTruthy()
        }
        expect(article?.querySelector('[data-testid="deliverable-open-with"]')).toBeTruthy()
        expect(article?.querySelector('.deliverable-tile')?.getAttribute('data-type')).toBe('html')
      }
      await act(async () => (articles[0]?.querySelector('.deliverable-row') as HTMLElement)?.click())
      expect(loadPreview).toHaveBeenCalledWith({
        laneId: 'main',
        kind: 'html',
        artifact: { sha256: 'a'.repeat(64), size: 1024, mime: 'text/html' },
      })
      // The conversation card asks; the preview opens in the workbench copy of the same file.
      expect(articles[0]?.querySelector('[data-testid="deliverable-preview"]')).toBeNull()
      const frame = articles[1]?.querySelector<HTMLIFrameElement>('[data-document-preview="html"] iframe')
      // An HTML deliverable runs in its own sandboxed document; none of it becomes workbench markup.
      expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
      expect(frame?.getAttribute('src')).toBe('/__agnes/deliverable-preview')
      expect(host.textContent).not.toContain('Cities')
      expect(host.querySelector('script, img')).toBeNull()
      const posted = vi.fn()
      Object.defineProperty(frame, 'contentWindow', { value: { postMessage: posted }, configurable: true })
      // Only the frame's own ready message is answered, and it is answered with the page text.
      await act(async () =>
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'agnes-preview-ready' } })),
      )
      expect(posted).not.toHaveBeenCalled()
      await act(async () =>
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'agnes-preview-ready' },
            source: frame?.contentWindow as unknown as MessageEventSource,
          }),
        ),
      )
      expect(posted).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'agnes-preview-html', html: expect.stringContaining('Cities') }),
        '*',
      )
      await act(async () =>
        articles[1]?.querySelector<HTMLButtonElement>('[data-testid="deliverable-open"]')?.click(),
      )
      expect(articles[1]?.querySelector('[data-testid="deliverable-preview"]')).toBeNull()
      expect(articles[1]?.querySelector('[data-testid="deliverable-open"]')?.textContent).toBe('Open')
      await act(async () =>
        articles[0]?.querySelector<HTMLButtonElement>('[data-testid="deliverable-open-with"]')?.click(),
      )
      await act(async () =>
        document.querySelector<HTMLElement>('[data-testid="deliverable-download"]')?.click(),
      )
      expect(articles[1]?.querySelector('[data-testid="deliverable-preview"]')).toBeNull()
      expect(articles[0]?.querySelector('[data-testid="deliverable-preview"]')).toBeNull()
      expect(loadDownload).toHaveBeenCalledWith({
        laneId: 'main',
        artifact: { sha256: 'a'.repeat(64), size: 1024, mime: 'text/html' },
      })
      const seen = new Set<string>()
      const hiddenConversation = newSurfacePlacements(seen, [deliverablesRecord()])
      expect(hiddenConversation).toMatchObject({ showConversation: true, showWorkbench: false })
      for (const key of hiddenConversation.keys) seen.add(key)
      expect(newSurfacePlacements(seen, [deliverablesRecord()]).keys).toEqual([])
      const update = deliverablesRecord()
      update.surface.revision++
      expect(newSurfacePlacements(seen, [update]).keys).toEqual([])
      update.surface.id = 'workbench-only'
      update.surface.placement = { inline: false, workbench: true }
      expect(newSurfacePlacements(seen, [update]).showWorkbench).toBe(true)
    } finally {
      await cleanup()
      expect(releasePreview).toHaveBeenCalledOnce()
      expect(releaseDownload).toHaveBeenCalledOnce()
      anchor.mockRestore()
    }
  })

  it('localizes deliverable titles and releases a late preview after unmount', async () => {
    let resolve: ((value: unknown) => void) | undefined
    const release = vi.fn()
    const resources = {
      documents: {
        load: () =>
          new Promise((value) => {
            resolve = value
          }),
      },
      files: { load: vi.fn() },
    } as unknown as ClientResourceService
    const record = deliverablesRecord()
    const { host, cleanup } = await mounted(uiReceipt('succeeded'), record, resources)
    // Locale sources follow the document event, just like a live language change.
    document.documentElement.lang = 'zh-CN'
    await act(async () => window.dispatchEvent(new CustomEvent('agnes:locale-changed')))
    expect(host.querySelector('[data-testid="turn-deliverables"]')?.getAttribute('aria-label')).toBe('交付物')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="deliverable-target"]')?.click(),
    )
    await cleanup()
    await act(async () =>
      resolve?.({ kind: 'markdown', content: 'Late', artifact: record.surface.data['file-0'], release }),
    )
    expect(release).toHaveBeenCalledOnce()
    document.documentElement.lang = 'en'
  })

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

  it('leaves file lists to a deliverables tab once one is registered', () => {
    const files = deliverablesRecord()
    const view = financeRecord()
    expect(workbenchSurfaces([files, view]).map((record) => record.surface.id)).toEqual([
      'card-deliverable',
      'finance-review',
    ])
    const remove = workbenchPanels.register({
      id: 'deliverables',
      order: 65,
      edge: 'right',
      titleKey: 'deliverables',
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
