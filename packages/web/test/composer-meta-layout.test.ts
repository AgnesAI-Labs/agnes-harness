import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'

const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))

describe('composer rows', () => {
  it('puts context use against the model picker and takes no room below an empty card', () => {
    expect(css).toMatch(/\.composer-controls > #session-usage \{[^}]*margin-inline-start: auto;/)
    expect(css).toMatch(
      /\.composer-controls > #session-usage:not\(\[hidden\]\) \+ \.model-field \{\s*margin-inline-start: 0;/,
    )
    // The row under the card shows only for the new-session workspace or a plugin control.
    const empty = ':has(#composer-workspace:not([hidden]), [data-slot]:not([data-slot-state="empty"]))'
    expect(css).toContain(`.composer-meta:not(${empty}) {\n    display: none;`)
    // Without the row the card keeps its distance from the window's edge.
    expect(css).toMatch(/#composer-mount:not\(\s*:has\([^)]*\.composer-meta #composer-workspace/)
  })

  it('joins the queue tray to the card, shows three lines and reveals actions on hover or focus', () => {
    // The selector's own rule: it starts after a rule or a comment, so a shared selector list does not match.
    const rule = (selector: string) =>
      new RegExp(`(?:[}{]|\\*/)\n  ${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} {([^}]*)}`).exec(
        css,
      )?.[1] ?? ''
    // The tray and the paused strip share the card's top edge: no bottom border, top corners only.
    expect(rule('.composer-queue,\n  .composer-paused')).toMatch(/border-bottom: 0;/)
    expect(rule('.composer-queue-list')).toMatch(/max-height: calc\(3 \* 2rem/)
    expect(rule('.composer-queue-list')).toMatch(/overflow-y: auto;/)
    expect(rule('.composer-queue-actions')).toMatch(/opacity: 0;/)
    expect(css).toMatch(
      /\.composer-queue-list > li:is\(:hover, :focus-within\) \.composer-queue-actions,[^{]*\{\s*opacity: 1;/,
    )
    // A narrow card keeps "send now" as its icon.
    expect(css).toMatch(/@media \(max-width: 540px\) \{[^@]*\.composer-queue-send-label \{\s*display: none;/)
    // Paused is a pale warning strip; pause sits beside stop at the same size and turns into continue.
    expect(rule('.composer-paused')).toMatch(/background: var\(--agnes-status-warning-bg\);/)
    expect(rule('#composer-pause')).toMatch(/width: 2\.25rem;[\s\S]*height: 2\.25rem;/)
    expect(rule('#composer-pause[aria-pressed="true"]:not(:disabled)')).toMatch(
      /background: var\(--agnes-button-primary-bg\);/,
    )
  })
})
