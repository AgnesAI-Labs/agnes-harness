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
      await expect(page.getByTestId('settings-refresh')).toHaveCount(0)
      const close = page.locator('#config-close')
      await expect(close).toBeVisible()
      const diagnosticIcon = page.getByTestId('settings-nav-diagnostics').locator('path')
      const toolsIcon = page.getByTestId('settings-nav-search').locator('path')
      expect(await diagnosticIcon.getAttribute('d')).not.toBe(await toolsIcon.getAttribute('d'))
      const row = page.getByTestId('diagnostics-error').filter({ hasText: diagnosticId })
      await expect(row).toBeVisible()
      await expect(page.getByTestId('diagnostics-errors')).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByTestId('diagnostics-doctor').getByRole('article')).toHaveCount(11)
      await page.getByTestId('diagnostics-query').scrollIntoViewIfNeeded()
      await page.getByTestId('diagnostics-query').fill(diagnosticId)
      await page.getByTestId('diagnostics-search').click()
      await expect(page.getByTestId('diagnostics-errors')).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByTestId('diagnostics-error')).toHaveCount(1)
      await expect(page.getByTestId('diagnostics-error-code')).toBeHidden()
      const fieldColor = await page
        .getByTestId('diagnostics-query')
        .evaluate((input) => getComputedStyle(input).backgroundColor)
      const surfaceColor = await page.getByTestId('diagnostics-query').evaluate((input) => {
        const probe = document.createElement('div')
        probe.style.background = 'var(--agnes-bg-surface)'
        input.parentElement?.appendChild(probe)
        const color = getComputedStyle(probe).backgroundColor
        probe.remove()
        return color
      })
      expect(fieldColor).toBe(surfaceColor)
      const pending = page.waitForEvent('download')
      await page.getByTestId('diagnostics-export').click()
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
      await expect(page.getByTestId('diagnostics-errors')).toHaveAttribute('aria-busy', 'false')
      await page.getByTestId('diagnostics-query').scrollIntoViewIfNeeded()
      await page.getByTestId('diagnostics-query').fill('')
      await page.getByTestId('diagnostics-query').blur()
      await page.getByTestId('diagnostics-errors').evaluate((element) => {
        for (let parent = element.parentElement; parent; parent = parent.parentElement) parent.scrollTop = 0
      })
      await translated(page)
      await accessible(page, info, 'diagnostics')
      await screen(page, info, `diagnostics-${locale}-${theme}`, [
        page.getByTestId('diagnostics-error-id'),
        page.getByTestId('diagnostics-error-time'),
      ])
      await expect(page.getByTestId('diagnostics-runtime')).toContainText(
        locale === 'zh-CN' ? '当前无运行中的 Worker' : 'No Worker is currently running',
      )
      await page.getByTestId('diagnostics-runtime').scrollIntoViewIfNeeded()
      await screen(page, info, `diagnostics-status-${locale}-${theme}`)
      await page.getByTestId('diagnostics-doctor-run').click()
      await expect(page.getByTestId('diagnostics-doctor').getByRole('article')).toHaveCount(11)
      await translated(page)
      if (locale === 'zh-CN' && theme === 'light') {
        await section(page, 'models')
        // Session defaults owns its reads; it no longer consumes the generic runtime catalog.
        await expect(page.getByTestId('settings-refresh')).toHaveCount(0)
        for (const id of ['bundles', 'providers', 'security']) {
          await section(page, id)
          const button = page.getByTestId('settings-refresh')
          await expect(button).toBeVisible()
          const action = await button.boundingBox()
          const exit = await close.boundingBox()
          expect(action && exit && action.x + action.width <= exit.x).toBe(true)
        }
      }
    })
