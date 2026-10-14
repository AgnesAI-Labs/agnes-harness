/** @vitest-environment happy-dom */
import { ResourceRow, setResourceSkillRunner } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { pluginsPageCatalog } from '../src/pages/plugins/page-locale.js'
import { SkillRunDialog, skillRunUrl } from '../src/pages/plugins/skill-run.js'

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

it('asks for optional arguments and opens a new session with the invocation filled in', async () => {
  expect(skillRunUrl('review', '')).toBe('/?new=1&prompt=%2Fskill+invoke+review')
  const assign = vi.fn()
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, assign } as Location)
  const closed = vi.fn()
  const { unmount } = await render(createElement(SkillRunDialog, { name: 'review', t, onClose: closed }))
  expect(document.body.textContent).toContain('Run review')
  const input = document.querySelector<HTMLInputElement>('[data-testid="skill-run-args"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'src/app.ts')
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="skill-run-open"]')?.click())
  expect(assign).toHaveBeenCalledWith('/?new=1&prompt=%2Fskill+invoke+review+src%2Fapp.ts')
  await unmount()
})
