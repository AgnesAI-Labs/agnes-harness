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

  it('sits at the right end of the session tab row, outside the tablist and the topbar', async () => {
    runtime = await mountRenderedIndex()
    const buttons = document.querySelectorAll('#report-problem')
    expect(buttons).toHaveLength(1)
    const button = buttons[0] as HTMLButtonElement
    expect(button).toBeInstanceOf(HTMLButtonElement)
    expect(document.querySelector('header.topbar #report-problem')).toBeNull()
    expect(button.closest('.connection-group')).toBeNull()
    expect(button.closest('[role="tablist"]')).toBeNull()

    const bar = button.closest('#session-view-controls')
    expect(bar?.closest('.session-tabs-bar')).not.toBeNull()
    expect(bar?.querySelector('.session-tabs[role="tablist"]')).not.toBeNull()
    expect(bar?.lastElementChild?.contains(button)).toBe(true)

    expect(button.type).toBe('button')
    expect(button.getAttribute('aria-label')).toBe('Report a problem')
    expect(button.getAttribute('title')).toBe('Report a problem')
    expect(button.querySelector('svg[aria-hidden="true"][data-agnes-region="icon"]')).not.toBeNull()
  })

  it('moves the row chrome to the bar and keeps the button from growing the tab row on phones', () => {
    const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))
    const rule = (selector: string, from = 0) =>
      new RegExp(`^\\s*${selector.replace(/[.#]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(css.slice(from))?.[1]
    expect(rule('.session-tabs-bar')).toMatch(/border-bottom: 1px solid var\(--agnes-line-primary\)/)
    expect(rule('.session-tabs')).not.toMatch(/padding|border/)
    expect(rule('#report-problem')).toMatch(/margin-left: auto/)
    const phone = css.indexOf('@media (max-width: 540px) {')
    expect(phone).toBeGreaterThan(-1)
    expect(rule('#report-problem', phone)).toMatch(/height: 2\.25rem/)
  })
})
