/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { ClientResourceService } from '@agnes/web-client'
import { createDocumentLocaleSource } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IntelligentUiClient } from '../../src/intelligent-ui/client.js'
import {
  IntelligentInline,
  IntelligentPanel,
  newSurfacePlacements,
  type UiPlacementBinding,
} from '../../src/intelligent-ui/placements.js'
import { financeRecord, uiPage, uiReceipt } from './fixture.js'

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
    subscribe: () => () => {},
    getSnapshot: () => client,
    getVersion: () => 0,
    locale: locale.source,
    ...(resources ? { resources } : {}),
    target: () => undefined,
    expand: vi.fn(),
    approval: vi.fn(),
  }
  const host = document.createElement('div'),
    root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(
        'div',
        {},
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
      client.dispose()
      locale.dispose()
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
      expect(inline.querySelector('[data-agnes-intelligent-ui="catalog"]') !== null).toBe(placement.inline)
      expect(workbench.querySelector('[data-agnes-intelligent-ui="catalog"]') !== null).toBe(
        placement.workbench,
      )
      expect(inline.querySelector('[data-testid="ui-expand"]') !== null).toBe(placement.workbench)
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
      const articles = [...host.querySelectorAll('[data-testid="ui-surface-card-deliverable"]')]
      expect(articles.map((node) => node.getAttribute('data-placement'))).toEqual(['inline', 'workbench'])
      for (const article of articles) {
        expect(article.hasAttribute('hidden')).toBe(false)
        expect((article as HTMLElement).hidden).toBe(false)
        expect(article.textContent).toContain('Deliverables')
        expect(article.textContent).toContain('report.html')
        expect(article.textContent).toContain('contract-review: final')
        expect(article.textContent).not.toContain('a'.repeat(64))
        expect(article.querySelector('[data-testid="deliverable-open"]')).toBeTruthy()
        expect(article.querySelector('[data-testid="deliverable-download"]')).toBeTruthy()
      }
      expect(articles[0]?.querySelector('[data-agnes-intelligent-ui="catalog"]')).toBeTruthy()
      expect(articles[1]?.querySelector('[data-agnes-intelligent-ui="catalog"]')).toBeTruthy()
      await act(async () =>
        (articles[0]?.querySelector('[data-testid="deliverable-open"]') as HTMLButtonElement)?.click(),
      )
      expect(loadPreview).toHaveBeenCalledWith({
        laneId: 'main',
        kind: 'html',
        artifact: { sha256: 'a'.repeat(64), size: 1024, mime: 'text/html' },
      })
      expect(articles[0]?.querySelector('[data-document-preview="html"]')?.textContent).toContain('Cities')
      expect(articles[0]?.querySelector('script, img')).toBeNull()
      await act(async () =>
        (articles[0]?.querySelector('[data-testid="deliverable-download"]') as HTMLButtonElement)?.click(),
      )
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
    expect(host.querySelector('h3')?.textContent).toBe('交付物')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="deliverable-open"]')?.click())
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
      expect(host.querySelectorAll('[data-status="pending-approval"]')).toHaveLength(1)
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="ui-expand"]')!.click())
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
      expect(reasons.map((input) => input.value)).toEqual(['Human review'])
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
