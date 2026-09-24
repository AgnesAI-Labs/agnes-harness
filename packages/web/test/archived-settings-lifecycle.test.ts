/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import type { Client } from '@agnes/sdk/browser'
import { SlotRegistry } from '@agnes/web-client'
import { createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { mountSettingsPaneRegion, settingsPaneSlot } from '../src/region-slots.js'
import { createSessionActions } from '../src/session-actions.js'

it('keeps archived results, search and restore connected after opening and switching sessions', async () => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const slots = (ctx as unknown as { slots: SlotRegistry }).slots
  const container = document.createElement('div')
  document.body.append(container)
  const region = mountSettingsPaneRegion(slots, container)
  let archived = false
  const session = {
    archive: vi.fn(async (_id: string, value: boolean) => {
      archived = value
      return { archived }
    }),
    list: vi.fn(async () => ({
      items: [{ sessionId: 'saved', title: '归档回归', cwd: '/workspace', archived }],
    })),
  }
  const changed = vi.fn(async () => {})
  const error = vi.fn()
  let actions: ReturnType<typeof createSessionActions> | undefined
  try {
    actions = createSessionActions({
      client: { session } as unknown as Client,
      changed,
      error,
      fork: vi.fn(),
    })
    const originalPane = region.pane('archived')
    // Production creates the controller before session load updates the slot registry.
    slots.setSession('saved')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await actions.act('archive', 'saved', '归档回归', container)
    region.open('archived')
    await actions.loadArchived()
    expect(container.querySelector('#archived-list')?.textContent).toContain('归档回归')
    expect(region.pane('archived')).toBe(originalPane)

    const remove = slots.register(
      { name: settingsPaneSlot('archived'), owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'archive-override' }, '替换归档页'),
    )
    await vi.waitFor(() => expect(container.querySelector('#archive-override')).not.toBeNull())
    remove()
    // Restoring the built-in pane hydrates it without needing another navigation click.
    await vi.waitFor(() =>
      expect(container.querySelector('#archived-list')?.textContent).toContain('归档回归'),
    )
    expect(region.pane('archived')).not.toBe(originalPane)
    region.open('archived')

    slots.setSession('other')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(region.pane('archived')?.hidden).toBe(false)
    const search = container.querySelector<HTMLInputElement>('#archived-search') as HTMLInputElement
    search.value = 'absent'
    search.dispatchEvent(new Event('input'))
    expect(container.querySelectorAll('#archived-list li')).toHaveLength(0)
    search.value = '/workspace'
    search.dispatchEvent(new Event('input'))
    expect(container.querySelectorAll('#archived-list li')).toHaveLength(1)
    container.querySelector<HTMLButtonElement>('#archived-list button')?.click()
    await vi.waitFor(() => expect(session.archive).toHaveBeenLastCalledWith('saved', false))
    await vi.waitFor(() => expect(container.querySelectorAll('#archived-list li')).toHaveLength(0))
    await vi.waitFor(() => expect(document.activeElement).toBe(search))
    container.querySelector<HTMLButtonElement>('#archived-refresh')?.click()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(3))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(error).not.toHaveBeenCalled()
  } finally {
    actions?.dispose()
    region.dispose()
    await ctx.fiber.dispose()
    document.body.replaceChildren()
  }
})
