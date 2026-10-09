import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { build } from 'esbuild'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(import.meta.url)
const css = [
  readWebStyleSource(resolve(root, 'packages/web/public/style.css')),
  readFileSync(require.resolve('antd/dist/antd.css'), 'utf8'),
  readFileSync(resolve(root, 'packages/web-ui/src/tokens.css'), 'utf8'),
].join('\n')
let fixture: string

test.beforeAll(async () => {
  // Mount the real public Button and provider; SSR alone omits Ant's runtime variable declarations.
  const bundle = await build({
    stdin: {
      resolveDir: resolve(root, 'packages/web-ui'),
      loader: 'tsx',
      contents: `
        import { createElement } from 'react'
        import { createAntdRoot } from './src/antd-root.js'
        import { Button } from './src/ui/button.js'
        const variants = ['outlined', 'dashed', 'solid', 'filled', 'text', 'link']
        const props = ['default', 'primary', 'danger'].flatMap(color =>
          variants.map(variant => ({ color, variant })))
        props.push(...['default', 'primary', 'dashed', 'text', 'link'].map(type => ({ type })))
        props.push(...['default', 'primary', 'danger'].flatMap(color =>
          ['outlined', 'dashed'].map(variant => ({ color, variant, ghost: true }))))
        createAntdRoot(document.getElementById('fixture')).render(createElement('div', null,
          ...props.map((props, key) => createElement(Button, { ...props, key, id: 'button-' + key },
            (props.color || props.type || 'default') + '/' + (props.variant || 'legacy') +
              (props.ghost ? ' ghost' : ''))),
          ...['', 'primary-button', 'secondary-button'].map(className =>
            createElement('button', { key: className, className }, 'Native ' + className)),
          createElement('div', { className: 'workbench-panel-tabs', role: 'tablist' },
            createElement(Button, { type: 'text', role: 'tab', 'aria-selected': true }, 'Selected panel')),
          createElement('div', null,
            createElement(Button, { id: 'agent-chip', className: 'composer-agent' }, 'Agent Default agent')),
          createElement('fieldset', { className: 'appearance-options' },
            createElement('legend', null, 'Palette'),
            ...[true, false].map((checked, key) => createElement('label', { className: 'appearance-option', key },
              createElement('input', { type: 'radio', name: 'palette', defaultChecked: checked }),
              createElement('span', { className: 'appearance-option-copy' },
                createElement('span', { className: 'appearance-option-name' }, checked ? 'Selected' : 'Unselected'),
                createElement('span', { className: 'appearance-option-hint', id: 'appearance-hint-' + key }, 'Readable hint')))))))
      `,
    },
    bundle: true,
    write: false,
    jsx: 'automatic',
    format: 'iife',
  })
  const script = bundle.outputFiles[0]
  if (!script) throw new Error('The real Button fixture did not compile')
  fixture = script.text
})

async function readable(page: Page, state: string) {
  const scan = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()
  expect([...scan.violations, ...scan.incomplete], state).toEqual([])
  expect(
    scan.passes
      .find(({ id }) => id === 'color-contrast')
      ?.nodes.filter(({ target }) => target.some((selector) => String(selector).includes('appearance-hint-')))
      .length,
    state,
  ).toBe(2)
  expect(
    scan.passes.find(({ id }) => id === 'color-contrast')?.nodes.length ?? 0,
    state,
  ).toBeGreaterThanOrEqual(32)
}

for (const theme of ['light', 'dark'])
  test(`keeps buttons and appearance choices readable in forced states: ${theme}`, async ({ page }) => {
    await page.setContent(`<html class="${theme === 'dark' ? 'dark' : ''}" lang="zh-CN"><head>
      <style>${css}
        body { display: block }
        #fixture > div { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding: 12px }
        #fixture button { height: 48px }
      </style></head><body data-agnes-region="app"><main id="fixture"></main></body></html>`)
    await page.addScriptTag({ content: fixture })
    await page.waitForSelector('#button-28')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('CSS.enable')
    const { root: documentNode } = await cdp.send('DOM.getDocument')
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: documentNode.nodeId,
      selector: 'button, .appearance-option',
    })
    expect(nodeIds).toHaveLength(36)
    const agentSize = () =>
      page.locator('#agent-chip').evaluate((button) => {
        const { width, height } = button.getBoundingClientRect()
        return { width, height }
      })
    const restingAgentSize = await agentSize()
    for (const state of [[], ['hover'], ['hover', 'active'], ['focus', 'focus-visible']]) {
      for (const nodeId of nodeIds)
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state })
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)))
      // A hover border must not wrap the composer toolbar and move a button away from the pointer.
      expect(await agentSize(), `${theme}/${state.join('+') || 'normal'} Agent geometry`).toEqual(
        restingAgentSize,
      )
      await readable(page, `${theme}/${state.join('+') || 'normal'}`)
    }
    for (const nodeId of nodeIds)
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] })
    // Busy controls can become enabled beneath the pointer. Check the first animation frame,
    // not only its settled colors; a transient low-contrast frame is still visible to users.
    await page.locator('button').evaluateAll((buttons) => {
      for (const button of buttons) button.setAttribute('disabled', '')
      void document.body.offsetHeight
      for (const animation of document.getAnimations()) animation.finish()
      for (const button of buttons) button.removeAttribute('disabled')
      void document.body.offsetHeight
      for (const animation of document.getAnimations()) {
        animation.pause()
        animation.currentTime = 0
      }
    })
    await readable(page, `${theme}/enabled beneath pointer`)
  })
