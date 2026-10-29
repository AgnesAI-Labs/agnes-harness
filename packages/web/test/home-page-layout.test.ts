import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'

const css = readWebStyleSource(resolve(__dirname, '../public/style.css')).replace(/\/\*[\s\S]*?\*\//g, '')

/** Every innermost style rule, with its at-rule headers dropped from the selector. */
function rules(): { selectors: string[]; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, head = '', body = '']) => ({
    selectors: (head.split(/[;{}]/).pop() ?? '')
      .split(/,(?![^(]*\))/)
      .map((selector) => selector.trim().replace(/\s+/g, ' ')),
    body,
  }))
}

const ruleBody = (selector: string) => rules().find((rule) => rule.selectors.includes(selector))?.body

describe('home page layout', () => {
  it('reserves no dock column on main while a home page shows', () => {
    // The open session dock shrinks main from the side; a home page hides the dock, so the same
    // rules would leave the page off-centre once the session restores its open dock after load.
    const offenders = rules().flatMap(({ selectors, body }) =>
      /(^|;)\s*(padding|margin)(-inline|-left|-right)?(-start|-end)?\s*:/.test(body)
        ? selectors.filter(
            (selector) =>
              /\bmain\S*:has\(\.workbench-(right|bottom)-open\)/.test(selector) &&
              !selector.includes('main:not([data-home-page])'),
          )
        : [],
    )
    expect(offenders).toEqual([])
    expect(css).toMatch(/main:not\(\[data-home-page\]\):has\(\.workbench-right-open\) \{[^}]*padding-right/)
  })

  it('centres the page in the whole main area with symmetric gutters', () => {
    expect(ruleBody('.home-page')).toMatch(/margin: 0 auto;/)
    expect(ruleBody('.home-page-host')).toMatch(/scrollbar-gutter: stable both-edges;/)
    // The session surfaces, docks included, step aside behind the page.
    expect(css).toMatch(/main\[data-home-page\] > :is\(\.workbench-split,/)
  })

  it('lays the home agent cards out as a feed instead of an equal-height grid', () => {
    // Cards differ in height; a grid row would pad every short card with blank space.
    expect(ruleBody('.agent-feed')).toMatch(/columns: 16\.875rem;/)
    expect(ruleBody('.agent-feed')).toMatch(/display: block;/)
    expect(ruleBody('.agent-feed > .agent-card')).toMatch(/break-inside: avoid;/)
  })

  it('lifts the brand mark onto the midline of the name and the collapse button', () => {
    // The mark's ink sits low in its square, so its box is raised to centre what the eye sees.
    expect(ruleBody('.sidebar-head .brand-mark-image')).toMatch(/translate: 0 -2px;/)
    expect(ruleBody('.brand-lockup')).toMatch(/align-items: center;/)
  })

  it('keeps the sidebar footer pinned: the sidebar clips, only the session list scrolls', () => {
    expect(ruleBody('.sidebar')).toMatch(/overflow: hidden;/)
    expect(ruleBody('.sidebar-footer')).toMatch(/flex: none;/)
  })
})
