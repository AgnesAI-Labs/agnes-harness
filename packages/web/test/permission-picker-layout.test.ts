import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const packageDirectory = process.cwd().endsWith('/packages/web')
  ? process.cwd()
  : resolve(process.cwd(), 'packages/web')

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `missing rule ${selector}`).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('}', start))
}

it('lets permission options scroll inside the viewport-clamped popover', async () => {
  const css = readWebStyleSource(resolve(packageDirectory, 'public', 'style.css'))
  const panel = ruleBody(css, '.permission-picker')

  expect(panel).toContain('overflow-y: auto')
  expect(panel).toContain('overscroll-behavior-y: contain')
})

it('gives the permission popover more width while keeping it bounded by the viewport', async () => {
  const css = readWebStyleSource(resolve(packageDirectory, 'public', 'style.css'))
  const panel = ruleBody(css, '.permission-picker')

  expect(panel).toContain('max-width: min(360px, calc(100vw - 32px))')
})
