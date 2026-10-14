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
})
