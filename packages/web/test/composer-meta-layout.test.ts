import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'

const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))
// The selector's own rule: it starts after a rule or a comment, so a shared selector list does not match.
const rule = (selector: string) =>
  new RegExp(`(?:[}{]|\\*/)\n  ${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} {([^}]*)}`).exec(
    css,
  )?.[1] ?? ''

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

  it('keeps send and the voice buttons in a narrow row: only the voice status and notice shrink', () => {
    expect(rule('.composer-voice')).toMatch(/display: contents;/)
    expect(rule('.composer-voice-button')).toMatch(/flex: none;/)
    expect(rule('.composer-voice-status,\n  .composer-voice-notice')).toMatch(
      /flex: 0 1 auto;\s*min-width: 0;\s*overflow: hidden;[^}]*text-overflow: ellipsis;/,
    )
    // The transcribing icon turns, and holds still for reduced motion.
    expect(rule('.composer-voice-spin')).toMatch(/animation: composer-voice-spin 1s linear infinite;/)
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.composer-voice-spin \{\s*animation: none;/,
    )
  })
})
