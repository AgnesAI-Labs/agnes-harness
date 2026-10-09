/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UiSurface } from '@agnes/protocol/gen/intelligent-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IntelligentCatalog, validIntelligentSurface } from '../src/intelligent-ui/index.js'

const surface: UiSurface = {
  id: 'finance',
  revision: 1,
  title: 'USD cents',
  placement: { inline: true, workbench: true },
  components: [
    {
      id: 'rows',
      kind: 'table',
      dataKey: 'rows',
      rowKey: 'id',
      columns: [
        { key: 'id', label: 'Transaction' },
        { key: 'amount', label: 'USD cents', format: 'currency' },
      ],
      selection: 'multiple',
      rowActionIds: ['approve'],
    },
    {
      id: 'form',
      kind: 'form',
      dataKey: 'draft',
      schema: { type: 'object', properties: { reason: { type: 'string' } } },
      actionIds: ['approve'],
    },
    {
      id: 'chart',
      kind: 'chart',
      dataKey: 'rows',
      chartType: 'bar',
      categoryKey: 'id',
      series: [{ key: 'amount', label: 'USD cents' }],
    },
    { id: 'buttons', kind: 'button-group', actionIds: ['approve'] },
    { id: 'text', kind: 'text', dataKey: 'text' },
    { id: 'status', kind: 'status', dataKey: 'text' },
  ],
  data: {
    rows: [{ id: 'txn-1', amount: 250 }],
    draft: { reason: 'Mismatch' },
    text: '<script>inert</script>',
  },
  actions: [
    { id: 'approve', label: 'Approve', tool: 'finance_approve', argsTemplate: {}, paramsSchema: true },
  ],
}

describe('preset Intelligent UI catalog', () => {
  it.each(['single', 'multiple'] as const)(
    'renders all presets with %s selection and keeps content inert',
    async (mode) => {
      const rendered = structuredClone(surface)
      const table = rendered.components[0]!
      if (table.kind !== 'table' || !('selection' in table)) throw new Error('Missing table fixture')
      table.selection = mode
      const host = document.createElement('div'),
        root = createRoot(host)
      const selection = vi.fn(),
        action = vi.fn()
      try {
        await act(async () =>
          root.render(
            createElement(IntelligentCatalog, {
              surface: rendered,
              input: {},
              selection: {},
              disabled: false,
              onInput: vi.fn(),
              onSelection: selection,
              onInvalid: vi.fn(),
              onAction: action,
            }),
          ),
        )
        expect(host.querySelectorAll('[data-testid^="ui-component-"]')).toHaveLength(6)
        expect(host.querySelector('script')).toBeNull()
        expect(host.textContent).toContain('<script>inert</script>')
        expect(host.textContent).toContain('250')
        expect(host.querySelector('svg')?.getAttribute('role')).toBe('img')
        await act(async () =>
          host.querySelector<HTMLInputElement>('[data-testid="ui-select-rows-txn-1"]')!.click(),
        )
        expect(selection).toHaveBeenCalledWith('rows', ['txn-1'])
        await act(async () =>
          host.querySelector<HTMLButtonElement>('[data-testid="ui-action-approve"]')!.click(),
        )
        expect(action).toHaveBeenCalledWith(surface.actions[0], { tableId: 'rows', rowId: 'txn-1' })
        await act(async () =>
          root.render(
            createElement(IntelligentCatalog, {
              surface: rendered,
              input: {},
              selection: {},
              disabled: true,
              onInput: vi.fn(),
              onSelection: selection,
              onInvalid: vi.fn(),
              onAction: action,
            }),
          ),
        )
        expect(
          host.querySelector<HTMLInputElement>(`input[type="${mode === 'single' ? 'radio' : 'checkbox'}"]`)!
            .disabled,
        ).toBe(true)
      } finally {
        await act(async () => root.unmount())
      }
    },
  )

  it.each(['line', 'pie'] as const)('renders %s with accessible source values', async (chartType) => {
    const chart = {
      ...surface,
      components: [
        {
          id: 'chart',
          kind: 'chart' as const,
          dataKey: 'rows',
          chartType,
          categoryKey: 'id',
          series: [{ key: 'amount', label: 'USD cents' }],
        },
      ],
    }
    const host = document.createElement('div'),
      root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          createElement(IntelligentCatalog, {
            surface: chart,
            input: {},
            selection: {},
            disabled: false,
            onInput: vi.fn(),
            onSelection: vi.fn(),
            onInvalid: vi.fn(),
            onAction: vi.fn(),
          }),
        ),
      )
      expect(host.querySelector('svg title')?.textContent).toBe('USD cents')
      expect(host.querySelector('table')?.textContent).toContain('txn-1')
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('refuses the entire surface for unsupported kinds, row errors, invalid chart and bounds', () => {
    expect(validIntelligentSurface(surface)).toBe(true)
    for (const bad of [
      { ...surface, components: [{ id: 'html', kind: 'html', dataKey: 'text' }] },
      {
        ...surface,
        data: {
          ...surface.data,
          rows: [
            { id: 'txn-1', amount: 250 },
            { id: 'txn-1', amount: 0 },
          ],
        },
      },
      { ...surface, data: { ...surface.data, rows: [{ id: 'txn-1' }] } },
      { ...surface, data: { ...surface.data, rows: [{ id: 'txn-1', amount: Infinity }] } },
      { ...surface, data: { ...surface.data, text: 'x'.repeat(32768) } },
      {
        ...surface,
        components: [
          { id: 'form', kind: 'form', dataKey: 'draft', schema: { $ref: 'https://untrusted.test/schema' } },
        ],
      },
    ])
      expect(validIntelligentSurface(bad)).toBe(false)
  })
})

it('renders schema choices as radio/checkbox and preserves free text in the form draft', async () => {
  const question: UiSurface = {
    id: 'question',
    revision: 1,
    title: 'Questions',
    placement: { inline: true, workbench: true },
    components: [
      {
        id: 'answers',
        kind: 'form',
        dataKey: 'draft',
        actionIds: ['submit'],
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['single', 'multi', 'text'],
          properties: {
            single: {
              title: 'Pick one',
              type: 'string',
              minLength: 1,
              maxLength: 8192,
              enum: ['A', 'B'],
              'x-ui-choices': ['A', 'B'],
            },
            multi: {
              title: 'Pick several',
              type: 'array',
              minItems: 1,
              maxItems: 12,
              uniqueItems: true,
              items: { type: 'string', minLength: 1, maxLength: 8192 },
              'x-ui-choices': ['A', 'B'],
            },
            text: { title: 'Explain', type: 'string', minLength: 1, maxLength: 8192 },
          },
        },
      },
    ],
    data: { draft: {} },
    actions: [
      {
        id: 'submit',
        label: 'Submit',
        tool: 'ui_submit',
        style: 'primary',
        argsTemplate: { surfaceId: { literal: 'question' }, answers: { from: 'input', key: 'answers' } },
        paramsSchema: {
          type: 'object',
          required: ['surfaceId', 'answers'],
          additionalProperties: false,
          properties: { surfaceId: { const: 'question' }, answers: { type: 'object' } },
        },
      },
    ],
  }
  const host = document.createElement('div'),
    root = createRoot(host)
  const input = vi.fn(),
    action = vi.fn()
  try {
    await act(async () =>
      root.render(
        createElement(IntelligentCatalog, {
          surface: question,
          input: {},
          selection: {},
          disabled: false,
          onInput: input,
          onSelection: vi.fn(),
          onInvalid: vi.fn(),
          onAction: action,
        }),
      ),
    )
    expect(host.querySelectorAll('input[type=radio]')).toHaveLength(2)
    expect(host.querySelectorAll('input[type=checkbox]')).toHaveLength(2)
    await act(async () => host.querySelector<HTMLInputElement>('[data-testid=ui-option-single-1]')!.click())
    expect(input).toHaveBeenLastCalledWith('answers', { single: 'B' })
    await act(async () => host.querySelector<HTMLInputElement>('[data-testid=ui-option-multi-0]')!.click())
    expect(input).toHaveBeenLastCalledWith('answers', { multi: ['A'] })
    expect(host.querySelector('[data-testid=ui-free-multi]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid=ui-action-submit]')!.click())
    expect(action).toHaveBeenCalledWith(question.actions[0], undefined)
  } finally {
    await act(async () => root.unmount())
  }
})
