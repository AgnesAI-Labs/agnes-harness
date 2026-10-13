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

it('keeps the permission popover compact and never wider than the viewport', async () => {
  const css = readWebStyleSource(resolve(packageDirectory, 'public', 'style.css'))
  const panel = ruleBody(css, '.permission-picker')

  // Each row is a name over one short line, so the list stays narrow; both bounds yield to a
  // narrow window, leaving a 16px gutter on each side.
  expect(panel).toContain('min-width: min(15rem, calc(100vw - 32px))')
  expect(panel).toContain('max-width: min(20rem, calc(100vw - 32px))')
  for (const bound of panel.match(/(?:min|max)-width: [^;]+/g) ?? [])
    expect(bound).toContain('calc(100vw - 32px)')
})
