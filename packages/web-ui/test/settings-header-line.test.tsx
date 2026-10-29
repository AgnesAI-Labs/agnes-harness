/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Button, SettingsDrill, SettingsPage } from '../src/index.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await act(async () => cleanup())
  document.body.replaceChildren()
  history.replaceState(null, '', '/')
  document.documentElement.lang = ''
  vi.restoreAllMocks()
})
async function render(element: ReturnType<typeof createElement>) {
  document.documentElement.lang = 'zh-CN'
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(element))
  cleanups.push(() => root.unmount())
  return host
}
const $ = <T extends Element = HTMLElement>(host: ParentNode, selector: string) => {
  const node = host.querySelector<T & Element>(selector)
  if (!node) throw new Error(`missing ${selector}`)
  return node as unknown as T
}
/** The header line on screen: the page's own, or the open subpage's. */
const visibleHeader = (host: ParentNode) =>
  [...host.querySelectorAll<HTMLElement>('header.agnes-settings-page-heading')].find(
    (header) => !header.closest('[hidden]'),
  )
/** No 「返回」 control and no description line anywhere in the settings page. */
function expectNoBackLinkOrDescription(host: HTMLElement, description: string) {
  const buttons = [...host.querySelectorAll('button')].filter((button) => !button.closest('[hidden]'))
  expect(buttons.some((button) => button.textContent?.trim() === '返回')).toBe(false)
  for (const paragraph of host.querySelectorAll('header p'))
    expect(paragraph.classList.contains('agh-visually-hidden')).toBe(true)
  expect(host.querySelectorAll('header h1')).toHaveLength(0)
  expect(visibleHeader(host)?.querySelector('h2')?.getAttribute('aria-describedby')).toBeTruthy()
  expect(description).toBeTruthy()
}

const page = (routeId?: string) =>
  createElement(
    SettingsPage,
    {
      title: '运行时与诊断',
      description: '检查运行时状态。',
      ...(routeId ? { routeId } : {}),
      actions: createElement(Button, { 'data-testid': 'export' }, '导出诊断包…'),
    },
    createElement('p', { 'data-testid': 'main-body' }, 'Main'),
    createElement(
      SettingsDrill,
      {
        id: 'otlp',
        label: 'OTLP 执行记录导出',
        description: '把执行记录发到 OTLP。',
        actions: createElement(Button, { 'data-testid': 'otlp-save' }, '保存'),
      },
      createElement('p', { 'data-testid': 'otlp-body' }, 'OTLP body'),
      createElement(
        SettingsDrill,
        { id: 'limits', label: '限制' },
        createElement('p', { 'data-testid': 'limits-body' }, 'Limits body'),
      ),
    ),
  )

it('shows a top level page as one line: its title as the heading, its actions, nothing else', async () => {
  const host = await render(page())
  const header = visibleHeader(host)
  expect(header).toBeDefined()
  // Just the title: no breadcrumb control, no leading ‹ or ›.
  expect(header?.querySelectorAll('button.agh-push-crumb')).toHaveLength(0)
  expect(header?.querySelector('.agh-push-crumb-separator')).toBeNull()
  const heading = header?.querySelector('[aria-current="page"] h2')
  expect(heading?.textContent).toBe('运行时与诊断')
  // The page's primary action sits in the same line.
  expect(header?.querySelector('[data-testid="export"]')?.textContent).toBe('导出诊断包…')
  // The description is not a visible line; assistive tech still reads it with the heading.
  const described = heading?.getAttribute('aria-describedby') ?? ''
  expect(host.ownerDocument.getElementById(described)?.textContent).toBe('检查运行时状态。')
  expectNoBackLinkOrDescription(host, '检查运行时状态。')
})

it('shows a subpage as 「parent › current」: the parent crumb returns one level', async () => {
  const host = await render(page())
  await act(async () => $<HTMLButtonElement>(host, '[data-testid="settings-drill-otlp"]').click())
  const header = visibleHeader(host)
  expect(header?.getAttribute('data-testid')).toBe('settings-subpage-header')
  const crumbs = [...(header?.querySelectorAll<HTMLButtonElement>('button.agh-push-crumb') ?? [])]
  expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['运行时与诊断'])
  expect(crumbs[0]?.getAttribute('aria-label')).toBe('返回到 运行时与诊断')
  expect(crumbs[0]?.querySelector('svg')).toBeNull()
  expect(header?.querySelector('[aria-current="page"] h2')?.textContent).toBe('OTLP 执行记录导出')
  // The subpage's actions move into the line; the page's own header is out of view.
  expect(header?.querySelector('[data-testid="otlp-save"]')).not.toBeNull()
  expect($(host, '[data-testid="export"]').closest('[hidden]')).not.toBeNull()
  expectNoBackLinkOrDescription(host, '把执行记录发到 OTLP。')
  // The parent crumb goes back through history, as the browser's back button does.
  const back = vi
    .spyOn(history, 'back')
    .mockImplementation(() =>
      window.dispatchEvent(new PopStateEvent('popstate', { state: { agnesSettingsSubpage: 0 } })),
    )
  await act(async () => crumbs[0]?.click())
  expect(back).toHaveBeenCalledOnce()
  expect($(host, '[data-testid="main-body"]').closest('[hidden]')).toBeNull()
  expect(visibleHeader(host)?.querySelector('h2')?.textContent).toBe('运行时与诊断')
})

it('jumps two levels from a deeper page and keeps the address truthful', async () => {
  history.replaceState(null, '', '/?session=s1&settings=diagnostics/otlp/limits')
  const host = await render(page('diagnostics'))
  const header = visibleHeader(host)
  const crumbs = [...(header?.querySelectorAll<HTMLButtonElement>('button.agh-push-crumb') ?? [])]
  expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['运行时与诊断', 'OTLP 执行记录导出'])
  expect(crumbs[1]?.getAttribute('aria-label')).toBe('返回到 OTLP 执行记录导出')
  expect(header?.querySelector('[aria-current="page"] h2')?.textContent).toBe('限制')
  expect(header?.textContent?.replace(/\s/g, '')).toBe('运行时与诊断OTLP执行记录导出限制')
  await act(async () => crumbs[0]?.click())
  expect($(host, '[data-testid="main-body"]').closest('[hidden]')).toBeNull()
  expect(host.querySelector('[data-testid="limits-body"]')).toBeNull()
  expect(new URL(location.href).searchParams.get('settings')).toBe('diagnostics')
  expect(new URL(location.href).searchParams.get('session')).toBe('s1')
})
