import { readFile } from 'node:fs/promises'
import { validateAgainst } from '@agnes/protocol'
import { DiagnosticsExportResult } from '@agnes/protocol/gen/agnes-v1'
import { expect, test } from './fixtures.js'
import { accessible, screen, translated } from './quality.js'
import { chooseWorkspace, preferences, section, settings } from './ui.js'

for (const locale of ['en', 'zh-CN'])
  for (const theme of ['light', 'dark'])
    test(`diagnostics error lookup and redacted download ${locale}/${theme}`, async ({
      page,
      runtime,
    }, info) => {
      const payloadMarker = ['synthetic', 'private-diagnostics-body'].join('-')
      const client = await runtime.connect()
      let diagnosticId = ''
      try {
        await client.call('synthetic/diagnostics-failure', { password: payloadMarker })
      } catch (error) {
        diagnosticId = (error as { data?: { diagnosticId?: string } }).data?.diagnosticId ?? ''
      }
      expect(diagnosticId).toMatch(/^[a-f0-9-]{36}$/)
      await preferences(page, locale, theme)
      await page.goto(runtime.url)
      await chooseWorkspace(page, runtime, locale)
      await settings(page, locale)
      await section(page, 'diagnostics')
      await expect(page.getByTestId('settings-refresh')).toBeHidden()
      const close = page.locator('#config-close')
      await expect(close).toBeVisible()
      const diagnosticIcon = page.getByTestId('settings-nav-diagnostics').locator('svg')
      const toolsIcon = page.getByTestId('settings-nav-security').locator('svg')
      const diagnosticPaths = await diagnosticIcon.evaluateAll((paths) => paths.map((icon) => icon.innerHTML))
      const toolsPaths = await toolsIcon.evaluateAll((paths) => paths.map((icon) => icon.innerHTML))
      expect(diagnosticPaths.length).toBeGreaterThan(0)
      expect(toolsPaths.length).toBeGreaterThan(0)
      expect(diagnosticPaths).not.toEqual(toolsPaths)
      // The page holds one entry row; the errors are a subpage, each error another.
      const entry = page.getByTestId('diagnostics-errors-row')
      await expect(entry).toBeVisible()
      await expect(page.getByTestId('diagnostics-error')).toHaveCount(0)
      const doctor = page.getByTestId('diagnostics-doctor')
      await expect(doctor).toHaveAttribute('aria-busy', 'false')
      await expect(doctor.locator('li[data-testid^="doctor-check-"]')).toHaveCount(12)
      await entry.click()
      await expect(page.getByTestId('diagnostics-errors')).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByTestId('diagnostics-error').first()).toBeVisible()
      // The search sits in the list page's header and is submitted with Enter.
      await page.getByTestId('diagnostics-query').fill(diagnosticId)
      await page.getByTestId('diagnostics-query').press('Enter')
      // A found error opens on its own page, on its ID and code.
      await expect(page.getByTestId('diagnostics-error-id')).toHaveText(diagnosticId)
      await expect(page.getByTestId('diagnostics-error-code')).toHaveText('-32601')
      // Back, the list holds only that error; the export then holds only that error.
      await page.getByTestId('settings-subpage-back').click()
      await expect(page.getByTestId('diagnostics-error')).toHaveCount(1)
      await expect(page.getByTestId('diagnostics-found')).toBeVisible()
      const fieldColor = await page
        .getByTestId('diagnostics-query')
        .evaluate((input) => getComputedStyle(input).backgroundColor)
      const surfaceColor = await page.getByTestId('diagnostics-query').evaluate((input) => {
        const probe = document.createElement('div')
        probe.style.background = 'var(--agnes-input-surface)'
        input.parentElement?.appendChild(probe)
        const color = getComputedStyle(probe).backgroundColor
        probe.remove()
        return color
      })
      expect(fieldColor).toBe(surfaceColor)
      await page.getByTestId('settings-subpage-back').click()
      const pending = page.waitForEvent('download')
      await page.getByTestId('diagnostics-export').click()
      await expect(page.getByTestId('diagnostics-export-details')).toBeVisible()
      await page.getByTestId('diagnostics-export-confirm').click()
      const download = await pending
      expect(download.suggestedFilename()).toBe('agh-diagnostics.json')
      const path = await download.path()
      if (!path) throw new Error('Missing diagnostic download')
      const text = await readFile(path, 'utf8')
      const bundle = JSON.parse(text)
      expect(validateAgainst(DiagnosticsExportResult, bundle).ok).toBe(true)
      expect(bundle.errors).toHaveLength(1)
      expect(bundle.errors[0].diagnosticId).toBe(diagnosticId)
      expect(bundle.telemetry).toEqual({ enabled: false, includeContent: false, endpointHosts: [] })
      for (const privateValue of [payloadMarker, runtime.home, runtime.workspace])
        expect(text).not.toContain(privateValue)
      await entry.click()
      await expect(page.getByTestId('diagnostics-errors')).toHaveAttribute('aria-busy', 'false')
      await page.getByTestId('diagnostics-query').fill('')
      await page.getByTestId('diagnostics-query').press('Enter')
      await expect(page.getByTestId('diagnostics-error').first()).toBeVisible()
      await expect(page.locator('.agh-toast')).toHaveCount(0)
      await translated(page)
      await accessible(page, info, 'diagnostics')
      await screen(page, info, `diagnostics-${locale}-${theme}`, [
        page.getByTestId('diagnostics-error-time'),
        page.getByTestId('diagnostics-day'),
      ])
      await page.getByTestId('settings-subpage-back').click()
      await expect(doctor).toContainText(
        locale === 'zh-CN' ? '当前没有运行中的后台工作进程' : 'No background worker is currently running',
      )
      await doctor.scrollIntoViewIfNeeded()
      await screen(page, info, `diagnostics-status-${locale}-${theme}`)
      await page.getByTestId('diagnostics-doctor-run').click()
      await expect(doctor).toHaveAttribute('aria-busy', 'false')
      await expect(doctor.locator('li[data-testid^="doctor-check-"]')).toHaveCount(12)
      await translated(page)
      if (locale === 'zh-CN' && theme === 'light') {
        await section(page, 'models')
        // Runtime sections now own their reads; the shared manual-refresh action is retired.
        await expect(page.getByTestId('settings-refresh')).toBeHidden()
        for (const id of ['bundles', 'providers']) {
          await section(page, id)
          await expect(page.getByTestId('settings-refresh')).toBeHidden()
          await expect(
            page.getByTestId(id === 'bundles' ? 'bundles-panel' : 'settings-subsection-provider-types'),
          ).toBeVisible()
          // A subpage shows its group title and its own title; neither may run under the close button.
          const exit = await close.boundingBox()
          for (const title of await page.locator('#config h2:visible').all()) {
            // The text, not the block that holds it, must end before the close button.
            const right = await title.evaluate((node) => {
              const range = document.createRange()
              range.selectNodeContents(node)
              return range.getBoundingClientRect().right
            })
            expect(exit && right <= exit.x).toBe(true)
          }
        }
        await section(page, 'security')
        // Permissions load their own data rather than the shared runtime catalog.
        await expect(page.getByTestId('settings-refresh')).toBeHidden()
      }
    })
