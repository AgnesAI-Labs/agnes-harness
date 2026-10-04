/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Approval, type ApprovalView } from '../src/approval.js'

it('renders two independently actionable approval cards with unique DOM identities', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  const host = document.createElement('div')
  const root = createRoot(host)
  const selected: string[] = []
  const view = (side: string): ApprovalView => ({
    key: side,
    summary: side,
    title: '确认',
    impact: '本侧会话',
    disabled: false,
    actions: [{ id: 'allow', label: '允许', onSelect: () => selected.push(side) }],
  })
  try {
    await act(async () =>
      root.render(
        createElement(
          'div',
          null,
          createElement(Approval, { initialView: view('left') }),
          createElement(Approval, { initialView: view('right') }),
        ),
      ),
    )
    const cards = host.querySelectorAll<HTMLElement>('[data-agnes-region-unit="approval"]')
    expect(cards).toHaveLength(2)
    expect(cards[0]?.id).not.toBe(cards[1]?.id)
    await act(async () => cards[1]?.querySelector('button')?.click())
    expect(selected).toEqual(['right'])
  } finally {
    await act(async () => root.unmount())
  }
})
