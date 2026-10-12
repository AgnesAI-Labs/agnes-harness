import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'

const packageDirectory = process.cwd().endsWith('/packages/web')
  ? process.cwd()
  : resolve(process.cwd(), 'packages/web')

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s*${escaped} \\{([^}]*)\\}`, 'm').exec(css)
  expect(match, `missing rule ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
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
