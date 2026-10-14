import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/intelligent-ui/styles.css', import.meta.url), 'utf8')
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('}', start))
}

describe('deliverable open split button', () => {
  it('is one 28px frame with a divider; the halves draw no outline, corner or shadow of their own', () => {
    const frame = rule('  .deliverable-actions')
    for (const declaration of [
      'height: 1.75rem',
      'border: 1px solid',
      'overflow: hidden',
      'align-self: center',
    ])
      expect(frame).toContain(declaration)
    expect(rule('  .deliverable-actions > .agh-menu-anchor')).toContain('border-inline-start: 1px solid')
    const halves = rule(
      '  .deliverable-file .deliverable-actions :is(.deliverable-open, .deliverable-open-with).agh-btn',
    )
    for (const declaration of ['height: auto', 'border: 0', 'border-radius: 0', 'box-shadow: none'])
      expect(halves).toContain(declaration)
  })
})
