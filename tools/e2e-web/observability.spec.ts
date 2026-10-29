import { memoryCollector } from '@agnes/observability/testkit'
import { expect, test } from './fixtures.js'
import { accessible, translated } from './quality.js'
import { chooseWorkspace, expand, preferences, section, settings } from './ui.js'

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
      await expand(page.getByTestId('otlp-settings'))
      await expect(page.getByTestId('otlp-endpoint')).toBeEnabled()
      await page.getByTestId('otlp-endpoint').fill(collector.endpoint)
      await page.getByTestId('otlp-endpoint').blur()
      const enabled = page.getByTestId('otlp-enabled')
      if ((await enabled.getAttribute('aria-checked')) !== 'true') await enabled.click()
      await expect(enabled).toBeChecked()
      await page.locator('input[name="otlp-redaction"][value="content"]').click()
      await expect(page.getByTestId('otlp-privacy')).toBeVisible()
      await page.locator('input[name="otlp-redaction"][value="metadata"]').click()
      // The current editor accepts environment references, never raw header secrets.
      await page.getByTestId('otlp-header-name').fill('authorization')
      await page.getByTestId('otlp-header-env').fill('synthetic-plaintext')
      await page.getByTestId('otlp-header-add').click()
      await expect(page.getByTestId('otlp-header-env')).toHaveAttribute('aria-invalid', 'true')
      await expect(page.getByRole('alert')).not.toContainText('synthetic-plaintext')
      await expect(page.getByTestId('otlp-header')).toHaveCount(0)
      await page.getByTestId('otlp-header-env').fill('SYNTHETIC_OTLP_TOKEN')
      await page.getByTestId('otlp-header-add').click()
      await expect(page.getByTestId('otlp-header')).toContainText('env:SYNTHETIC_OTLP_TOKEN')
      await page.getByTestId('otlp-header').getByRole('button').click()
      await expect(page.getByTestId('otlp-header')).toHaveCount(0)
      const client = await runtime.connect()
      await expect
        .poll(async () => (await client.request('_agnes/v1/admin.observability', {})).settings)
        .toMatchObject({ enabled: true, endpoint: collector.endpoint, redaction: 'metadata', headers: {} })
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
    await chooseWorkspace(page, runtime, 'zh-CN')
    await settings(page, 'zh-CN')
    await section(page, 'diagnostics')
    await expand(page.getByTestId('otlp-settings'))
    await expect(page.getByTestId('otlp-enabled')).toBeChecked()
    await expect(page.getByTestId('otlp-endpoint')).toHaveValue(collector.endpoint)
  } finally {
    await collector.close()
  }
})
