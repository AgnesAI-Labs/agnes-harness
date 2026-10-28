import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, type Locator, type Page, test } from '@playwright/test'
import { build } from 'esbuild'
import { inCssLayer, readWebStyleSource, readWebUiStyleSource } from '../../../tools/web-style-source.mjs'
import { tabsAria } from '../../../tools/web-tabs-aria.mjs'

const root = resolve(import.meta.dirname, '../../..')
async function keyboardFocus(page: Page, target: Locator) {
  await target.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(target).toBeFocused()
}
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
    import { Tabs } from './src/ui/tabs.js'
    import { Toast } from './src/overlay-toast.js'
    import { createSelectPicker } from './src/select-picker.js'
    function Fixture() {
      const [drawer, setDrawer] = useState(false), [dialog, setDialog] = useState(false)
      const [selected, select] = useState('')
      const [description, setDescription] = useState(true)
      const [nested, setNested] = useState(false), [notice, setNotice] = useState(false)
      const [nestedKeyboard, setNestedKeyboard] = useState(true)
      const [refreshed, refresh] = useState(0)
      const native = useRef(null), [locked, lock] = useState(false)
      const choice = useRef(null)
      useEffect(() => bindDialogSheets(document), [])
      useEffect(() => { const picker = createSelectPicker(choice.current, {label:'Synthetic selection'}); return () => picker.destroy() }, [])
      return <main>
        <Button type="primary" id="react-primary">Save</Button>
        <button type="button" className="primary-button" id="native-primary">Save</button>
        <IconButton name="refresh-cw" label="Refresh" id="icon-action" onClick={() => refresh(value => value + 1)} />
        <p id="refresh-count" aria-live="polite">Refreshed {refreshed}</p>
        <Menu label="Actions" trigger={<IconButton name="ellipsis" label="More"/>} items={[
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
        <Drawer open={drawer} title="Details" onClose={() => { setDrawer(false); select('Drawer closed') }}>
          <Field label="Name"><input /></Field>
          <Button onClick={() => setNested(true)}>Open nested confirmation</Button>
          <Dialog open={nested} keyboard={nestedKeyboard} title="Nested confirmation" onCancel={() => { setNested(false); select('Nested canceled') }} footer={<Button onClick={() => setNested(false)}>Cancel nested confirmation</Button>}>
            <Menu label="Nested actions" trigger={<Button>Nested menu</Button>} items={[{id:'notify', label:'Show notification', onSelect:() => setNotice(true)}]} />
            <IconButton name="info" label="Explain nested action" />
            <Button onClick={() => setNestedKeyboard(value => !value)}>{nestedKeyboard ? 'Lock nested Escape' : 'Unlock nested Escape'}</Button>
            <Toast open={notice} onDismiss={() => setNotice(false)} duration={0}>Nested notification</Toast>
          </Dialog>
        </Drawer>
        <Dialog open={dialog} title="Confirm changes" size="sm" onCancel={() => setDialog(false)} footer={<Button onClick={() => setDialog(false)}>Cancel</Button>}>
          <p>Review your changes.</p><Field label="Name" error="Enter a name"><input /></Field>
        </Dialog>
        <Dialog open={false} forceRender title="Closed confirmation" onCancel={() => select('Closed dialog canceled')} footer={null} />
        <Button onClick={() => setDescription(value => !value)}>Toggle row description</Button>
        <ListRow title="Synthetic row" icon={<Icon name="plug" size={20}/>} description={description ? 'A short description' : undefined} onOpen={() => setDrawer(true)} actions={<Menu label="Row actions" trigger={<Button>Row actions</Button>} items={[{id:'row-copy', label:'Copy row', onSelect:() => select('Row copied')}]} />}/>
        <div id="picker-scroll-frame" style={{height:120, overflow:'auto', overflowAnchor:'none'}}><div style={{height:16}}/><label htmlFor="synthetic-choice">Synthetic selection<select ref={choice} id="synthetic-choice"><option value="alpha">Alpha</option><option value="beta">Beta</option></select></label><div style={{height:160}}/></div>
        <div style={{width:'min(350px, calc(100vw - 64px))'}}><Tabs aria-label="Synthetic pages" items={['Plugins', 'Skills', 'Connections (MCP)', 'To review', 'Marketplace'].map(key => ({key, label:key, children:<p>{key} content</p>}))}/></div>
      </main>
    }
    createAntdRoot(document.getElementById('fixture')).render(<Fixture />)
  `,
    },
    bundle: true,
    write: false,
    jsx: 'automatic',
    format: 'iife',
    plugins: [tabsAria],
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
  await trigger.hover()
  await trigger.focus()
  await expect(page.getByRole('tooltip', { name: 'More', exact: true })).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Copy' })).toBeFocused()
  await page.keyboard.press('d')
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  // The pending hover hint must not cover an expanded menu.
  await page.waitForTimeout(600)
  await expect(page.getByRole('tooltip', { name: 'More', exact: true })).toBeHidden()
  await page.getByRole('menuitem', { name: 'Copy' }).click()
  await expect(page.getByRole('status')).toHaveText('Copied')
  await expect(trigger).toBeFocused()
  const row = page.locator('.agh-list-row')
  await expect(row).toHaveCSS('min-height', '56px')
  const rowBounds = await row.boundingBox()
  if (!rowBounds) throw new Error('List row is missing')
  for (const child of [row.locator('h3'), row.locator('p'), row.locator('.agh-list-row-actions')]) {
    const bounds = await child.boundingBox()
    if (!bounds) throw new Error('List row content is missing')
    expect(bounds.y).toBeGreaterThanOrEqual(rowBounds.y)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(rowBounds.y + rowBounds.height)
  }
  await page.getByRole('button', { name: 'Toggle row description', exact: true }).click()
  await expect(row).toHaveCSS('height', '56px')
  await page.getByRole('button', { name: 'Toggle row description', exact: true }).click()
  await page.locator('.agh-list-row p').click()
  await expect(page.getByRole('dialog', { name: 'Details', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Synthetic row', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Row actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Copy row', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Row copied')
  await expect(page.getByRole('dialog', { name: 'Details', exact: true })).toBeHidden()
  // Deliver a real pre-open scroll after a layout shift, then select through the live popup.
  await page.evaluate(async () => {
    const frame = document.getElementById('picker-scroll-frame')!
    frame.scrollTop = 8
    document.getElementById('synthetic-choice-trigger')!.click()
    frame.style.paddingTop = '24px'
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  await expect(page.locator('#synthetic-choice-trigger')).toHaveAttribute('aria-expanded', 'true')
  const jitter = await page.locator('#picker-scroll-frame').evaluate((frame) => {
    const trigger = document.getElementById('synthetic-choice-trigger')
    if (!trigger) throw new Error('Synthetic picker trigger is missing')
    const label = trigger.closest('label')
    if (!label) throw new Error('Synthetic picker label is missing')
    const before = trigger.getBoundingClientRect().top
    label.style.position = 'relative'
    label.style.top = '0.390625px'
    frame.dispatchEvent(new Event('scroll'))
    return trigger.getBoundingClientRect().top - before
  })
  expect(jitter).toBeGreaterThan(0)
  expect(jitter).toBeLessThan(1)
  await expect(page.locator('#synthetic-choice-trigger')).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('option', { name: 'Beta', exact: true }).click()
  await expect(page.locator('#synthetic-choice')).toHaveValue('beta')
  await page.locator('#synthetic-choice-trigger').click()
  await page.locator('#picker-scroll-frame').evaluate((frame) => {
    frame.scrollTop = 0
  })
  await expect(page.locator('#synthetic-choice-trigger')).toHaveAttribute('aria-expanded', 'false')
  await settled(page)
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(scan.violations).toEqual([])
})
test('native drawer is modal, closes on Escape and restores focus', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const trigger = page.getByRole('button', { name: 'Open details' })
  await trigger.click()
  const drawer = page.getByRole('dialog', { name: 'Details' })
  await expect(drawer).toBeVisible()
  await expect(drawer).toHaveCSS('width', '480px')
  await expect(drawer.getByRole('textbox', { name: 'Name' })).toBeVisible()
  await drawer.getByRole('textbox', { name: 'Name' }).dispatchEvent('compositionend')
  await drawer
    .getByRole('textbox', { name: 'Name' })
    .dispatchEvent('keydown', { key: 'Escape', isComposing: false })
  await expect(page.getByRole('status')).toHaveText('')
  const nestedTrigger = drawer.getByRole('button', { name: 'Open nested confirmation', exact: true })
  await nestedTrigger.click()
  const dialog = page.getByRole('dialog', { name: 'Nested confirmation', exact: true })
  await expect(dialog).toBeVisible()
  const menu = dialog.getByRole('button', { name: 'Nested menu', exact: true })
  await menu.dispatchEvent('keydown', { key: 'Escape', isComposing: true })
  await expect(dialog).toBeVisible()
  await menu.dispatchEvent('compositionend')
  await menu.dispatchEvent('keydown', { key: 'Escape', isComposing: false })
  await expect(page.getByRole('status')).toHaveText('')
  await dialog.getByRole('button', { name: 'Lock nested Escape', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(drawer).toBeVisible()
  await dialog.getByRole('button', { name: 'Unlock nested Escape', exact: true }).click()
  await menu.click()
  await expect(dialog.getByRole('menuitem', { name: 'Show notification', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'Nested actions', exact: true })).toBeHidden()
  await expect(menu).toBeFocused()
  await expect(dialog).toBeVisible()
  await expect(drawer).toBeVisible()
  await menu.click()
  await expect(dialog.getByRole('menuitem', { name: 'Show notification', exact: true })).toBeFocused()
  await dialog.getByRole('menuitem', { name: 'Show notification', exact: true }).click()
  const notice = dialog.getByRole('status').filter({ hasText: 'Nested notification' })
  await expect(notice).toBeVisible()
  await keyboardFocus(page, dialog.getByRole('button', { name: 'Explain nested action', exact: true }))
  await expect(dialog.getByRole('tooltip').filter({ hasText: 'Explain nested action' })).toBeVisible()
  await settled(page)
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(scan.violations).toEqual([])
  // Open the menu again while the notification remains in the same modal scope.
  await menu.focus()
  await menu.click()
  await expect(dialog.getByRole('menuitem', { name: 'Show notification', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(notice).toBeVisible()
  await expect(dialog).toBeVisible()
  await expect(menu).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(notice).toBeHidden()
  await expect(drawer).toBeVisible()
  await expect(nestedTrigger).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(trigger).toBeFocused()
  expect(errors).toEqual([])
})
test('narrow icon hit area, focus tooltip and draggable bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const tabTargets = () =>
    page.locator('.agnes-ui-tabs .ant-tabs-tab').evaluateAll((tabs) =>
      tabs.map((tab) => {
        const clip = tab.closest('.ant-tabs-nav-wrap')?.getBoundingClientRect()
        const rect = tab.getBoundingClientRect()
        const fits =
          !!clip &&
          rect.left >= clip.left - 1 &&
          rect.right <= clip.right + 1 &&
          rect.width >= 43.5 &&
          rect.height >= 43.5
        return (
          fits || {
            label: tab.textContent,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
            clip: clip && [clip.left, clip.right],
          }
        )
      }),
    )
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expect
      .poll(tabTargets, { message: 'Five real page labels retain visible 44px targets on phones' })
      .toEqual(Array(5).fill(true))
  }

  const icon = page.getByRole('button', { name: 'Refresh', exact: true })
  await expect(icon).toHaveCSS('width', '28px')
  await expect(icon).toHaveCSS('height', '28px')
  await keyboardFocus(page, icon)
  await expect(page.getByRole('tooltip', { name: 'Refresh', exact: true })).toHaveText('Refresh')
  await expect(page.getByRole('tooltip', { name: 'Refresh', exact: true })).toHaveCSS(
    'pointer-events',
    'none',
  )
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 })
    for (const edge of ['left', 'right'] as const) {
      await icon.blur()
      await expect(page.getByRole('tooltip', { name: 'Refresh', exact: true })).toBeHidden()
      await icon.evaluate((node, edge) => {
        const anchor = node.closest<HTMLElement>('.agh-tooltip-anchor')!
        anchor.style.cssText = `position:fixed;top:12px;${edge}:4px`
      }, edge)
      await keyboardFocus(page, icon)
      await expect(page.getByRole('tooltip', { name: 'Refresh', exact: true })).toBeVisible()
      await settled(page)
      const bounds = await page.getByRole('tooltip', { name: 'Refresh', exact: true }).boundingBox()
      if (!bounds) throw new Error('The focused icon must show its explanation')
      expect(bounds.x).toBeGreaterThanOrEqual(-1)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1)
      const control = await icon.boundingBox()
      if (!control) throw new Error('The focused action must remain visible')
      const overlapX =
        Math.min(bounds.x + bounds.width, control.x + control.width) - Math.max(bounds.x, control.x)
      const overlapY =
        Math.min(bounds.y + bounds.height, control.y + control.height) - Math.max(bounds.y, control.y)
      expect(
        Math.min(overlapX, overlapY),
        'The tooltip must leave its action unobstructed',
      ).toBeLessThanOrEqual(1)
    }
  }
  await icon.blur()
  await icon.evaluate((node) => node.closest<HTMLElement>('.agh-tooltip-anchor')!.removeAttribute('style'))
  await page.setViewportSize({ width: 390, height: 844 })
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
        outfile: 'sidebar-fixture.js',
        format: 'iife',
      })
      await page.setViewportSize({ width, height: 900 })
      await page.setContent(`<html class="${theme === 'dark' ? 'dark' : ''}"><head><style>${css}</style></head>
        <body data-agnes-region="app" class="sidebar-open"><aside class="sidebar"><nav id="sessions"></nav></aside><main></main></body></html>`)
      const script = result.outputFiles.find((file) => file.path.endsWith('.js'))
      const styles = result.outputFiles.find((file) => file.path.endsWith('.css'))
      if (!script || !styles) throw new Error('Sidebar fixture must bundle its script and vendor styles')
      await page.addStyleTag({ content: inCssLayer(styles.text, 'vendor') })
      await page.addScriptTag({ content: script.text })
      // The Projects section sits above the medium-weight project heading and regular session row.
      const heading = page.locator('.workspace-group .workspace-heading'),
        session = page.locator('.session')
      await expect(session).toHaveAttribute('aria-current', 'page')
      for (const [locator, weight] of [
        [heading, '500'],
        [session, '400'],
      ] as const) {
        expect(
          await locator.evaluate((node) => {
            const style = getComputedStyle(node)
            return { justify: style.justifyContent, weight: style.fontWeight, border: style.borderColor }
          }),
        ).toEqual({ justify: 'flex-start', weight, border: 'rgba(0, 0, 0, 0)' })
        await locator.focus()
        expect(await locator.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('solid')
      }
      // The guide line and its parent indent now establish hierarchy; row padding is shared.
      expect((await session.boundingBox())!.x).toBeGreaterThan((await heading.boundingBox())!.x)
      expect(
        await page.locator('.session-row').evaluate((node) => getComputedStyle(node).backgroundColor),
      ).not.toBe('rgba(0, 0, 0, 0)')
      const sidebar = (await page.locator('.sidebar').boundingBox())!
      for (const selector of [
        '.sidebar-section > .workspace-heading-row',
        '.workspace-group .workspace-heading-row',
        '.session-row',
        '.workspace-new-session',
        '.session-menu-trigger',
      ]) {
        // Desktop actions have a zero-width clipped container until their owning row is hovered.
        if (selector === '.workspace-new-session')
          await page.locator('.workspace-group .workspace-heading-row').hover()
        if (selector === '.session-menu-trigger') await page.locator('.session-row').hover()
        const box = (await page.locator(selector).boundingBox())!
        expect(box.x, selector).toBeGreaterThanOrEqual(sidebar.x)
        expect(box.x + box.width, selector).toBeLessThanOrEqual(sidebar.x + sidebar.width)
        if (selector === '.workspace-new-session') {
          const name = (await page.locator('.workspace-group .workspace-name').boundingBox())!
          const actions = (await page.locator('.workspace-row-actions').boundingBox())!
          expect(name.x + name.width).toBeLessThanOrEqual(actions.x)
        }
      }
      for (const selector of ['.workspace-group .workspace-name', '.session-title']) {
        expect(
          await page.locator(selector).evaluate((node) => {
            const label = node.querySelector('.navigation-label-start') ?? node
            return {
              ellipsis: getComputedStyle(label).textOverflow,
              nowrap: getComputedStyle(label).whiteSpace,
              clipped: label.scrollWidth > label.clientWidth,
            }
          }),
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
