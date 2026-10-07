import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const packagePath = process.env.AGH_PLAYWRIGHT_PACKAGE
if (!packagePath) throw new Error('Run through pnpm test:web-smoke')
const { test, expect } = require(join(packagePath, 'test.js'))
const fixtureUrl = process.env.AGH_CONVERSATION_FIXTURE_URL
// The fixture mounts current production components with synthetic session/resource ports.
for (const locale of ['en', 'zh-CN'])
  for (const width of [1280, 375]) {
    test(`conversation cards (${locale}, ${width}px)`, async ({ page }) => {
      test.skip(!fixtureUrl, 'Start serve-conversation-fixture.mjs and set AGH_CONVERSATION_FIXTURE_URL.')
      if (!fixtureUrl) return
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${fixtureUrl}/?locale=${locale}`)
      for (const id of [
        'question-card',
        'deliverable-card',
        'background-job-card',
        'child-agent-card',
        'plan-approval-card',
      ])
        await expect(page.getByTestId(id)).toBeVisible()
      await expect(page.locator('.turn-process')).not.toHaveAttribute('open', '')
      await page.getByTestId('turn-process-toggle').click()
      await page.getByTestId('turn-process-toggle').click()
      await expect(page.getByTestId('question-card')).toBeVisible()
      const option = page.locator('[data-testid="question-option"][value="Web"]')
      expect((await option.boundingBox())?.width).toBeLessThan(24)
      await option.check()
      await page.getByTestId('question-free-text').fill('email')
      await page.getByTestId('question-submit').click()
      await expect(page.getByTestId('question-submit')).toBeDisabled()
      await expect(page.getByTestId('question-submit')).toHaveText(locale === 'en' ? 'Answered' : '已回答')
      await expect(page.getByTestId('deliverable-open')).toHaveAttribute('target', '_blank')
      const downloadEvent = page.waitForEvent('download')
      await page.getByTestId('deliverable-download').click()
      const download = await downloadEvent
      expect(download.suggestedFilename()).toBe('delivery-report.txt')
      for (const id of ['background-job-card', 'child-agent-card']) {
        const card = page.getByTestId(id)
        await card.getByTestId('tool-detail-toggle').click()
        await expect(card.getByTestId('tool-detail-text')).toContainText(
          id === 'background-job-card' ? 'job-fixture' : 'child-fixture',
        )
      }
      await page
        .getByTestId('plan-approval-card')
        .getByTestId('approval-action')
        .filter({ hasText: locale === 'en' ? 'Allow once' : '仅允许这次' })
        .click()
      await expect(page.getByTestId('fixture-plan-decision')).toHaveText('allow_once')
      await expect(page.getByTestId('plan-approval-card')).toBeHidden()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
      await page.reload()
      await page
        .getByTestId('plan-approval-card')
        .locator('[data-approval-action="live:reject_once"]')
        .click()
      await expect(page.getByTestId('fixture-plan-decision')).toHaveText('reject_once')
      expect(errors).toEqual([])
    })
  }
