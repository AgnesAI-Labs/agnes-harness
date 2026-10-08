/** @vitest-environment happy-dom */
import type { PackageCatalogDescriptor } from '@agnes/protocol'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountRegion, PluginList, UiLocaleProvider, type UiLocaleSource } from '../src/index.js'

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
