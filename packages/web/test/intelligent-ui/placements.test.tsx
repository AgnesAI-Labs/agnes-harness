/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { createDocumentLocaleSource } from '@agnes/web-ui'
import { IntelligentUiClient } from '../../src/intelligent-ui/client.js'
import {
  IntelligentInline,
  IntelligentPanel,
  type UiPlacementBinding,
} from '../../src/intelligent-ui/placements.js'
import { financeRecord, uiPage, uiReceipt } from './fixture.js'

const mounted = async (receipt = uiReceipt('pending-approval')) => {
  const client = new IntelligentUiClient('session-finance', {
    read: async () => uiPage(financeRecord(), [receipt], 20),
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
  it('renders the same revision/receipt in both places and opens the original approval', async () => {
    const { host, binding, cleanup } = await mounted()
    try {
      const surfaces = host.querySelectorAll('[data-testid="ui-surface-finance-review"]')
      expect(surfaces).toHaveLength(2)
      expect([...surfaces].map((node) => node.getAttribute('data-revision'))).toEqual(['1', '1'])
      expect(host.querySelectorAll('[data-status="pending-approval"]')).toHaveLength(2)
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
