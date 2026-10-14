import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
/** @vitest-environment happy-dom */

import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

describe('report-problem button placement', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
  })

  it('is a menu target at the end of the bar, outside the tablist and the replaceable topbar unit', async () => {
    runtime = await mountRenderedIndex()
    const buttons = document.querySelectorAll('#report-problem')
    expect(buttons).toHaveLength(1)
    const button = buttons[0] as HTMLButtonElement
    expect(button).toBeInstanceOf(HTMLButtonElement)
    expect(document.querySelector('header .topbar #report-problem')).toBeNull()
    expect(button.closest('.connection-group')).toBeNull()
    expect(button.closest('[role="tablist"]')).toBeNull()

    // The action group follows the view switch; the menu is its last control.
    const group = button.closest('.topbar-actions')
    expect(group?.closest('.session-tabs-bar')).not.toBeNull()
    expect(group?.previousElementSibling?.querySelector('.session-tabs[role="tablist"]')).not.toBeNull()
    expect(group?.closest('header[data-agnes-region="topbar"]')).not.toBeNull()
    const controls = [...(group?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(
      (control) => control.tabIndex >= 0 && !control.closest('#session-goal-host'),
    )
    expect(controls.at(-1)?.id).toBe('topbar-more')
    // Reached from the menu, so it takes no tab stop of its own.
    expect(button.tabIndex).toBe(-1)

    expect(button.type).toBe('button')
    expect(button.getAttribute('aria-label')).toBe('Report a problem')
    expect(button.getAttribute('title')).toBe('Report a problem')
    expect(button.querySelector('svg[aria-hidden="true"][data-agnes-region="icon"]')).not.toBeNull()
  })

  it('draws a hairline under the bar and keeps the menu targets out of sight', () => {
    const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))
    const rule = (selector: string, from = 0) =>
      new RegExp(`^\\s*${selector.replace(/[.#]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(css.slice(from))?.[1]
    expect(rule('.topbar-row')).toMatch(/border-bottom: var\(--hairline\) solid var\(--agnes-line-hairline\)/)
    // The view switch is a segmented track, not underlined text tabs.
    expect(rule('.session-tabs')).toMatch(/background: var\(--agnes-segment-track\)/)
    expect(css).toMatch(/#report-problem,\s*#session-runtime \{\s*display: none;/)
  })
})
