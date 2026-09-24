import { describe, expect, it } from 'vitest'
import { exceedsConversionDepth } from '../src/depth.js'
import { renderHtml } from '../src/render.js'

const render = (html: string) => renderHtml(html, 'https://example.com')

describe('web HTML review regressions', () => {
  it.each([
    '<thead><tr><th>Name</th><th>Price</th></tr></thead><tbody><tr><td>A</td><td>10</td></tr><tr><td>B</td><td>20</td></tr></tbody>',
    '<tbody><tr><th>Name</th><th>Price</th></tr></tbody><tbody><tr><td>A</td><td>10</td></tr></tbody><tfoot><tr><td>B</td><td>20</td></tr></tfoot>',
    '<tr><th>Name</th><th>Price</th></tr><tr><td>A</td><td>10</td></tr><tr><td>B</td><td>20</td></tr>',
  ])('emits one separator across table row groups', (rows) => {
    expect(render(`<table>${rows}</table>`)).toBe('| Name | Price |\n| --- | --- |\n| A | 10 |\n| B | 20 |')
  })

  it('keeps each separate table header', () => {
    expect(render('<table><tr><th>A</th></tr></table><table><tr><th>B</th></tr></table>')).toBe(
      '| A |\n| --- |\n\n| B |\n| --- |',
    )
  })

  it('accepts shallow lists with optional end tags', () => {
    const implicit = `<ul>${'<li>Item'.repeat(513)}</ul>`
    expect(exceedsConversionDepth(implicit)).toBe(false)
    expect(render(implicit)).toBe(render(`<ul>${'<li>Item</li>'.repeat(513)}</ul>`))
  })

  it('does not count markup inside comments', () => {
    const html = `<!--${'<div>'.repeat(513)}--><p>Visible</p>`
    expect(exceedsConversionDepth(html)).toBe(false)
    expect(render(html)).toBe('Visible')
  })

  it.each([
    ['<p>Text', '<p>Text</p>'],
    ['<dl><dt>Term<dd>Definition</dl>', '<dl><dt>Term</dt><dd>Definition</dd></dl>'],
    ['<ul><li>Item</ul>', '<ul><li>Item</li></ul>'],
  ])('accepts adjacent optional ends without accumulating depth', (implicit, explicit) => {
    expect(exceedsConversionDepth(implicit.repeat(513))).toBe(false)
    expect(render(implicit.repeat(513))).toBe(render(explicit.repeat(513)))
  })

  it('rejects noscript nesting before DOM conversion', () => {
    const html = `<noscript>${'<div>'.repeat(15_000)}x</noscript>`
    expect(exceedsConversionDepth(html)).toBe(true)
    expect(() => render(html)).toThrow('WEB_CONVERSION_FAILED')
  })

  it.each([
    '<div/>'.repeat(600),
    '<div>'.repeat(600),
    '<ul><li>'.repeat(600),
    `${'<div>'.repeat(500)}<!--${'</div>'.repeat(500)}-->${'<div>'.repeat(20)}`,
    `<!-- --!>${'<div>'.repeat(600)}<!-- -->`,
    '<div><span></div>'.repeat(600),
    `<svg>${'<li>'.repeat(600)}`,
    `<math>${'<li>'.repeat(600)}`,
    `<!-->${'<div>'.repeat(600)}<!-- -->`,
    `<!--->${'<div>'.repeat(600)}<!-- -->`,
  ])('retains rejection of deep or misleading markup', (html) => {
    expect(exceedsConversionDepth(html)).toBe(true)
  })
})
