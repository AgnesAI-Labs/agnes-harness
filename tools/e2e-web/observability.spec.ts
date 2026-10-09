import { memoryCollector } from '@agnes/observability/testkit'
import { expect, test } from './fixtures.js'
import { accessible, translated } from './quality.js'
import { chooseWorkspace, preferences, section, settings } from './ui.js'

test('OTLP settings save and collector connection test in both languages', async ({
  page,
  runtime,
}, info) => {
  const collector = await memoryCollector()
  try {
    for (const locale of ['en', 'zh-CN']) {
      await preferences(page, locale, 'light')
      await page.goto(runtime.url)
      await chooseWorkspace(page, runtime, locale)
      await settings(page, locale)
      await section(page, 'diagnostics')
      const card = page.getByTestId('otlp-settings')
      await expect(card).toHaveAttribute('aria-busy', 'false')
      await page.getByTestId('otlp-endpoint').fill(collector.endpoint)
      await page.getByTestId('otlp-enabled').selectOption('on')
      await page.getByTestId('otlp-redaction').selectOption('content')
      await expect(page.getByTestId('otlp-privacy')).toBeVisible()
      await page.getByTestId('otlp-redaction').selectOption('metadata')
      await page.getByTestId('otlp-save').click()
      await expect(page.getByTestId('otlp-notice')).toContainText(
        locale === 'en' ? 'Settings saved' : '设置已保存',
      )
      await page.getByTestId('otlp-test').click()
      await expect(page.getByTestId('otlp-notice')).toContainText(locale === 'en' ? 'accepted' : '已接受')
      expect(collector.requests.map((row) => row.path)).toEqual(
        expect.arrayContaining(['/v1/logs', '/v1/traces', '/v1/metrics']),
      )
      await expect(page.getByTestId('otlp-drops')).toContainText('0')
      collector.refuse(503)
      await page.getByTestId('otlp-test').click()
      await expect(page.getByTestId('otlp-notice')).toContainText(locale === 'en' ? 'failed' : '失败')
      collector.refuse(200)
      await translated(page)
      await accessible(page, info, `otlp-${locale}`)
      await page.locator('#config-close').click()
    }
    await page.goto(runtime.url)
    await settings(page, 'zh-CN')
    await section(page, 'diagnostics')
    await expect(page.getByTestId('otlp-enabled')).toHaveValue('on')
    await expect(page.getByTestId('otlp-endpoint')).toHaveValue(collector.endpoint)
  } finally {
    await collector.close()
  }
})
