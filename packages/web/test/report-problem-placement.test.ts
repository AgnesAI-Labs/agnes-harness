/** @vitest-environment happy-dom */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

// agnes-code ui/desktop/src/components/icons/AgnesDiagnosticsIcon.tsx path, copied byte-for-byte.
const AGNES_DIAGNOSTICS_ICON_PATH =
  'M16.2496 8.24975C16.4584 8.24975 16.6354 8.32294 16.7809 8.46886C16.9273 8.61431 17 8.79139 17 9.00011C17 9.20789 16.9268 9.38545 16.7809 9.53136C16.712 9.60215 16.6293 9.65807 16.5379 9.69568C16.4465 9.73328 16.3484 9.75177 16.2496 9.75H14.2498V10.4999C14.2498 11.3957 14.0208 12.2292 13.5622 12.9998L15.2811 14.7187C15.427 14.8647 15.4998 15.0417 15.4998 15.25C15.4998 15.4582 15.427 15.6353 15.2811 15.7812C15.2122 15.852 15.1295 15.908 15.0381 15.9456C14.9468 15.9832 14.8487 16.0017 14.7499 15.9999C14.5416 15.9999 14.3645 15.9272 14.2186 15.7812L12.6249 14.1875C11.6663 15.0625 10.5415 15.5003 9.24994 15.5003H7.75017C6.45818 15.5003 5.33336 15.0625 4.37475 14.1875L2.78101 15.7812C2.71209 15.852 2.62939 15.908 2.53802 15.9456C2.44666 15.9832 2.34855 16.0017 2.24977 15.9999C2.04199 15.9999 1.86444 15.9272 1.71852 15.7812C1.64773 15.7123 1.59181 15.6296 1.55421 15.5383C1.51661 15.4469 1.49812 15.3488 1.49988 15.25C1.49988 15.0417 1.57308 14.8647 1.71852 14.7187L3.4374 12.9998C2.98351 12.2453 2.74567 11.3805 2.74985 10.4999V9.75H0.749999C0.541751 9.75 0.364669 9.67681 0.218753 9.53136C0.147964 9.46244 0.0920443 9.37974 0.0544416 9.28837C0.0168389 9.197 -0.00164984 9.0989 0.000115494 9.00011C0.000115494 8.79139 0.0728372 8.61431 0.218753 8.46886C0.287639 8.39799 0.370318 8.34198 0.461687 8.30429C0.553056 8.26661 0.651178 8.24804 0.749999 8.24975H2.74985V5.31252L1.46919 4.03137C1.3984 3.96245 1.34248 3.87975 1.30488 3.78838C1.26727 3.69701 1.24879 3.59891 1.25055 3.50012C1.25055 3.2914 1.32327 3.11432 1.46919 2.96887C1.53808 2.898 1.62075 2.84199 1.71212 2.8043C1.80349 2.76662 1.90161 2.74805 2.00044 2.74976C2.20868 2.74976 2.38577 2.82295 2.53168 2.96887L3.81281 4.25001H4.28173C4.28173 3.08362 4.69822 2.08345 5.53169 1.24998C6.36516 0.416501 7.36484 0 8.5317 0C9.69808 0 10.6982 0.416501 11.5317 1.24998C12.3652 2.08345 12.7817 3.08315 12.7817 4.25001H13.1878L14.4689 2.96887C14.5378 2.898 14.6205 2.84199 14.7118 2.8043C14.8032 2.76662 14.9013 2.74805 15.0002 2.74976C15.2089 2.74976 15.386 2.82295 15.5314 2.96887C15.6778 3.11432 15.7505 3.2914 15.7505 3.50012C15.7505 3.7079 15.6773 3.88546 15.5314 4.03137L14.2503 5.31252V8.24975H16.2496ZM10.4687 2.31248C9.9271 1.77084 9.28111 1.50025 8.53122 1.50025C7.78134 1.50025 7.13534 1.77084 6.59371 2.31248C6.05207 2.85412 5.78149 3.50012 5.78149 4.25001H11.281C11.281 3.50012 11.0104 2.85412 10.4687 2.31248ZM9.24994 14C10.2085 14 11.0312 13.6562 11.7187 12.9687C12.4063 12.2811 12.75 11.458 12.75 10.4999V5.7498H4.25009V10.5004C4.25009 11.458 4.59386 12.2811 5.28141 12.9687C5.96849 13.6562 6.79157 14 7.75017 14V8.12508C7.75017 7.8748 7.87484 7.75014 8.12512 7.75014H8.875C9.12528 7.75014 9.24994 7.8748 9.24994 8.12508V14Z'

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

    const bar = button.parentElement
    expect(bar?.classList.contains('session-tabs-bar')).toBe(true)
    const tablist = bar?.querySelector(':scope > .session-tabs[role="tablist"]')
    expect(tablist?.nextElementSibling).toBe(button)
    expect(bar?.lastElementChild).toBe(button)

    expect(button.type).toBe('button')
    expect(button.className).toBe('icon-button')
    expect(button.getAttribute('aria-label')).toBe('报告问题')
    expect(button.getAttribute('title')).toBe('报告问题')

    const svg = button.querySelector('svg')
    expect(svg?.getAttribute('class')).toBe('icon icon-fill')
    expect(svg?.getAttribute('data-agnes-region')).toBe('icon')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 20 20')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    const path = svg?.querySelector('g[transform="translate(1.8 2.25) scale(0.965)"] > path')
    expect(path?.getAttribute('d')).toBe(AGNES_DIAGNOSTICS_ICON_PATH)
  })

  it('moves the row chrome to the bar and keeps the button from growing the tab row on phones', () => {
    const css = readFileSync(resolve(__dirname, '../public/style.css'), 'utf8')
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
