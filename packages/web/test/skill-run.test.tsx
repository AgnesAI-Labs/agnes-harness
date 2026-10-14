/** @vitest-environment happy-dom */
import { PushStack, ResourceRow, searchParamRoute, setResourceSkillRunner } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginsPageCatalog } from '../src/pages/plugins/page-locale.js'
import { SkillRunPage, skillRunUrl } from '../src/pages/plugins/skill-run.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => {
  setResourceSkillRunner(undefined)
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const t = (key: string, vars?: Readonly<Record<string, string | number>>) =>
  (pluginsPageCatalog.en?.[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? name))
const skill = (desired: 'enabled' | 'disabled') =>
  ({
    kind: 'skill',
    resourceId: 'skill:weekly',
    name: 'weekly-report',
    description: 'Writes the weekly report.',
    desired,
    revision: 'skill-row:v1:abc',
    sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 's1' },
  }) as unknown as Parameters<typeof ResourceRow>[0]['item']

async function render(element: ReturnType<typeof createElement>) {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  await act(async () => root.render(element))
  return { host, unmount: () => act(async () => root.unmount()) }
}
const openMenu = async (host: HTMLElement) =>
  act(async () => host.querySelector<HTMLButtonElement>('.agh-btn--icon')?.click())

it('offers 「在新会话中运行」 on a skill that is on, once the plugins page registers a runner', async () => {
  const run = vi.fn()
  const row = (item: ReturnType<typeof skill>) =>
    createElement(ResourceRow, {
      item,
      selected: false,
      switchDisabled: false,
      itemName: 'weekly-report',
      onOpen: () => {},
      onToggleDesired: () => {},
    })
  const plain = await render(row(skill('enabled')))
  await openMenu(plain.host)
  expect(document.querySelector('[data-testid="skill-run"]')).toBeNull()
  await plain.unmount()
  document.body.replaceChildren()

  setResourceSkillRunner(run)
  const off = await render(row(skill('disabled')))
  await openMenu(off.host)
  expect(document.querySelector('[data-testid="skill-run"]')).toBeNull()
  await off.unmount()
  document.body.replaceChildren()

  const on = await render(row(skill('enabled')))
  await openMenu(on.host)
  await act(async () => document.querySelector<HTMLElement>('[data-testid="skill-run"]')?.click())
  expect(run).toHaveBeenCalledWith('weekly-report')
  await on.unmount()
})

it('is a page over the skills list: a link opens it, it asks for optional arguments, then opens a new session', async () => {
  expect(skillRunUrl('review', '')).toBe('/?new=1&prompt=%2Fskill+invoke+review')
  history.replaceState(null, '', '/?page=plugins&tab=skills&view=run%3Areview')
  const assign = vi.fn()
  const { unmount } = await render(
    createElement(
      PushStack,
      { rootTitle: 'Plugins', route: searchParamRoute('view') },
      createElement(SkillRunPage, { name: 'review', t }),
    ),
  )
  // The header names where it sits: Plugins › Run review.
  expect(document.querySelector('[data-testid="push-header"]')?.textContent).toContain('Plugins')
  expect(document.querySelector('[data-testid="push-page-run:review"]')?.textContent).toContain('Arguments')
  expect(document.querySelector('h2')?.textContent).toBe('Run review')
  const input = document.querySelector<HTMLInputElement>('[data-testid="skill-run-args"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'src/app.ts')
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="skill-run-open"]')?.click())
  expect(assign).toHaveBeenCalledWith('/?new=1&prompt=%2Fskill+invoke+review+src%2Fapp.ts')
  vi.restoreAllMocks()
  // 返回 leaves the page: the list is back and the address no longer names it.
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="push-back"]')?.click())
  expect(document.querySelector('[data-testid="push-page-run:review"]')).toBeNull()
  expect(new URL(location.href).searchParams.get('view')).toBeNull()
  await unmount()
})
