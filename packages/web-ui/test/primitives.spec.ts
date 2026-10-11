import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { build } from 'esbuild'
import { readWebStyleSource, readWebUiStyleSource } from '../../../tools/web-style-source.mjs'

const root = resolve(import.meta.dirname, '../../..')
async function settled(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        preparing: [...document.querySelectorAll('[class]')].some((node) =>
          [...node.classList].some((name) => /^ant-.*-(?:appear|enter|leave)-(?:prepare|start)$/.test(name)),
        ),
        running: document
          .getAnimations()
          .filter(
            (animation) =>
              animation.playState === 'running' &&
              Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity),
          ).length,
      })),
    )
    .toEqual({ preparing: false, running: 0 })
}
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
    import React, { useState, useRef, useEffect } from 'react'
    import { bindDialogSheets } from './src/dom/dialog-sheets.js'
    import { createAntdRoot } from './src/antd-root.js'
    import { Button } from './src/ui/button.js'
    import { IconButton } from './src/ui/icon-button.js'
    import { Icon } from './src/ui/icon.js'
    import { ListRow } from './src/ui/list-row.js'
    import { Menu } from './src/ui/menu.js'
    import { Drawer } from './src/ui/drawer.js'
    import { Dialog } from './src/ui/dialog.js'
    import { Field } from './src/ui/field.js'
    function Fixture() {
      const [drawer, setDrawer] = useState(false), [dialog, setDialog] = useState(false)
      const [selected, select] = useState('')
      const [refreshed, refresh] = useState(0)
      const native = useRef(null), [locked, lock] = useState(false)
      useEffect(() => bindDialogSheets(document), [])
      return <main>
        <Button type="primary" id="react-primary">Save</Button>
        <button type="button" className="primary-button" id="native-primary">Save</button>
        <IconButton name="refresh-cw" label="Refresh" id="icon-action" onClick={() => refresh(value => value + 1)} />
        <p id="refresh-count" aria-live="polite">Refreshed {refreshed}</p>
        <Menu label="Actions" trigger={<Button>More</Button>} items={[
          {id:'delete', label:'Delete', danger:true, onSelect:() => select('Deleted')},
          {id:'edit', label:'Edit', onSelect:() => select('Edited')},
          {id:'copy', label:'Copy', onSelect:() => select('Copied')},
        ]}/><p role="status">{selected}</p>
        <Button onClick={() => setDrawer(true)}>Open details</Button>
        <Button onClick={() => setDialog(true)}>Open confirmation</Button>
        <Button onClick={() => native.current.showModal()}>Open native details</Button>
        <dialog ref={native} aria-labelledby="native-heading" onCancel={event => { if (locked) event.preventDefault() }}>
          <section className="account-dialog-body">
            <h2 id="native-heading">Native details</h2>
            <div style={{overflow:'auto', minHeight:0, flex:'1 1 auto'}}>{Array.from({length:50}, (_, index) => <p key={index}>Synthetic native content {index}</p>)}</div>
            <footer><Button onClick={() => lock(value => !value)}>{locked ? 'Unlock' : 'Lock'}</Button></footer>
          </section>
        </dialog>
        <Drawer open={drawer} title="Details" onClose={() => setDrawer(false)}><Field label="Name"><input /></Field></Drawer>
        <Dialog open={dialog} title="Confirm changes" size="sm" onCancel={() => setDialog(false)} footer={<Button onClick={() => setDialog(false)}>Cancel</Button>}>
          <p>Review your changes.</p><Field label="Name" error="Enter a name"><input /></Field>
        </Dialog>
        <ListRow title="Synthetic row" icon={<Icon name="plug" size={20}/>} description="A short description" onOpen={() => setDrawer(true)} actions={<Button>Open</Button>}/>
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
  await expect(page.locator('.agh-list-row')).toHaveCSS('height', '56px')
  await page.locator('.agh-list-row p').click()
  await expect(page.getByRole('dialog', { name: 'Details', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Synthetic row', exact: true })).toBeFocused()
  await settled(page)
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
  await expect(icon).toHaveCSS('width', '28px')
  await expect(icon).toHaveCSS('height', '28px')
  await icon.focus()
  await expect(page.getByRole('tooltip')).toHaveText('Refresh')
  const target = await icon.evaluate((node) => {
    const style = getComputedStyle(node, '::after')
    return [Number.parseFloat(style.width), Number.parseFloat(style.height)]
  })
  expect(target[0]).toBeGreaterThanOrEqual(44)
  expect(target[1]).toBeGreaterThanOrEqual(44)
  const iconBounds = await icon.boundingBox()
  if (!iconBounds) throw new Error('Icon action is not visible')
  // A real click outside the 28px visual confirms that the expanded target receives input.
  await page.mouse.click(iconBounds.x + iconBounds.width + 4, iconBounds.y + iconBounds.height / 2)
  await expect(page.locator('#refresh-count')).toHaveText('Refreshed 1')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.mouse.click(iconBounds.x - 4, iconBounds.y + iconBounds.height / 2)
  await expect(page.locator('#refresh-count')).toHaveText('Refreshed 2')
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
  await page.getByRole('button', { name: 'Open details' }).click()
  const drawer = page.getByRole('dialog', { name: 'Details' })
  await expect(drawer).toHaveCSS('width', '390px')
  await expect(drawer).toHaveCSS('height', '844px')
  await settled(page)
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(scan.violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  const nativeTrigger = page.getByRole('button', { name: 'Open native details', exact: true })
  await page.setViewportSize({ width: 390, height: 667 })
  await nativeTrigger.click()
  const native = page.getByRole('dialog', { name: 'Native details', exact: true })
  const nativeHandle = native.locator('.agh-native-sheet-handle')
  await expect(nativeHandle).toBeVisible()
  await settled(page)
  const nativeBounds = await native.boundingBox()
  const footerBounds = await native.getByRole('button', { name: 'Lock', exact: true }).boundingBox()
  if (!nativeBounds || !footerBounds) throw new Error('Native sheet or footer is missing')
  expect(footerBounds.y + footerBounds.height).toBeLessThanOrEqual(nativeBounds.y + nativeBounds.height)
  await native.getByRole('button', { name: 'Lock', exact: true }).click()
  const dragNative = async () => {
    const handleBounds = await nativeHandle.boundingBox()
    if (!handleBounds) throw new Error('Native sheet handle is missing')
    await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + 10)
    await page.mouse.down()
    await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + 120, { steps: 8 })
    await page.mouse.up()
  }
  await dragNative()
  await expect(native).toBeVisible()
  await native.getByRole('button', { name: 'Unlock', exact: true }).click()
  await dragNative()
  await expect(native).toBeHidden()
  await expect(nativeTrigger).toBeFocused()
})
