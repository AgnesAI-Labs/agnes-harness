import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { readWebStyleSource, readWebUiStyleSource } from '../../../tools/web-style-source.mjs'

const root = resolve(import.meta.dirname, '../../..')
const css = [
  readWebStyleSource(resolve(root, 'packages/web/public/style.css')),
  readFileSync(createRequire(import.meta.url).resolve('antd/dist/antd.css'), 'utf8'),
  readWebUiStyleSource(resolve(root, 'packages/web-ui/src/tokens.css')),
].join('\n')
let fixture: string
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      loader: 'tsx',
      resolveDir: resolve(root, 'packages/web-ui'),
      contents: `
    import React, { useState } from 'react'
    import { createAntdRoot } from './src/antd-root.js'
    import { Button } from './src/ui/button.js'
    import { IconButton } from './src/ui/icon-button.js'
    import { Menu } from './src/ui/menu.js'
    import { Drawer } from './src/ui/drawer.js'
    import { Dialog } from './src/ui/dialog.js'
    import { Field } from './src/ui/field.js'
    function Fixture() {
      const [drawer, setDrawer] = useState(false), [dialog, setDialog] = useState(false)
      const [selected, select] = useState('')
      return <main>
        <Button type="primary" id="react-primary">Save</Button>
        <button type="button" className="primary-button" id="native-primary">Save</button>
        <IconButton name="refresh-cw" label="Refresh" id="icon-action" />
        <Menu label="Actions" trigger={<Button>More</Button>} items={[
          {id:'delete', label:'Delete', danger:true, onSelect:() => select('Deleted')},
          {id:'edit', label:'Edit', onSelect:() => select('Edited')},
          {id:'copy', label:'Copy', onSelect:() => select('Copied')},
        ]}/><p role="status">{selected}</p>
        <Button onClick={() => setDrawer(true)}>Open details</Button>
        <Button onClick={() => setDialog(true)}>Open confirmation</Button>
        <Drawer open={drawer} title="Details" onClose={() => setDrawer(false)}><Field label="Name"><input /></Field></Drawer>
        <Dialog open={dialog} title="Confirm changes" size="sm" onCancel={() => setDialog(false)} footer={<Button onClick={() => setDialog(false)}>Cancel</Button>}>
          <p>Review your changes.</p><Field label="Name" error="Enter a name"><input /></Field>
        </Dialog>
      </main>
    }
    createAntdRoot(document.getElementById('fixture')).render(<Fixture />)
  `,
    },
    bundle: true,
    write: false,
    jsx: 'automatic',
    format: 'iife',
  })
  if (!result.outputFiles[0]) throw new Error('No component fixture')
  fixture = result.outputFiles[0].text
})
test.beforeEach(async ({ page }) => {
  await page.setContent(`<html lang="en"><head><title>Shared components</title><style>${css} body {display:block} main {padding:32px;display:flex;gap:24px;flex-wrap:wrap}</style></head>
    <body data-agnes-region="app"><div id="fixture"></div></body></html>`)
  await page.addScriptTag({ content: fixture })
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeVisible()
})
test('native and React buttons converge; keyboard menu restores focus', async ({ page }) => {
  const presentation = (selector: string) =>
    page.locator(selector).evaluate((node) => {
      const style = getComputedStyle(node)
      return [
        'height',
        'color',
        'backgroundColor',
        'borderColor',
        'borderRadius',
        'fontSize',
        'fontWeight',
        'paddingInlineStart',
        'paddingInlineEnd',
      ].map((property) => style[property as keyof CSSStyleDeclaration])
    })
  expect(await presentation('#native-primary')).toEqual(await presentation('#react-primary'))
  const trigger = page.getByRole('button', { name: 'More', exact: true })
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Copy' })).toBeFocused()
  await page.keyboard.press('d')
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Copy' }).click()
  await expect(page.getByRole('status')).toHaveText('Copied')
  await expect(trigger).toBeFocused()
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(scan.violations).toEqual([])
})
test('native drawer is modal, closes on Escape and restores focus', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Open details' })
  await trigger.click()
  const drawer = page.getByRole('dialog', { name: 'Details' })
  await expect(drawer).toBeVisible()
  await expect(drawer).toHaveCSS('width', '480px')
  await expect(drawer.getByRole('textbox', { name: 'Name' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(trigger).toBeFocused()
})
test('narrow icon hit area, focus tooltip and draggable bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const icon = page.getByRole('button', { name: 'Refresh', exact: true })
  await icon.focus()
  await expect(page.getByRole('tooltip')).toHaveText('Refresh')
  const target = await icon.evaluate((node) => {
    const style = getComputedStyle(node, '::after')
    return [Number.parseFloat(style.width), Number.parseFloat(style.height)]
  })
  expect(target[0]).toBeGreaterThanOrEqual(44)
  expect(target[1]).toBeGreaterThanOrEqual(44)
  await page.getByRole('button', { name: 'Open confirmation' }).click()
  const dialog = page.getByRole('dialog', { name: 'Confirm changes' })
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  expect(bounds?.width).toBeLessThanOrEqual(390)
  const handle = page.locator('.agh-sheet-handle')
  const box = await handle.boundingBox()
  if (!box) throw new Error('Sheet handle is not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + 120, { steps: 8 })
  await page.mouse.up()
  await expect(dialog).toBeHidden()
})
