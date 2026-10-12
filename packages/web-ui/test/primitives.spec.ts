import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { build } from 'esbuild'
import { inCssLayer, readWebStyleSource, readWebUiStyleSource } from '../../../tools/web-style-source.mjs'

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
  inCssLayer(readFileSync(createRequire(import.meta.url).resolve('antd/dist/antd.css'), 'utf8'), 'vendor'),
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
        <Dialog open={false} forceRender title="Closed confirmation" onCancel={() => select('Closed dialog canceled')} footer={null} />
        <ListRow title="Synthetic row" icon={<Icon name="plug" size={20}/>} description="A short description" onOpen={() => setDrawer(true)} actions={<Menu label="Row actions" trigger={<Button>Row actions</Button>} items={[{id:'row-copy', label:'Copy row', onSelect:() => select('Row copied')}]} />}/>
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
  await page.getByRole('button', { name: 'Row actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Copy row', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Row copied')
  await expect(page.getByRole('dialog', { name: 'Details', exact: true })).toBeHidden()
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
  const handle = dialog.locator('.agh-sheet-handle')
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
  await page.keyboard.press('Escape')
  await expect(native).toBeHidden()
  await expect(nativeTrigger).toBeFocused()
  await nativeTrigger.click()
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

for (const theme of ['light', 'dark'])
  for (const width of [1280, 390])
    test(`sidebar navigation hierarchy and containment ${theme}/${width}`, async ({ page }) => {
      const result = await build({
        stdin: {
          loader: 'ts',
          resolveDir: resolve(root, 'packages/web'),
          contents: `import { renderSessionNavigation } from './src/navigation.js'
            renderSessionNavigation({ nav: document.getElementById('sessions'),
              sessions: [{ sessionId:'current', title:'A very long session title '.repeat(20), cwd:'/workspace', archived:false }],
              workspaces: [{path:'/workspace', name:'A very long workspace name '.repeat(20), available:true}],
              labels: new Map(), currentId:'current', newSession:()=>{}, open:()=>{}, action:()=>{}
            }, key => key)`,
        },
        bundle: true,
        write: false,
        format: 'iife',
      })
      await page.setViewportSize({ width, height: 900 })
      await page.setContent(`<html class="${theme === 'dark' ? 'dark' : ''}"><head><style>${css}</style></head>
        <body data-agnes-region="app" class="sidebar-open"><aside class="sidebar"><nav id="sessions"></nav></aside><main></main></body></html>`)
      await page.addScriptTag({ content: result.outputFiles[0]!.text })
      const heading = page.locator('.workspace-heading'),
        session = page.locator('.session')
      await expect(session).toHaveAttribute('aria-current', 'page')
      for (const locator of [heading, session]) {
        expect(
          await locator.evaluate((node) => {
            const style = getComputedStyle(node)
            return { justify: style.justifyContent, weight: style.fontWeight, border: style.borderColor }
          }),
        ).toEqual({ justify: 'flex-start', weight: '400', border: 'rgba(0, 0, 0, 0)' })
        await locator.focus()
        expect(await locator.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('solid')
      }
      expect(
        await session.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft)),
      ).toBeGreaterThan(
        await heading.evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft)),
      )
      expect(
        await page.locator('.session-row').evaluate((node) => getComputedStyle(node).backgroundColor),
      ).not.toBe('rgba(0, 0, 0, 0)')
      const sidebar = (await page.locator('.sidebar').boundingBox())!
      for (const selector of [
        '.workspace-heading-row',
        '.session-row',
        '.workspace-new-session',
        '.session-menu-trigger',
      ]) {
        const box = (await page.locator(selector).boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(sidebar.x)
        expect(box.x + box.width).toBeLessThanOrEqual(sidebar.x + sidebar.width)
      }
      for (const selector of ['.workspace-name', '.session-title']) {
        expect(
          await page.locator(selector).evaluate((node) => ({
            ellipsis: getComputedStyle(node).textOverflow,
            nowrap: getComputedStyle(node).whiteSpace,
            clipped: node.scrollWidth > node.clientWidth,
          })),
        ).toEqual({ ellipsis: 'ellipsis', nowrap: 'nowrap', clipped: true })
      }
    })

test('one application isolates a region failure, translates retry and preserves sibling state', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const result = await build({
    stdin: {
      loader: 'tsx',
      resolveDir: resolve(root, 'packages/web-ui'),
      contents: `import { useState } from 'react'
        import { flushSync } from 'react-dom'
        import { mountApplication, createRegionRenderer } from './src/antd-root.js'
        import { Button } from './src/ui/button.js'
        let failed = false
        function Sibling() { const [count, setCount] = useState(0); return <Button onClick={() => setCount(value => value + 1)}>Sibling count {count}</Button> }
        function Region() { if (failed) throw new Error('Synthetic region fixture fault'); return <p>Region healthy</p> }
        function Shell({ children }) { return <main>
          <h1>Application regions</h1><section id="sibling-region" aria-label="Sibling"/><section id="failed-region" aria-label="Recoverable region"/>
          <Button id="break-region" onClick={() => { failed = true; renderer.render(<Region />) }}>Break region</Button>
          <Button id="repair-region" onClick={() => { failed = false }}>Make region healthy</Button>
          {children}</main> }
        mountApplication(document.getElementById('application'), <Shell />)
        const sibling = createRegionRenderer(document.getElementById('sibling-region'))
        const renderer = createRegionRenderer(document.getElementById('failed-region'))
        flushSync(() => { sibling.render(<Sibling />); renderer.render(<Region />) })`,
    },
    bundle: true,
    write: false,
    jsx: 'automatic',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  await page.goto('about:blank')
  await page.setContent(
    `<html lang="en"><head><title>Application regions</title><style>${css} body {display:block} main {padding:32px}</style></head><body><div id="application"></div></body></html>`,
  )
  await page.addScriptTag({ content: result.outputFiles[0]!.text })
  await page.getByRole('button', { name: 'Sibling count 0', exact: true }).click()
  await page.getByRole('button', { name: 'Break region', exact: true }).click()
  const failure = page.locator('[data-agnes-region-error="failed-region"]')
  await expect(failure).toContainText('This region failed')
  await expect(page.getByRole('button', { name: 'Sibling count 1', exact: true })).toBeVisible()
  await page.evaluate(() => {
    document.documentElement.lang = 'zh-CN'
  })
  await expect(failure).toContainText('该区域出错')
  await page.getByRole('button', { name: 'Make region healthy', exact: true }).click()
  await failure.getByRole('button', { name: '重试', exact: true }).click()
  await expect(failure).toBeHidden()
  await expect(page.getByText('Region healthy', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sibling count 1', exact: true })).toBeVisible()
  expect(errors.some((error) => error.startsWith('Agnes region render failed'))).toBe(true)
  expect(
    errors.filter(
      (error) =>
        !error.includes('Synthetic region fixture fault') && !error.startsWith('Agnes region render failed'),
    ),
  ).toEqual([])
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(scan.violations).toEqual([])
})
