/** @vitest-environment happy-dom */
import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { act, createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Icon,
  type IconName,
  isBuiltinPlugin,
  isBundledPlugin,
  mountRegion,
  PluginList,
  PluginPurposeBadges,
  PluginPurposeSections,
  pluginIncludes,
  pluginOrigin,
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
  it('uses English for the default empty state and hides technical IDs from the list', () => {
    expect(renderText(createElement(PluginList, listProps))).toContain('No packages are installed')
    checkContributionDetails('en')
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
    checkContributionDetails('zh-CN')
  })
})

function checkContributionDetails(locale: 'en' | 'zh-CN') {
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
  expect(host.textContent).not.toContain('plugin/012345abcdef')
  expect(host.textContent).not.toContain('1.0.0')
  expect(host.querySelector('.plugin-compatibility')?.textContent).toBe('')
  expect(host.querySelector('[data-testid=plugin-summary]')).toBeNull()
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
  expect(
    host.querySelector('[data-testid="plugin-other-versions"] .agh-disclosure-summary')?.textContent,
  ).toContain('2.0.0')
  expect(host.querySelector('.plugin-compatibility')?.textContent).toBe('Unsupported')
  host.querySelector<HTMLButtonElement>('.agh-list-row-actions button')?.click()
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
    const purposeIcons: readonly (readonly [string, IconName])[] = [
      ['@agnes/plugin-helper', 'puzzle'],
      ['@agnes/document-reader', 'file-text'],
      ['@agnes/skill-helper', 'sparkles'],
      ['@agnes/mcp-helper', 'plug'],
      ['constructor', 'puzzle'],
    ]
    const host = document.createElement('div')
    const dispose = mountRegion(
      host,
      createElement(
        UiLocaleProvider,
        { source: purposeSource(locale) },
        createElement(PluginList, {
          ...listProps,
          tab: 'discover',
          rows: [purposeRow, ...purposeIcons.map(([id]) => ({ ...purposeRow, id }))],
          providesOf: () => ({
            provides: [{ kind: 'tool', id: 'read_report' }],
            appearsIn: ['chat'] as const,
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
    expect(host.querySelector('[data-testid=plugin-source-badge]')?.textContent).toBe(
      locale === 'en' ? 'Community' : '社区',
    )
    // Registration diagnostics belong in the detail view, not the main list.
    expect(host.querySelector('[data-testid=plugin-registered-provides]')).toBeNull()
    expect(host.textContent).not.toMatch(/category\./)
    // The source is the row's only badge.
    expect(host.querySelector('[data-plugin-id]')?.querySelectorAll('.agh-tag')).toHaveLength(1)
    // Identical localized metadata cannot override a stable package identity.
    for (const [id, name] of [[purposeRow.id, 'puzzle'], ...purposeIcons] as const) {
      const expected = document.createElement('div')
      const unmount = mountRegion(expected, createElement(Icon, { name, size: 20 }))
      const row = [...host.querySelectorAll('[data-plugin-id]')].find(
        (element) => element.getAttribute('data-plugin-id') === id,
      )
      expect(row?.querySelector('svg')?.outerHTML).toBe(expected.querySelector('svg')?.outerHTML)
      unmount()
    }
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
  expect(host.querySelector('[data-testid=plugin-summary]')).toBeNull()
  expect(host.querySelector('[data-testid=plugin-purpose-badges]')?.textContent ?? '').not.toContain(
    'Uncategorized',
  )
  expect(host.querySelector('[data-testid=plugin-source-badge]')?.textContent).toBe('Community')
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
        value: { provides: [{ kind: 'tool', id: 'read_report' }], appearsIn: [], available: true },
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
  expect(host.querySelector('[data-testid=plugin-provides-detail]')?.textContent).toContain('read_report')
  expect(host.querySelector('[data-testid=plugin-provides]')?.textContent).toContain('1')
  expect(host.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
  dispose()
})

it('says the description once: the overview repeats nothing the detail header already shows', () => {
  const metadata = purposeRow.metadata!
  const overview = (value: NonNullable<PackageCatalogDescriptor['metadata']>) => {
    const host = document.createElement('div')
    const dispose = mountRegion(
      host,
      createElement(
        UiLocaleProvider,
        { source: purposeSource('en') },
        createElement(PluginPurposeSections, {
          item: { ...purposeRow, metadata: value },
          value: { provides: [], appearsIn: [], available: true },
          permissions: '',
          versions: '',
          section: 'overview',
        }),
      ),
    )
    const text = host.querySelector('[data-testid=plugin-description]')?.textContent ?? null
    dispose()
    return text
  }
  // A description that says more than the summary stays in the overview.
  expect(overview(metadata)).toBe('Read and search local reports.')
  // One that only repeats the summary (the header's line) is not said again.
  const { locales: _locales, ...english } = metadata
  expect(overview({ ...english, description: ' Search local reports. ' })).toBeNull()
})

describe('where a plugin comes from and what it includes', () => {
  const bundled = {
    ...purposeRow,
    id: '@agnes/skill-helper',
    source: { type: 'file', ref: 'file:./bundled-plugins/skill-helper' },
    presentation: { origin: 'official', rows: [] },
  } as PackageCatalogDescriptor
  const t = (key: string, vars?: Readonly<Record<string, string | number>>) =>
    key === 'includesItem' ? `${vars?.count} ${vars?.name}` : key.replace('provide.', '')

  it('calls a package built in only when it ships with the product', () => {
    expect(isBuiltinPlugin(bundled)).toBe(true)
    expect(pluginOrigin(bundled)).toBe('builtin')
    // An official package installed from elsewhere, and a local folder that only looks bundled.
    const official = { ...bundled, source: { type: 'npm', ref: 'npm:@agnes/skill-helper@1.0.0' } }
    expect(pluginOrigin(official as PackageCatalogDescriptor)).toBe('official')
    const lookalike = { ...bundled, presentation: { origin: 'local-source', rows: [] } }
    expect(pluginOrigin(lookalike as PackageCatalogDescriptor)).toBe('local-source')
    expect(pluginOrigin(purposeRow)).toBe('third-party')
  })

  it('keeps an optional bundled package removable and still labels it official', () => {
    const optional = {
      ...bundled,
      id: '@agnes/jev-loop',
      source: { type: 'file', ref: 'file:./bundled-plugins/jev-loop' },
      presentation: { origin: 'official', optional: true, rows: [] },
      // An installed copy carries local file provenance; the label must not fall back to it.
      provenance: {
        source: { type: 'file', ref: 'file:./bundled-plugins/jev-loop' },
        signatureVerified: false,
      },
    } as unknown as PackageCatalogDescriptor
    expect(isBundledPlugin(optional)).toBe(true)
    expect(isBuiltinPlugin(optional)).toBe(false)
    expect(pluginOrigin(optional)).toBe('official')
    expect(isBuiltinPlugin(bundled)).toBe(true)
  })

  it('reads what the package says it includes, with a number only where the package states one', () => {
    const stated = {
      ...purposeRow,
      provides: ['tool'],
      presentation: {
        origin: 'third-party',
        rows: [],
        includes: { provides: ['tool', 'loop', 'skills', 'bundle'], counts: { bundles: 1, skills: 2 } },
      },
    } as PackageCatalogDescriptor
    expect(pluginIncludes(stated, undefined, t)).toBe('tool')
  })

  it('keeps declared capabilities separate from observed registrations', () => {
    const declared = { ...purposeRow, provides: ['tool', 'skills'] } as PackageCatalogDescriptor
    expect(pluginIncludes(declared, undefined, t)).toBe('tool · skill')
    const running = {
      provides: [
        { kind: 'tool', id: 'a' },
        { kind: 'tool', id: 'b' },
        { kind: 'skill', id: 'c' },
      ],
      appearsIn: [],
      available: true,
    }
    expect(pluginIncludes(purposeRow, running, t)).toBe('')
    const host = document.createElement('div')
    const dispose = mountRegion(host, createElement(PluginPurposeBadges, { item: declared, value: running }))
    expect(host.querySelector('[data-testid="plugin-declared-provides"]')?.textContent).toContain('Includes')
    expect(host.querySelector('[data-testid="plugin-registered-provides"]')).toBeNull()
    dispose()
    expect(pluginIncludes(purposeRow, undefined, t)).toBe('')
  })

  it('labels reusable combinations without guessing an agent from a category', () => {
    const agent = {
      ...purposeRow,
      provides: ['bundle'],
      presentation: {
        origin: 'example',
        rows: [],
        includes: { provides: ['bundle'], counts: { bundles: 1 } },
      },
      metadata: purposeRow.metadata,
    } as PackageCatalogDescriptor
    expect(pluginIncludes(agent, undefined, t)).toBe('1 bundle')
    const launch = { title: { en: 'Work' }, description: { en: 'Work' }, preset: 'safe' }
    expect(pluginIncludes({ ...agent, agents: [{ ref: 'acme/kit#work', launch }] }, undefined, t)).toBe(
      '1 agent',
    )
    expect(
      pluginIncludes(
        {
          ...agent,
          agents: [{ ref: 'acme/kit#work', launch }],
          presentation: { rows: [], includes: { provides: ['bundle'], counts: { bundles: 2 } } },
        },
        undefined,
        t,
      ),
    ).toBe('1 agent · 1 bundle')
    expect(
      pluginIncludes({ ...purposeRow, provides: ['bundle'] } as PackageCatalogDescriptor, undefined, t),
    ).toBe('bundle')
  })

  it('puts the host rows at the top of the same list', () => {
    const host = document.createElement('div')
    const dispose = mountRegion(
      host,
      createElement(PluginList, {
        ...listProps,
        rows: [],
        leading: createElement('article', { 'data-testid': 'leading-row' }),
      }),
    )
    expect(host.querySelector('.agnes-settings-list [data-testid=leading-row]')).not.toBeNull()
    expect(host.querySelector('.plugin-empty')).toBeNull()
    dispose()
  })
})

it.each(['en', 'zh-CN'] as const)(
  'renders one backend status, its reason and next action in %s',
  async (locale) => {
    const states = [
      ['ready', 'none', 'Ready', '就绪'],
      ['blocked', 'install-dependency', 'Blocked', '受阻'],
      ['restart-required', 'restart', 'After restart', '重启后生效'],
      ['historical-only', 'enable', 'History only', '仅历史'],
      ['disabled', 'enable', 'Disabled', '已停用'],
      ['untrusted', 'trust', 'Awaiting trust', '待信任'],
    ] as const
    for (const [state, nextAction, en, zh] of states) {
      const host = document.createElement('div')
      document.body.append(host)
      let opened = false
      let repaired = false
      const enabled = !['disabled', 'historical-only', 'untrusted'].includes(state)
      const row: PackageInstalledDescriptor = {
        id: '@acme/plugin',
        version: '1.0.0',
        source: { type: 'file', ref: 'file:./plugin' },
        integrity: `sha256-${'a'.repeat(64)}`,
        trusted: state !== 'untrusted',
        desired: enabled ? 'enabled' : 'installed-disabled',
        actual: state === 'restart-required' ? 'restart-required' : 'running',
        blockers: [],
        contributions: [],
        primaryStatus: {
          state,
          nextAction,
          reasonCode:
            state === 'untrusted' ? 'trust-required' : state === 'blocked' ? 'dependency-missing' : state,
          reason: { en: 'Backend reason', 'zh-CN': '后端原因' },
        },
      }
      const dispose = mountRegion(
        host,
        createElement(
          UiLocaleProvider,
          { source: purposeSource(locale) },
          createElement(PluginList, {
            ...listProps,
            rows: [row],
            onOpen: () => {
              opened = true
            },
            primaryActionOf: () => ({
              label: 'unused',
              disabled: false,
              run: () => {
                repaired = true
              },
            }),
          }),
        ),
      )
      try {
        const primary = host.querySelector('[data-testid=plugin-primary-status]')
        expect(primary?.querySelectorAll('.agh-tag')).toHaveLength(1)
        expect(primary?.textContent).toContain(locale === 'en' ? en : zh)
        expect(primary?.querySelector('[data-testid=plugin-status-reason]')?.textContent).toBe(
          state === 'untrusted'
            ? locale === 'en'
              ? 'Installed; review trust and enable to finish.'
              : '已安装；还需审阅信任并启用。'
            : locale === 'en'
              ? 'Backend reason'
              : '后端原因',
        )
        expect(host.querySelector('[role=switch]')?.getAttribute('aria-checked')).toBe(String(enabled))
        const button = primary?.querySelector('button')
        if (nextAction === 'none') expect(button).toBeNull()
        else {
          expect(button?.textContent).not.toBe('unused')
          await act(async () => button?.click())
          expect(repaired).toBe(true)
          expect(opened).toBe(false)
        }
      } finally {
        dispose()
      }
    }
  },
)
