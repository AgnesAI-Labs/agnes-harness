import { test as base, expect } from '@playwright/test'
import { isolatedRuntime, type Runtime } from './runtime.js'

export const test = base.extend<{ runtime: Runtime; browserHealth: undefined }>({
  runtime: async ({ page }, use, info) => {
    const runtime = await isolatedRuntime()
    try {
      await runtime.start()
      // Startup artifact only. Phase 1 never clicks or asserts page-level UI behavior.
      await page.goto(runtime.url)
      await page.screenshot({ path: info.outputPath('startup.png'), animations: 'disabled' })
      await page.goto('about:blank')
      await use(runtime)
    } finally {
      try {
        await info.attach('daemon-audit.jsonl', {
          body: await runtime.diagnostics(),
          contentType: 'text/plain',
        })
      } finally {
        try {
          await runtime.dispose()
        } finally {
          await info.attach('serve.log', { body: runtime.logs(), contentType: 'text/plain' })
        }
      }
    }
  },
  browserHealth: [
    async ({ page, context }, use, info) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`)
      })
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
          errors.push(`External request refused: ${url.origin}`)
          await route.abort('blockedbyclient')
        } else await route.continue()
      })
      await use(undefined)
      await info.attach('browser-errors.json', {
        body: JSON.stringify(errors, null, 2),
        contentType: 'application/json',
      })
      expect(errors, 'All console errors, page errors and external requests fail the gate').toEqual([])
    },
    { auto: true },
  ],
})
export { expect }
