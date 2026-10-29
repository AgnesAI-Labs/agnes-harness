import { readUiCss, readWebStyleSource } from '../../../tools/web-style-source.mjs'
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

  it('is directly reachable after the tabs and before the workbench, outside the replaceable unit', async () => {
    runtime = await mountRenderedIndex()
    const buttons = document.querySelectorAll('#report-problem')
    expect(buttons).toHaveLength(1)
    const button = buttons[0] as HTMLButtonElement
    expect(button).toBeInstanceOf(HTMLButtonElement)
    expect(document.querySelector('header .topbar #report-problem')).toBeNull()
    expect(button.closest('.connection-group')).toBeNull()
    expect(button.closest('[role="tablist"]')).toBeNull()

    // The action group follows the view switch; report comes before the workbench.
    const group = button.closest('.topbar-actions')
    expect(group?.closest('.session-tabs-bar')).not.toBeNull()
    expect(group?.previousElementSibling?.querySelector('.session-tabs[role="tablist"]')).not.toBeNull()
    expect(group?.closest('header[data-agnes-region="topbar"]')).not.toBeNull()
    const controls = [...(group?.querySelectorAll<HTMLButtonElement>('button') ?? [])].filter(
      (control) => control.tabIndex >= 0 && !control.closest('#session-goal-host'),
    )
    expect(controls[0]?.id).toBe('report-problem')
    expect(button.tabIndex).toBe(0)
    expect(
      button.compareDocumentPosition(document.getElementById('workbench-controls') as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(document.getElementById('topbar-more')).toBeNull()

    expect(button.type).toBe('button')
    expect(button.getAttribute('aria-label')).toBe('Report a problem')
    // Only the shared Tooltip names this action; a native title would double it up.
    expect(button.getAttribute('title')).toBeNull()
    expect(button.querySelector('svg[aria-hidden="true"][data-agnes-region="icon"]')).not.toBeNull()
  })

  it('draws a hairline and a raised sliding thumb with reduced-motion rules', () => {
    const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))
    const shared = readUiCss(resolve(__dirname, '../../web-ui/src/refinement.css'))
    const rule = (selector: string, source = css) =>
      new RegExp(`^\\s*${selector.replace(/[.#]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(source)?.[1]
    expect(rule('.topbar-row')).toMatch(/border-bottom: var\(--hairline\) solid var\(--agnes-line-hairline\)/)
    // The view switch is a segmented track, not underlined text tabs.
    expect(rule('.agh-segmented', shared)).toMatch(/background: var\(--agnes-segment-track\)/)
    expect(rule('.agh-segmented-thumb', shared)).toContain('background: var(--agnes-bg-control)')
    const reduced = shared.slice(shared.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(rule('.agh-segmented-thumb', reduced)).toContain('transition: none')
    expect(css).not.toMatch(/#report-problem,\s*#session-runtime/)
  })
})
