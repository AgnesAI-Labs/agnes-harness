import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelCss = readFileSync(new URL('../public/styles/13-turn-process.css', import.meta.url), 'utf8')
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
  it('usage panel: no stand-alone disclosure marker, an inset body and a fixed 58px share bar', () => {
    const rule = (selector: string) => {
      const start = panelCss.indexOf(`${selector} {`)
      expect(start, selector).toBeGreaterThan(-1)
      return panelCss.slice(start, panelCss.indexOf('}', start))
    }
    expect(rule('  .turn-usage-panel .agh-disclosure-marker')).toContain('display: none')
    expect(rule('  .turn-usage-calls-body')).toContain('padding: 0 0.875rem')
    expect(css).toContain('.turn-process > .agh-disclosure-content[hidden]')
    expect(css).not.toContain('.turn-process > .agh-disclosure-content {')
    expect(rule('  .turn-call-share')).toContain('width: 3.625rem')
    expect(rule('  .turn-call > .agh-disclosure-summary')).toContain('display: flex')
    expect(rule('  .turn-call > .agh-disclosure-summary')).toContain('padding: 0.3125rem 0')
  })
})
