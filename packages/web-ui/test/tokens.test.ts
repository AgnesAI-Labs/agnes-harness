import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

describe('web-ui theme bridge', () => {
  it('only references semantic tokens declared by the existing Web skin', () => {
    const bridge = readFileSync(resolve(root, 'packages/web-ui/src/tokens.css'), 'utf8')
    const skin = readFileSync(resolve(root, 'packages/web/public/style.css'), 'utf8')
    const references = [...bridge.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1])
    const missing = [...new Set(references)].filter((name) => !skin.includes(`${name}:`))
    expect(missing).toEqual([])
  })

  it('maps the used Ant Design semantic variables emitted by zeroRuntime', () => {
    const bridge = readFileSync(resolve(root, 'packages/web-ui/src/tokens.css'), 'utf8')
    const antd = readFileSync(createRequire(import.meta.url).resolve('antd/dist/antd.css'), 'utf8')
    const required = [
      '--ant-color-primary',
      '--ant-color-primary-hover',
      '--ant-color-text',
      '--ant-color-text-heading',
      '--ant-color-text-label',
      '--ant-color-text-description',
      '--ant-color-text-placeholder',
      '--ant-color-icon',
      '--ant-color-icon-hover',
      '--ant-color-bg-container',
      '--ant-color-bg-elevated',
      '--ant-color-bg-text-hover',
      '--ant-color-bg-text-active',
      '--ant-color-border',
      '--ant-color-split',
      '--ant-control-outline',
    ]
    expect(required.filter((name) => !antd.includes(`var(${name})`))).toEqual([])
    expect(required.filter((name) => !bridge.includes(`${name}: var(--agnes-`))).toEqual([])
  })

  it('loads the theme bridge after Ant Design CSS on every Web entry page', () => {
    for (const page of ['index', 'admin', 'resources']) {
      const html = readFileSync(resolve(root, `packages/web/public/${page}.html`), 'utf8')
      const skin = html.indexOf('href="/style.css"')
      const antd = html.indexOf('href="/antd.css"')
      const bridge = html.indexOf('href="/tokens.css"')
      expect(skin).toBeGreaterThan(-1)
      expect(antd).toBeGreaterThan(skin)
      expect(bridge).toBeGreaterThan(antd)
    }
  })
})
