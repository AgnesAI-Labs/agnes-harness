/** @vitest-environment happy-dom */
import type { SkillRootStatus } from '@agnes/protocol'
import { createElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { UiLocaleSource } from '../src/index.js'

type UiModule = {
  Dialog: (props: { open: boolean; title: string; onCancel(event: MouseEvent): void }) => ReactElement
  Button: (props: {
    children?: ReactElement | string
    type?: string
    ref?: { current: HTMLButtonElement | null }
  }) => ReactElement
  Field: (props: { label: string; children: ReactElement }) => ReactElement
  mountRegion(host: HTMLElement, element: ReactElement): () => void
  unmountRegion(host: HTMLElement): void
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('web-ui public component layer', () => {
  it('keeps a confirmation inside its native dialog and consumes the close event', async () => {
    const ui = (await import('../src/index.js')) as unknown as UiModule
    const native = document.createElement('dialog')
    const host = document.createElement('div')
    native.append(host)
    document.body.append(native)
    let consumed = false
    const dispose = ui.mountRegion(
      host,
      createElement(ui.Dialog, {
        open: true,
        title: 'Confirm',
        onCancel: (event: MouseEvent) => {
          consumed = event.defaultPrevented
        },
      }),
    )
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    host.querySelector<HTMLButtonElement>('.ant-modal-close')?.click()
    expect(consumed).toBe(true)
    dispose()
  })
  it('passes the document CSP nonce to Ant Design runtime styles', async () => {
    const ui = (await import('../src/index.js')) as unknown as UiModule
    const host = document.createElement('div')
    for (const style of document.head.querySelectorAll('style')) style.remove()
    const meta = document.createElement('meta')
    meta.name = 'agnes-csp-nonce'
    meta.content = 'test-document-nonce'
    document.head.append(meta)
    document.body.append(host)

    const dispose = ui.mountRegion(host, createElement(ui.Button, null, 'Continue'))

    const styles = [...document.head.querySelectorAll<HTMLStyleElement>('style[data-css-hash]')]
    expect(styles.length).toBeGreaterThan(0)
    expect(styles.every((style) => style.nonce === meta.content)).toBe(true)
    // Layered at insertion: antd's layout reads must never resolve the unlayered defaults.
    expect(styles.every((style) => style.textContent?.trimStart().startsWith('@layer vendor'))).toBe(true)
    // Component regions share the skin bridge instead of injecting default light style rules.
    expect(host.querySelector('button')?.classList.contains('agnes-theme')).toBe(true)
    expect(styles.some((style) => style.textContent?.includes('.ant-btn:hover'))).toBe(false)
    dispose()
    meta.remove()
  })

  it('mounts and unmounts a React region through its lifecycle contract', async () => {
    const ui = (await import('../src/index.js')) as unknown as UiModule
    const host = document.createElement('div')
    document.body.append(host)

    const dispose = ui.mountRegion(host, createElement('span', { 'data-testid': 'content' }, 'ready'))

    expect(host.querySelector('[data-testid="content"]')?.textContent).toBe('ready')
    dispose()
    expect(host.childElementCount).toBe(0)
    ui.unmountRegion(host)
  })

  it('exports host primitives without exposing antd to consumers', async () => {
    const ui = (await import('../src/index.js')) as unknown as UiModule

    const reference = { current: null as HTMLButtonElement | null }
    const host = document.createElement('div')
    const dispose = ui.mountRegion(host, createElement(ui.Button, { ref: reference }, '插件'))
    expect(host.querySelector('button')?.textContent).toBe('插件')
    expect(reference.current).toBe(host.querySelector('button'))
    dispose()
    expect(ui.Field).toBeTypeOf('function')
    const { SettingsModelPane } = await import('../src/index.js')
    for (const [locale, empty, loading] of [
      ['en', 'Connect a model to start working', 'Loading configuration…'],
      ['zh-CN', '连接一个模型，就能开始工作', '正在读取配置…'],
    ]) {
      document.documentElement.lang = locale!
      const unmount = ui.mountRegion(
        host,
        createElement(SettingsModelPane, { beforeAccounts: null, afterAccounts: null }),
      )
      const advanced = host.querySelector('[data-testid=advanced-models]')
      expect(advanced?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
      expect(advanced?.textContent).toContain(locale === 'en' ? 'Advanced: side models' : '高级：旁路模型')
      expect(advanced?.querySelector('#config-side-models')).not.toBeNull()
      expect(host.querySelector('#config-accounts')?.getAttribute('data-empty-text')).toBe(empty)
      expect(host.querySelector('#config-accounts')?.getAttribute('data-loading-text')).toBe(loading)
      unmount()
    }
    document.documentElement.lang = 'en'
  })
})

it.each(['en', 'zh-CN'] as const)('lists reported skill roots and explains imports in %s', async (locale) => {
  document.documentElement.lang = locale
  const ui = await import('../src/index.js')
  const source: UiLocaleSource = {
    getSnapshot: () => locale,
    getVersion: () => 0,
    subscribe: () => () => undefined,
    t: (key) => key,
    bind: () => (key) => key,
  }
  const localized = (child: ReactElement) => createElement(ui.UiLocaleProvider, { source }, child)
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = ui.mountRegion(
    host,
    localized(
      createElement(ui.ResourceListContent, {
        tab: 'skills',
        loadState: 'empty',
        items: [],
        skillRoots: [{ scope: 'workspace', rootKey: 'workspace-agnes', state: 'empty' }] as SkillRootStatus[],
        selectedId: undefined,
        nextCursor: undefined,
        loadingMore: false,
        emptyTitle: 'Legacy title',
        emptyDescription: 'Legacy hints',
        emptyHints: ['~/.claude/skills', '~/.codex/skills', '~/.agents/skills'],
        switchDisabled: false,
        itemNameOf: () => '',
        onOpen: () => {},
        onToggleDesired: () => {},
        onLoadMore: () => {},
        onRetry: () => {},
      }),
    ),
  )
  expect(host.querySelector('.admin-empty-state-hints')).toBeNull()
  expect(host.querySelector('.resource-empty h3')?.textContent).toBe(
    locale === 'en' ? 'No skills yet' : '还没有技能',
  )
  expect(host.textContent).not.toContain('AGNES_SKILLS_IMPORT_USER')
  expect(host.textContent).not.toContain('Legacy')
  const help = document.createElement('div')
  const closeHelp = ui.mountRegion(
    help,
    localized(
      createElement(ui.ResourceRoots, {
        roots: [{ scope: 'workspace', rootKey: 'workspace-agnes', state: 'empty' }],
      }),
    ),
  )
  expect(help.querySelector('.resource-roots > .agh-disclosure-summary')?.textContent).toBe(
    locale === 'en' ? 'Checked 1 skill directory and found no skills.' : '已检查 1 个技能目录，未找到技能。',
  )
  expect(help.textContent).toContain(locale === 'en' ? 'Workspace skill folders' : '工作区技能文件夹')
  expect(help.textContent).not.toContain('~/.codex')
  closeHelp()
  dispose()
  document.documentElement.lang = 'en'
})

it.each([
  [true, undefined, 'true'],
  [true, false, 'true'],
  [false, true, 'true'],
  [false, false, 'false'],
  [false, 'true', 'true'],
  [false, undefined, null],
] as const)(
  'maps button variants and reports busy state (loading=%s, aria-busy=%s)',
  async (loading, ariaBusy, expectedBusy) => {
    const ui = await import('../src/index.js')
    const host = document.createElement('div')
    const native = ui.createSettingsButton(document, 'primary')
    expect(native.classList.contains('agh-btn--primary')).toBe(true)
    let clicks = 0
    const dispose = ui.mountRegion(
      host,
      createElement(
        ui.Button,
        {
          type: 'primary',
          loading,
          'aria-busy': ariaBusy,
          onClick: () => clicks++,
        },
        'Save',
      ),
    )
    const button = host.querySelector('button')!
    expect(button.classList.contains('agh-btn--primary')).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe(expectedBusy)
    button.click()
    expect(clicks).toBe(loading ? 0 : 1)
    dispose()
  },
)
