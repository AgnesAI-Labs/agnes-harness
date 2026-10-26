/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UiActionReceipt, UiSurface, UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IntelligentSurface,
  type IntelligentSurfaceProps,
  intelligentUiCatalog,
} from '../src/intelligent-ui/index.js'
import { footerActionGroup, latestReceipt } from '../src/intelligent-ui/surface.js'
import { type UiLocale, UiLocaleProvider, type UiLocaleSource } from '../src/ui-locale.js'

const translator = (locale: UiLocale) => (key: string, vars?: Record<string, string | number>) =>
  (intelligentUiCatalog[locale][key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''))
const source = (locale: UiLocale): UiLocaleSource => ({
  getSnapshot: () => locale,
  getVersion: () => 0,
  subscribe: () => () => {},
  t: translator(locale),
  bind: () => translator(locale),
})

const surface = (): UiSurface => ({
  id: 'renewals',
  revision: 2,
  title: '续约跟进 · 待确认',
  placement: { inline: true, workbench: true, preferred: 'workbench' },
  components: [
    {
      id: 'kpis',
      kind: 'detail-card',
      dataKey: 'kpis',
      fields: [
        { key: 'due', label: '即将到期客户', format: 'number' },
        { key: 'low', label: '健康度偏低', format: 'number' },
        { key: 'open', label: '未结工单', format: 'number' },
      ],
    },
    {
      id: 'customers',
      kind: 'table',
      dataKey: 'customers',
      rowKey: 'id',
      selection: 'multiple',
      columns: [
        { key: 'name', label: '客户' },
        { key: 'health', label: '健康度', format: 'number' },
        { key: 'state', label: '状态', format: 'status' },
      ],
    },
    {
      id: 'note',
      kind: 'form',
      dataKey: 'note',
      schema: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', title: '跟进备注' },
          owner: { type: 'string', title: '负责人' },
        },
      },
    },
    { id: 'bar', kind: 'button-group', actionIds: ['write', 'cancel'] },
    { id: 'hint', kind: 'status', dataKey: 'hint' },
  ],
  data: {
    kpis: { due: 12, low: 4, open: 7 },
    customers: [
      { id: 'c1', name: '华东物流', health: 62, state: 'pending' },
      { id: 'c2', name: '北辰零售', health: 86, state: 'done' },
    ],
    note: { text: '本周内电话沟通' },
    hint: 'pending',
  },
  actions: [
    {
      id: 'write',
      label: '写入跟进记录',
      tool: 'crm_write',
      argsTemplate: {},
      paramsSchema: true,
      style: 'primary',
    },
    { id: 'cancel', label: '取消', tool: 'crm_cancel', argsTemplate: {}, paramsSchema: true },
  ],
})
const record = (owner = 'acme/crm-followup', value = surface()): UiSurfaceRecord => ({
  surface: value,
  status: 'open',
  createdSeq: 3,
  updatedSeq: 9,
  owner,
  lane: 'main',
  taskId: 'crm',
})
const receipt = (status: UiActionReceipt['status'], seq = 10): UiActionReceipt => ({
  sessionId: 's1',
  surfaceId: 'renewals',
  revision: 2,
  actionId: 'write',
  commandId: `cmd-${seq}`,
  status,
  seq,
  duplicate: false,
})

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})
const mount = async (overrides: Partial<IntelligentSurfaceProps> = {}, locale: UiLocale = 'zh-CN') => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const props: IntelligentSurfaceProps = {
    record: record(),
    placement: 'workbench',
    input: {},
    selection: {},
    receipts: [],
    locked: false,
    invalid: false,
    needsReview: false,
    draftChanged: false,
    transportPending: false,
    onInput: vi.fn(),
    onSelection: vi.fn(),
    onInvalid: vi.fn(),
    onAction: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onReview: vi.fn(),
    onRecover: vi.fn(),
    onExpand: vi.fn(),
    onApproval: vi.fn(),
    ...overrides,
  }
  await act(async () =>
    root.render(
      createElement(UiLocaleProvider, { source: source(locale) }, createElement(IntelligentSurface, props)),
    ),
  )
  cleanup = async () => {
    await act(async () => root.unmount())
    host.remove()
  }
  return { host, props }
}
const openMenu = async (host: HTMLElement) => {
  await act(async () => host.querySelector<HTMLButtonElement>('header .agh-menu-anchor button')!.click())
  return (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
}

describe('surface panel frame', () => {
  it('heads the panel with an icon, the single title and its source and revision', async () => {
    const { host } = await mount()
    const header = host.querySelector('header')!
    expect(header.querySelector('.agnes-intelligent-icon svg')).not.toBeNull()
    expect(header.querySelector('h3')?.textContent).toBe('续约跟进 · 待确认')
    expect(header.querySelector('[data-testid="ui-meta"]')?.textContent).toBe(
      '来自 acme/crm-followup · 修订 2',
    )
  })

  it('leaves the built-in owner out of the source line', async () => {
    const { host } = await mount({ record: record('agnes/intelligent-ui') }, 'en')
    expect(host.querySelector('[data-testid="ui-meta"]')?.textContent).toBe('Revision 2')
  })

  it('pairs the source with the card id in the technical source block', async () => {
    const { host } = await mount()
    await openMenu(host)
    const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === '技术来源',
    )
    await act(async () => entry!.click())
    const list = host.querySelector<HTMLElement>('[data-testid="ui-source"]')!
    expect([...list.querySelectorAll('dt')].map((node) => node.textContent)).toEqual(['来源', '卡片编号'])
    const values = [...list.querySelectorAll('dd')]
    expect(values.map((node) => node.textContent)).toEqual(['acme/crm-followup', surface().id])
    // The row is truncated by CSS, so the whole id has to stay readable from the title.
    expect(values[1]?.getAttribute('title')).toBe(surface().id)
  })

  it('offers locate, hide from conversation and close in the ⋯ menu', async () => {
    const onLocate = vi.fn(),
      onDismiss = vi.fn(),
      onClose = vi.fn()
    const { host } = await mount({ onLocate, onDismiss, onClose })
    let item = await openMenu(host)
    expect(item('ui-locate')?.textContent).toBe('在对话中定位')
    expect(item('ui-dismiss')?.textContent).toBe('从对话中隐藏')
    expect(item('ui-close')?.textContent).toBe('关闭')
    await act(async () => item('ui-locate')!.click())
    expect(onLocate).toHaveBeenCalledOnce()
    item = await openMenu(host)
    await act(async () => item('ui-dismiss')!.click())
    expect(onDismiss).toHaveBeenCalledOnce()
    item = await openMenu(host)
    await act(async () => item('ui-close')!.click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('offers to show a hidden surface in the conversation again', async () => {
    const onRestore = vi.fn()
    const { host } = await mount({ onRestore })
    const item = await openMenu(host)
    expect(item('ui-dismiss')).toBeNull()
    await act(async () => item('ui-restore')!.click())
    expect(onRestore).toHaveBeenCalledOnce()
  })

  it('lifts a trailing button group into the footer, secondary first and the primary last', async () => {
    const onAction = vi.fn()
    const { host } = await mount({ onAction })
    const footer = host.querySelector('[data-testid="ui-footer"]')!
    const buttons = [...footer.querySelectorAll<HTMLButtonElement>('[data-testid^="ui-action-"]')]
    expect(buttons.map((button) => button.textContent)).toEqual(['取消', '写入跟进记录'])
    expect(buttons[1]?.className).toContain('agh-btn--primary')
    expect(host.querySelector('[data-testid="ui-component-bar"]')).toBeNull()
    expect(host.querySelector('.agnes-intelligent-body [data-testid="ui-component-hint"]')).not.toBeNull()
    await act(async () => buttons[1]!.click())
    expect(onAction).toHaveBeenCalledWith(surface().actions[0])
    expect(footer.querySelector('[data-testid="ui-action-state"]')).toBeNull()
  })

  it('keeps a button group that is followed by content in place', () => {
    const value = surface()
    value.components.push({ id: 'more', kind: 'text', dataKey: 'hint' })
    expect(footerActionGroup(value)).toBeUndefined()
    expect(footerActionGroup(surface())).toEqual({ componentId: 'bar', actionIds: ['cancel', 'write'] })
  })

  it.each([
    ['received', '已接收动作', 'info'],
    ['executing', '正在执行动作', 'info'],
    ['pending-approval', '等待权限审批', 'warning'],
    ['succeeded', '动作成功', 'success'],
    ['failed', '动作失败', 'error'],
    ['rejected', '动作已拒绝', 'error'],
  ] as const)(
    'reports the latest %s action record on the left of the action bar',
    async (status, label, tone) => {
      const onApproval = vi.fn()
      const latest = receipt(status, 12)
      const { host } = await mount({ receipts: [receipt('succeeded', 4), latest], onApproval })
      const state = host.querySelector('[data-testid="ui-footer"] [data-testid="ui-action-state"]')!
      expect(state.getAttribute('data-state')).toBe(status)
      const tag = state.querySelector('.agnes-intelligent-tag')!
      expect(tag.textContent).toBe(label)
      expect(tag.getAttribute('data-tone')).toBe(tone)
      const locate = state.querySelector<HTMLButtonElement>('[data-testid="ui-locate-approval"]')
      expect(locate !== null).toBe(status === 'pending-approval')
      if (locate) {
        expect(locate.textContent).toBe('定位审批')
        await act(async () => locate.click())
        expect(onApproval).toHaveBeenCalledWith(latest)
      }
      const delivered = state.querySelector('[data-testid="ui-action-delivered"]')
      expect(delivered?.textContent ?? null).toBe(
        ['succeeded', 'failed', 'rejected'].includes(status) ? '结果已投递给智能体' : null,
      )
    },
  )

  it('picks the latest action record by sequence', () => {
    expect(latestReceipt([receipt('executing', 9), receipt('received', 3)])?.seq).toBe(9)
    expect(latestReceipt([])).toBeUndefined()
  })
})

describe('preset components inside the frame', () => {
  it('shows two to four figures as metric tiles with tabular numbers', async () => {
    const { host } = await mount()
    const card = host.querySelector('[data-testid="ui-detail-kpis"]')!
    expect(card.getAttribute('data-variant')).toBe('metrics')
    expect([...card.querySelectorAll('dd')].map((node) => node.textContent)).toEqual(['12', '4', '7'])
    expect(card.querySelectorAll('dd[data-numeric]')).toHaveLength(3)
  })

  it('keeps a mixed detail card as a label and value list', async () => {
    const value = surface()
    value.data.kpis = { due: 12, low: 'n/a', open: 7 }
    const { host } = await mount({ record: record(undefined, value) })
    expect(host.querySelector('[data-testid="ui-detail-kpis"]')?.hasAttribute('data-variant')).toBe(false)
  })

  it('right-aligns figures, shows states as tags and marks selected rows', async () => {
    const { host } = await mount({ selection: { customers: ['c1'] } })
    const table = host.querySelector('[data-testid="ui-table-customers"]')!
    const health = [...table.querySelectorAll('tbody td[data-numeric]')].map((cell) => cell.textContent)
    expect(health).toEqual(['62', '86'])
    const tags = [...table.querySelectorAll('tbody .agnes-intelligent-tag')]
    expect(tags.map((tag) => tag.getAttribute('data-tone'))).toEqual(['warning', 'success'])
    const picked = table.querySelector<HTMLInputElement>('[data-testid="ui-select-customers-c1"]')!
    expect(picked.checked).toBe(true)
    expect(picked.closest('tr')?.className).toContain('ant-table-row-selected')
    expect(table.querySelector<HTMLInputElement>('[data-testid="ui-select-customers-c2"]')?.checked).toBe(
      false,
    )
  })

  it('puts each form label above its control and marks required fields', async () => {
    const { host } = await mount()
    const required = host.querySelector('[data-testid="ui-field-text"]')!
    expect(required.hasAttribute('data-required')).toBe(true)
    expect(required.querySelector('.visually-hidden')?.textContent).toBe('必填')
    const label = required.querySelector('label')!
    expect(label.textContent).toBe('跟进备注')
    const control = required.querySelector('input')!
    expect(label.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(control.value).toBe('本周内电话沟通')
    const optional = host.querySelector('[data-testid="ui-field-owner"]')!
    expect(optional.hasAttribute('data-required')).toBe(false)
    expect(optional.querySelector('label')?.textContent).toBe('负责人')
  })
})

describe('the card inside an answer', () => {
  it('shares the frame and offers the workbench from its compact footer', async () => {
    const onExpand = vi.fn()
    const value = surface()
    value.placement = { inline: true, workbench: true, preferred: 'inline' }
    const { host } = await mount({
      record: record(undefined, value),
      placement: 'inline',
      inAnswer: true,
      onExpand,
    })
    const card = host.querySelector('[data-testid="ui-surface-renewals"]')!
    expect(card.getAttribute('data-in-answer')).toBe('true')
    expect(card.querySelector('.agnes-intelligent-icon')).not.toBeNull()
    expect(card.querySelector('[data-testid="ui-meta"]')?.textContent).toBe('来自 acme/crm-followup · 修订 2')
    expect(card.querySelector('.agnes-intelligent-body')?.hasAttribute('data-capped')).toBe(true)
    const link = card.querySelector<HTMLButtonElement>(
      '[data-testid="ui-footer"] [data-testid="ui-card-workbench"]',
    )!
    expect(link.textContent).toBe('在工作台中打开')
    await act(async () => link.click())
    expect(onExpand).toHaveBeenCalledOnce()
    expect(card.querySelector('[data-testid="ui-footer"] [data-testid="ui-action-write"]')).not.toBeNull()
  })
})
