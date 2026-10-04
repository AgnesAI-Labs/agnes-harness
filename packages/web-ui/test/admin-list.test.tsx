/** @vitest-environment happy-dom */
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
  it('uses English for the default empty state', () => {
    expect(renderText(createElement(PluginList, listProps))).toContain('No packages are installed')
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
  })
})
