import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'
import { accessible, settled, translated } from './quality.js'
import { toolResult } from './sdk.js'
import { chooseWorkspace, fresh, turn } from './ui.js'

test('workspace dock previews and mentions a file that the agent reads', async ({ page, runtime }, info) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => {
    if (location.protocol !== 'http:') return
    if (!localStorage.getItem('agnes-locale')) localStorage.setItem('agnes-locale', 'en')
    if (!localStorage.getItem('agnes-theme')) localStorage.setItem('agnes-theme', 'light')
  })
  await page.goto(runtime.url)
  await chooseWorkspace(page, runtime)
  await fresh(page)
  const composer = page.getByRole('textbox', { name: 'Task content', exact: true })
  await composer.fill('Create a session for workspace review')
  await composer.press('Enter')
  await expect(page).toHaveURL(/session=/, { timeout: 40_000 })
  await expect(page.getByTestId('conversation-turn').last()).toHaveAttribute('data-status', 'completed', {
    timeout: 30_000,
  })
  await page.getByTestId('workbench-right-toggle').click()
  const files = page.getByTestId('files-panel')
  await files.locator('[data-path="report.md"]').click()
  await expect(page.getByTestId('file-preview')).toContainText('Synthetic delivery')
  await page.getByTestId('file-mention').click()
  await expect(page.getByRole('textbox', { name: 'Task content', exact: true })).toHaveValue('"report.md"')
  await turn(page, 'call read {"path":"report.md"}')
  const client = await runtime.connect()
  const id = new URL(page.url()).searchParams.get('session')
  if (!id) throw new Error('The session URL must identify the workspace session')
  const session = await client.session.load(id, { cwd: runtime.workspace })
  expect(JSON.stringify(await toolResult(session, 'read'))).toContain('Synthetic delivery')
  await translated(page)
  await accessible(page, info, 'workspace-files')
  const folder = process.env.AGH_WORKBENCH_REPORT
  if (folder) {
    await mkdir(folder, { recursive: true })
    for (const locale of ['en', 'zh-CN'])
      for (const theme of ['light', 'dark'])
        for (const width of [1440, 1280]) {
          await page.setViewportSize({ width, height: 900 })
          await page.evaluate(
            ({ locale, theme }) => {
              localStorage.setItem('agnes-locale', locale)
              localStorage.setItem('agnes-theme', theme)
            },
            { locale, theme },
          )
          await page.reload()
          await expect(page.getByTestId('files-panel')).toBeVisible()
          await page.getByTestId('workspace-file').filter({ hasText: 'report.md' }).click()
          await expect(page.getByTestId('file-preview')).toContainText('Synthetic delivery')
          await settled(page)
          const geometry = await page.evaluate(() => {
            const rect = (selector: string) => {
              const element = document.querySelector(selector)
              if (!element) throw new Error(`Missing layout surface: ${selector}`)
              return element.getBoundingClientRect().toJSON() as {
                left: number
                right: number
                height: number
              }
            }
            return {
              dock: rect('#workbench-right'),
              composer: rect('#composer'),
              conversation: rect('#conversation-shell'),
              tree: rect('.workbench-tree-scroll'),
              preview: rect('.workbench-file-preview'),
              entry: rect('[data-path="report.md"]'),
              name: rect('[data-path="report.md"] .workbench-file-name'),
            }
          })
          expect(geometry.composer.right).toBeLessThanOrEqual(geometry.dock.left)
          expect(geometry.conversation.right).toBeLessThanOrEqual(geometry.dock.left)
          expect(geometry.name.left - geometry.entry.left).toBeLessThan(50)
          expect(geometry.preview.height).toBeGreaterThan(geometry.tree.height)
          await expect(page.locator('.workbench-dock-heading button[aria-busy]')).toBeVisible()
          await expect(page.locator('.workbench-files-footer details')).toBeVisible()
          await expect(page.locator('.workbench-file-preview summary')).not.toContainText(/T\d{2}:/)
          await page.screenshot({ path: join(folder, `p1-${locale}-${theme}-${width}-after.png`) })
          await page.getByTestId('workbench-right-toggle').click()
          await page.screenshot({ path: join(folder, `p1-${locale}-${theme}-${width}-before.png`) })
          await page.getByTestId('workbench-right-toggle').click()
        }
  }
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(files).toBeVisible()
  await page.getByTestId('workbench-tab-files').press('Escape')
  await expect(files).toBeHidden()
  await expect(page.getByTestId('workbench-right-toggle')).toBeFocused()
})
