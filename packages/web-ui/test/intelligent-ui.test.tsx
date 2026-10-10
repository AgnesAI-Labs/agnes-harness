/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UiSourceStatus, UiSurface } from '@agnes/protocol/gen/intelligent-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { IntelligentCatalog, validIntelligentSurface } from '../src/intelligent-ui/index.js'
import { type UiLocale, UiLocaleProvider, type UiLocaleSource } from '../src/ui-locale.js'

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
        const tableScroll = host.querySelector<HTMLElement>('.agnes-intelligent-table-scroll')
        expect(tableScroll?.tabIndex).toBe(0)
        expect(tableScroll?.getAttribute('role')).toBe('region')
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

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const sha = 'a'.repeat(64)
const presets: UiSurface = {
  id: 'presets',
  revision: 1,
  title: 'Presets',
  placement: { inline: true, workbench: true },
  components: [
    {
      id: 'card',
      kind: 'detail-card',
      title: 'Record',
      dataKey: 'record',
      fields: [
        { key: 'name', label: 'Name', format: 'text' },
        { key: 'amount', label: 'Amount', format: 'currency' },
        { key: 'posted', label: 'Posted', format: 'date' },
      ],
      statusKey: 'status',
      secondaryKey: 'note',
    },
    { id: 'flow', kind: 'steps', title: 'Flow', dataKey: 'steps' },
    { id: 'posted', kind: 'progress', dataKey: 'progress' },
    { id: 'scan', kind: 'image', dataKey: 'scan', alt: 'Receipt scan' },
    { id: 'proof', kind: 'image', title: 'Proof', dataKey: 'proof', alt: 'Authorized receipt' },
    {
      id: 'when',
      kind: 'form',
      dataKey: 'when',
      schema: {
        type: 'object',
        properties: {
          day: { type: 'string', format: 'date', title: 'Day' },
          at: { type: 'string', format: 'date-time', title: 'At' },
        },
      },
    },
    { id: 'note', kind: 'text', dataKey: 'note' },
    { id: 'state', kind: 'status', dataKey: 'state' },
    {
      id: 'sections',
      kind: 'tabs',
      title: 'Sections',
      tabs: [
        { id: 'main', label: 'Main', componentIds: ['note'] },
        { id: 'more', label: 'More', componentIds: ['state'] },
      ],
    },
  ],
  data: {
    record: { name: 'Ada', amount: 250, posted: '2026-10-10', status: 'open', note: 'Draft' },
    steps: [
      { id: 'review', label: 'Review', state: 'active', description: 'Check' },
      { id: 'record', label: 'Record', state: 'pending' },
    ],
    progress: { label: 'Posted', value: 1, total: 4 },
    scan: { source: { kind: 'data-url', dataUrl: png } },
    proof: { source: { kind: 'artifact', sha256: sha, size: 128, mime: 'image/png' } },
    when: { day: '2026-10-10', at: '2026-10-09T00:00:00Z' },
    note: 'Inside the first tab',
    state: 'Inside the second tab',
  },
  actions: [],
}

function localeSource(locale: UiLocale): UiLocaleSource {
  return {
    getSnapshot: () => locale,
    getVersion: () => 0,
    subscribe: () => () => undefined,
    t: (key) => key,
    bind: () => (key) => key,
  }
}

describe('expanded preset catalog', () => {
  it.each([
    ['', 'en', 'Active', '(25%)'],
    ['dark', 'en', 'Active', '(25%)'],
    ['', 'zh-CN', '进行中', '（25%）'],
    ['dark', 'zh-CN', '进行中', '（25%）'],
  ] as const)('renders every new preset in %s %s', async (theme, locale, active, percent) => {
    if (typeof window.matchMedia !== 'function') {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: (query: string) => ({
          matches: false,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return false
          },
        }),
      })
    }
    document.documentElement.className = theme
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          createElement(
            UiLocaleProvider,
            { source: localeSource(locale) },
            createElement(IntelligentCatalog, {
              surface: presets,
              input: {},
              selection: {},
              disabled: false,
              onInput: vi.fn(),
              onSelection: vi.fn(),
              onInvalid: vi.fn(),
              onAction: vi.fn(),
            }),
          ),
        ),
      )
      const rootIds = [
        ...host.querySelectorAll('.agnes-intelligent-catalog > [data-testid^="ui-component-"]'),
      ].map((node) => node.getAttribute('data-testid'))
      expect(rootIds).toContain('ui-component-card')
      expect(rootIds).toContain('ui-component-sections')
      expect(rootIds).not.toContain('ui-component-note')
      expect(host.querySelectorAll('[data-testid="ui-component-note"]')).toHaveLength(1)
      expect(host.querySelector('[data-testid="ui-detail-status-card"]')?.textContent).toBe('open')
      expect(host.querySelector('[data-testid="ui-detail-field-card-amount"]')?.textContent).toContain('250')
      expect(host.querySelector('[data-testid="ui-detail-field-card-posted"]')?.textContent).toContain('2026')
      expect(host.querySelector('[data-testid="ui-detail-secondary-card"]')?.textContent).toBe('Draft')
      expect(host.querySelector('[data-testid="ui-step-flow-review"]')?.getAttribute('aria-current')).toBe(
        'step',
      )
      expect(
        host.querySelector('[data-testid="ui-step-flow-review"] .agnes-ui-badge')?.getAttribute('data-tone'),
      ).toBe('warn')
      expect(host.textContent).toContain(active)
      expect(
        host
          .querySelector('[data-testid="ui-progress-posted"] [role="progressbar"]')
          ?.getAttribute('data-percent'),
      ).toBe('25')
      expect(host.querySelector('[data-testid="ui-progress-posted"]')?.textContent).toContain(percent)
      expect(host.querySelector('.agnes-intelligent-progress-fill')?.getAttribute('style')).toContain('width')
      expect(host.querySelector('.agnes-ui-badge')?.getAttribute('style')).toContain('var(--agnes-')
      const proof = host.querySelector('[data-testid="ui-image-proof"]')
      expect(proof?.querySelector('img')).toBeNull()
      expect(proof?.textContent).toContain(sha)
      const img = host.querySelector<HTMLImageElement>('[data-testid="ui-image-img-scan"]')
      expect(img?.alt).toBe('Receipt scan')
      expect(img?.getAttribute('src') ?? '').toMatch(/^blob:/)
      for (const node of host.querySelectorAll('img'))
        expect(node.getAttribute('src') ?? '').not.toMatch(
          /^(?:https?:|data:|javascript:|file:|agnes-upload:|artifact:)/,
        )
      expect(host.querySelector('[data-testid="ui-tabpanel-sections-main"]')?.textContent).toContain(
        'Inside the first tab',
      )
      const more = host.querySelector<HTMLElement>('[data-testid="ui-tab-sections-more"]')
      const tab = more?.closest<HTMLElement>('[role="tab"]') ?? more
      await act(async () => tab?.click())
      expect((tab ?? more)?.getAttribute('aria-selected')).toBe('true')
      expect(host.querySelector<HTMLInputElement>('input[data-format="date"]')?.type).toBe('date')
      expect(host.querySelector<HTMLInputElement>('input[data-format="date"]')?.value).toBe('2026-10-10')
      expect(host.querySelector<HTMLInputElement>('input[data-format="date-time"]')?.type).toBe(
        'datetime-local',
      )
      expect(host.querySelector<HTMLInputElement>('input[data-format="date-time"]')?.value).toBe(
        '2026-10-09T00:00',
      )
    } finally {
      document.documentElement.className = ''
      await act(async () => root.unmount())
    }
  })
})

const hash = 'ab'.repeat(32)
function boundSurface(data: UiSurface['data']): UiSurface {
  return {
    ...structuredClone(surface),
    data,
    actions: [
      {
        id: 'approve',
        label: 'Approve',
        tool: 'finance_approve',
        argsTemplate: { rows: { from: 'selection', key: 'rows' } },
        paramsSchema: true,
      },
    ],
  }
}

async function renderCatalog(
  rendered: UiSurface,
  sources: Record<string, UiSourceStatus> | undefined,
  locale: UiLocale,
  onRefresh: ReturnType<typeof vi.fn>,
) {
  const host = document.createElement('div')
  const root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(
        UiLocaleProvider,
        { source: localeSource(locale) },
        createElement(IntelligentCatalog, {
          surface: rendered,
          ...(sources ? { sources } : {}),
          input: {},
          selection: {},
          disabled: false,
          onInput: vi.fn(),
          onSelection: vi.fn(),
          onInvalid: vi.fn(),
          onAction: vi.fn(),
          onRefreshSource: onRefresh,
        }),
      ),
    ),
  )
  return {
    host,
    root,
    unmount: async () => {
      await act(async () => root.unmount())
    },
  }
}

describe('UI data source states', () => {
  it('degrades one denied source and still renders the literal sibling', async () => {
    const rendered = boundSurface({
      rows: { $source: 'finance/differences', params: {} },
      draft: { reason: 'Mismatch' },
      text: 'literal note',
    })
    const refresh = vi.fn()
    const view = await renderCatalog(
      rendered,
      { rows: { status: 'error', code: 'UI_SOURCE_DENIED' } },
      'en',
      refresh,
    )
    try {
      expect(view.host.querySelector('[data-testid="ui-unavailable"]')).toBeNull()
      expect(view.host.querySelectorAll('[data-testid="ui-source-error"]')).toHaveLength(2)
      expect(view.host.querySelector('[data-testid="ui-source-error"]')?.getAttribute('role')).toBe('alert')
      expect(view.host.textContent).toContain('This data is unavailable.')
      expect(view.host.textContent).toContain('UI_SOURCE_DENIED')
      expect(view.host.textContent).toContain('literal note')
      expect(view.host.querySelector('[data-testid="ui-table-rows"]')).toBeNull()
      expect(view.host.querySelector('svg')).toBeNull()
      expect(view.host.textContent).not.toContain('finance/differences')
      const button = view.host.querySelector<HTMLButtonElement>('[data-testid="ui-source-refresh"]')
      expect(button?.textContent).toContain('Refresh')
      expect(button?.getAttribute('aria-label')).toContain('Refresh')
      await act(async () => button?.click())
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(view.host.querySelector<HTMLButtonElement>('[data-testid="ui-action-approve"]')?.disabled).toBe(
        true,
      )
    } finally {
      await view.unmount()
    }
  })

  it('shows a loading state and a Chinese error without crashing on a bad result', async () => {
    const pending = boundSurface({
      rows: { $source: 'finance/differences', params: {} },
      draft: { reason: 'Mismatch' },
      text: 'literal note',
    })
    const refresh = vi.fn()
    const loading = await renderCatalog(pending, { rows: { status: 'pending' } }, 'zh-CN', refresh)
    try {
      const status = loading.host.querySelector('[data-testid="ui-source-loading"]')
      expect(status?.getAttribute('role')).toBe('status')
      expect(status?.getAttribute('aria-busy')).toBe('true')
      expect(loading.host.textContent).toContain('正在加载数据…')
      expect(loading.host.querySelector('[data-testid="ui-source-refresh"]')?.textContent).toContain('刷新')
      expect(loading.host.textContent).toContain('literal note')
    } finally {
      await loading.unmount()
    }
    const malformed = boundSurface({
      rows: [{ id: 'txn-1' }],
      draft: { reason: 'Mismatch' },
      text: 'literal note',
    })
    const broken = await renderCatalog(
      malformed,
      { rows: { status: 'ready', resultHash: hash } },
      'zh-CN',
      refresh,
    )
    try {
      expect(broken.host.querySelector('[data-testid="ui-unavailable"]')).toBeNull()
      expect(broken.host.textContent).toContain('这份数据与组件不匹配。')
      expect(broken.host.textContent).toContain('UI_SOURCE_SHAPE')
      expect(broken.host.textContent).toContain('literal note')
      expect(broken.host.querySelector('[data-testid="ui-table-rows"]')).toBeNull()
    } finally {
      await broken.unmount()
    }
  })

  it('renders a ready source after the structural check and refuses a bad literal surface', async () => {
    const ready = boundSurface({
      rows: [{ id: 'txn-1', amount: 250 }],
      draft: { reason: 'Mismatch' },
      text: 'literal note',
    })
    const refresh = vi.fn()
    const view = await renderCatalog(ready, { rows: { status: 'ready', resultHash: hash } }, 'en', refresh)
    try {
      expect(view.host.querySelector('[data-testid="ui-table-rows"]')?.textContent).toContain('250')
      expect(view.host.querySelector('[data-testid="ui-source-error"]')).toBeNull()
      expect(view.host.querySelector('[data-testid="ui-source-refresh"]')).not.toBeNull()
      expect(view.host.querySelector<HTMLButtonElement>('[data-testid="ui-action-approve"]')?.disabled).toBe(
        false,
      )
    } finally {
      await view.unmount()
    }
    const literal = structuredClone(surface)
    literal.data = {
      ...literal.data,
      rows: [
        { id: 'txn-1', amount: 250 },
        { id: 'txn-1', amount: 0 },
      ],
    }
    const rejected = await renderCatalog(literal, undefined, 'en', refresh)
    try {
      expect(rejected.host.querySelector('[data-testid="ui-unavailable"]')).not.toBeNull()
      expect(rejected.host.querySelector('[data-testid="ui-table-rows"]')).toBeNull()
    } finally {
      await rejected.unmount()
    }
  })
})
