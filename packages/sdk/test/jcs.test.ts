import { jcs as shared } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { jcs as browser } from '../src/index.browser.js'
import { jcs as node } from '../src/index.node.js'

it('uses the same strict JCS implementation through both SDK entry points', () => {
  expect(node).toBe(shared)
  expect(browser).toBe(shared)
  expect(browser({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  expect(() => node({ a: Infinity })).toThrow(/^invalid JCS input$/)
})
