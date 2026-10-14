import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../public/styles/27-conversation-stream.css', import.meta.url), 'utf8')

describe('answer action row', () => {
  it('is always shown, not only on hover', () => {
    expect(css).not.toMatch(/\.turn-footer\s*\{[^}]*opacity:\s*0/)
    expect(css).not.toMatch(/:hover\s+\.turn-footer/)
  })
  it('keeps the facts on the bar line: they shrink with an ellipsis rather than wrap', () => {
    const rule = css.slice(css.indexOf('.turn-footer .turn-usage {'))
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/flex: 1 1 0;[\s\S]*min-width: 0;/)
  })
})
