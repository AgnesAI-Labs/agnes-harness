/** @vitest-environment happy-dom */
import type { PackageCatalogDescriptor } from '@agnes/protocol'
import { act, createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  mountRegion,
  PluginList,
  PluginPurposeSections,
  UiLocaleProvider,
  type UiLocaleSource,
} from '../src/index.js'

afterEach(() => {
  document.body.replaceChildren()
})

const listProps = {
  tab: 'installed' as const,
  rows: [],
  loading: false,
  inventoryAuthoritative: true,
  query: '',
  nextCursor: null,
  surfaceLinksOf: () => [],
  runtimeOf: () => undefined,
  primaryActionOf: () => ({ label: 'Open', disabled: false, run: () => undefined }),
  switchDisabledOf: () => false,
  onOpen: () => undefined,
  onToggleDesired: () => undefined,
  onLoadMore: () => undefined,
}

function renderText(element: ReturnType<typeof createElement>): string {
  const host = document.createElement('div')
  document.body.append(host)
  mountRegion(host, element)
  return host.textContent ?? ''
}

describe('plugin list localization', () => {
  it('uses English for the default empty state and keeps contribution IDs in details', () => {
    expect(renderText(createElement(PluginList, listProps))).toContain('No packages are installed')
    checkContributionDetails('en', 'Compatible')
  })

  it('uses the selected locale for the empty state', () => {
    const source: UiLocaleSource = {
      getSnapshot: () => 'zh-CN',
      getVersion: () => 0,
      subscribe: () => () => undefined,
      t: (key) => key,
      bind: () => (key) => key,
    }
    const text = renderText(createElement(UiLocaleProvider, { source }, createElement(PluginList, listProps)))

    expect(text).toContain('尚未安装插件')
    checkContributionDetails('zh-CN', '兼容')
  })
})

function checkContributionDetails(locale: 'en' | 'zh-CN', summary: string) {
  const row: PackageCatalogDescriptor = {
    id: '@third-party/unknown',
    version: '1.0.0',
    source: { type: 'file', ref: 'file:./plugin' },
    integrity: 'sha256-' + 'a'.repeat(64),
    license: 'MIT',
    contributions: [
      {
        kind: 'extension',
        id: 'plugin/012345abcdef',
        path: './main.js',
        apiRange: '^1.0.0',
        runtimeSupports: ['in-process'],
        capabilities: {},
      },
    ],
    compatibility: 'supported',
    sourceId: 'local',
    retrievedAt: '2026-10-08T00:00:00Z',
  }
  const source: UiLocaleSource = {
    getSnapshot: () => locale,
    getVersion: () => 0,
    subscribe: () => () => undefined,
    t: (key) => key,
    bind: () => (key) => key,
  }
  const host = document.createElement('div')
  const dispose = mountRegion(
    host,
    createElement(
      UiLocaleProvider,
      { source },
      createElement(PluginList, { ...listProps, tab: 'discover', rows: [row] }),
    ),
  )
  const details = host.querySelector('details')!
  expect(details.open).toBe(false)
  expect(details.textContent).toContain('plugin/012345abcdef')
  details.remove()
  expect(host.textContent).not.toContain('plugin/012345abcdef')
  expect(host.querySelector('.plugin-compatibility')?.textContent).toBe(summary)
  expect(host.querySelector('.plugin-row-content > p:not(.plugin-source)')).toBeNull()
  dispose()
}

it('groups catalog versions and reviews the selected version without opening the card on selection', async () => {
  const base: PackageCatalogDescriptor = {
    id: '@example/panel',
    version: '1.0.0',
    source: { type: 'file', ref: 'file:./panel' },
    integrity: 'sha256-' + 'a'.repeat(64),
    license: 'MIT',
    contributions: [],
    compatibility: 'supported',
    sourceId: 'local',
    retrievedAt: '2026-10-08T00:00:00Z',
  }
  const host = document.createElement('div')
  document.body.append(host)
  let chosen: string | undefined
  const dispose = mountRegion(
    host,
    createElement(PluginList, {
      ...listProps,
      tab: 'discover',
      rows: [base, { ...base, version: '2.0.0', compatibility: 'unsupported' }],
      primaryActionOf: (item) => ({
        label: 'Review',
        disabled: false,
        run: () => {
          chosen = item.version
        },
      }),
      onOpen: (item) => {
        chosen = item.version
      },
    }),
  )
  expect(host.querySelectorAll('[data-plugin-id]')).toHaveLength(1)
  const picker = host.querySelector<HTMLElement>('[data-testid="plugin-version-picker"]')!
  await act(async () =>
    picker.querySelector('input')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
  )
  const option = [...host.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
    (entry) => entry.textContent === '2.0.0',
  )
  expect(option).toBeDefined()
  await act(async () => option?.click())
  expect(chosen).toBeUndefined()
  expect(host.querySelector('.plugin-source')).toBeNull()
  expect(host.querySelector('[data-testid="plugin-other-versions"] summary')?.textContent).toContain('2.0.0')
  expect(host.querySelector('.plugin-compatibility')?.textContent).toBe('Unsupported')
  host.querySelector<HTMLButtonElement>('.plugin-row > button')?.click()
  expect(chosen).toBe('2.0.0')
  dispose()
})

const purposeRow: PackageCatalogDescriptor = {
  id: '@acme/document-desk',
  version: '1.0.0',
  integrity: 'sha256-' + 'a'.repeat(64),
  source: { type: 'npm', ref: 'npm:@acme/document-desk@1.0.0' },
  sourceId: 'third-party',
  license: 'MIT',
  contributions: [],
  compatibility: 'supported',
  retrievedAt: '2026-10-10T00:00:00Z',
  presentation: { origin: 'third-party', rows: [] },
  metadata: {
    displayName: 'Document desk',
    summary: 'Search local reports.',
    description: 'Read and search local reports.',
    category: 'tools',
    docsUrl: 'https://example.org/docs',
    locales: { 'zh-CN': { displayName: '资料助手', summary: '检索本地报告。' } },
  },
}
const purposeSource = (locale: 'en' | 'zh-CN'): UiLocaleSource => ({
  getSnapshot: () => locale,
  getVersion: () => 0,
  subscribe: () => () => undefined,
  t: (key) => key,
  bind: () => (key) => key,
})

it.each(['en', 'zh-CN'] as const)(
  'shows arbitrary author purpose, source and registered chips in %s',
  (locale) => {
    const host = document.createElement('div')
    const dispose = mountRegion(
      host,
      createElement(
        UiLocaleProvider,
        { source: purposeSource(locale) },
        createElement(PluginList, {
          ...listProps,
          tab: 'discover',
          rows: [purposeRow],
          providesOf: () => ({
            provides: [{ kind: 'tool', id: 'read_report' }],
            appearsIn: ['chat'],
            available: true,
          }),
        }),
      ),
    )
    expect(host.querySelector('.plugin-details-button')?.textContent).toBe(
      locale === 'en' ? 'Document desk' : '资料助手',
    )
    expect(host.querySelector('[data-testid=plugin-summary]')?.textContent).toBe(
      locale === 'en' ? 'Search local reports.' : '检索本地报告。',
    )
    expect(host.querySelector('[data-testid=plugin-purpose-badges]')?.textContent).toContain(
      locale === 'en' ? 'Third-party' : '第三方',
    )
    expect(host.querySelector('[data-testid=plugin-provides]')?.textContent).toContain(
      locale === 'en' ? 'Tools · 1' : '工具 · 1',
    )
    dispose()
  },
)

it('renders metadata-free third-party packages cleanly without guessing official origin or executing text', () => {
  const host = document.createElement('div')
  const { metadata: _metadata, presentation: _presentation, ...plainRow } = purposeRow
  const withoutPurpose = { ...plainRow, id: '@agnes/unverified' }
  const dispose = mountRegion(
    host,
    createElement(PluginList, { ...listProps, tab: 'discover', rows: [withoutPurpose] }),
  )
  expect(host.querySelector('.plugin-details-button')?.textContent).toBe('@agnes/unverified')
  expect(host.querySelector('[data-testid=plugin-summary]')?.textContent).toBe('No description provided')
  expect(host.querySelector('[data-testid=plugin-purpose-badges]')?.textContent).toContain('Uncategorized')
  expect(host.querySelector('[data-testid=plugin-purpose-badges]')?.textContent).toContain('Third-party')
  dispose()
  const escaped = mountRegion(
    host,
    createElement(PluginList, {
      ...listProps,
      tab: 'discover',
      rows: [
        { ...purposeRow, metadata: { ...purposeRow.metadata!, summary: '<img src=x onerror=alert(1)>' } },
      ],
    }),
  )
  expect(host.querySelector('[data-testid=plugin-summary]')?.textContent).toContain('<img')
  expect(host.querySelector('img')).toBeNull()
  escaped()
})

it('renders six purpose sections with localized fallback and an explicit safe documentation link', () => {
  const host = document.createElement('div')
  const dispose = mountRegion(
    host,
    createElement(
      UiLocaleProvider,
      { source: purposeSource('zh-CN') },
      createElement(PluginPurposeSections, {
        item: purposeRow,
        value: { provides: [], appearsIn: [], available: false },
        permissions: 'Permission review',
        versions: 'Pinned versions',
      }),
    ),
  )
  for (const key of ['overview', 'provides', 'appears', 'settings', 'permissions', 'versions'])
    expect(
      host.querySelector(`[data-testid=plugin-${key}${key === 'overview' ? '' : '-detail'}]`),
    ).not.toBeNull()
  expect(host.querySelector('[data-testid=plugin-overview]')?.textContent).toContain(
    'Read and search local reports.',
  )
  expect(host.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
  dispose()
})
