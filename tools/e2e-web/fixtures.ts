import { test as base, expect, type Page } from '@playwright/test'
import { testCertificatePath } from './oauth-fixture.js'
import { isolatedRuntime, type Runtime } from './runtime.js'

/** Exercise the real workbench while locating the local application's DOM in its own frame. */
function applicationPage(page: Page): Page {
  const application = page.frameLocator('[data-testid="backend-frame-local"]')
  const dom = new Set([
    'locator',
    'getByRole',
    'getByTestId',
    'getByText',
    'getByLabel',
    'getByPlaceholder',
    'getByTitle',
    'getByAltText',
  ])
  let synthetic = false
  // bootstrap.ts renders the explicit recovery route in the outer document, including Back/Forward.
  const standalone = () => synthetic || new URL(page.url()).searchParams.has('admin')
  return new Proxy(page, {
    get(target, key, receiver) {
      if (typeof key === 'string' && dom.has(key))
        return (...args: unknown[]) => {
          const scope = standalone() ? target : application
          return Reflect.apply(Reflect.get(scope, key), scope, args)
        }
      if (key === 'evaluate')
        return async (...args: unknown[]) => {
          if (standalone()) return Reflect.apply(Reflect.get(target, key), target, args)
          const element = await target.getByTestId('backend-frame-local').elementHandle()
          try {
            const scope = await element?.contentFrame()
            if (!scope) throw new Error('The real local workbench frame is unavailable')
            return await Reflect.apply(Reflect.get(scope, key), scope, args)
          } finally {
            await element?.dispose()
          }
        }
      if (key === 'goto' || key === 'setContent')
        return (...args: unknown[]) => {
          synthetic = key === 'setContent'
          return Reflect.apply(Reflect.get(target, key), target, args)
        }
      // Navigation, URL, input, networking and screenshots still belong to the outer browser page.
      const value = Reflect.get(target, key, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Explicit outer-workbench cases own their frame locators and use the real browser Page. */
export const root = base.extend<{
  runtime: Runtime
  browserHealth: undefined
  expectedBrowserErrors: string[]
}>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright inspects the destructured fixture dependencies.
  expectedBrowserErrors: async ({}, use) => {
    await use([])
  },
  runtime: async ({ page, screenshot }, use, info) => {
    const runtime = await isolatedRuntime(
      info.title.startsWith('guided first run zh-CN') ? 'installed' : 'root',
      {
        localExamples: info.file.endsWith('/ui-gate.spec.ts'),
        ...(['/browser.spec.ts', '/browser-layout.spec.ts'].some((file) =>
          info.file.replaceAll('\\', '/').endsWith(file),
        ) && process.env.AGH_BROWSER_TEST_ARCHIVE
          ? { browserArchive: process.env.AGH_BROWSER_TEST_ARCHIVE }
          : {}),
        ...(info.file.replaceAll('\\', '/').endsWith('/mcp-oauth.spec.ts')
          ? { extraEnv: { NODE_EXTRA_CA_CERTS: testCertificatePath } }
          : {}),
        realModel:
          info.title.startsWith('application permission switch') ||
          (info.title.startsWith('agent launch sweep') && process.env.AGH_REAL_AGENT_SWEEP === '1'),
      },
    )
    try {
      await runtime.start()
      // UI specs own their navigation and screen assertions; SDK flows do not boot a second client.
      await use(runtime)
    } finally {
      try {
        try {
          if ((typeof screenshot === 'string' ? screenshot : screenshot.mode) !== 'off')
            await info.attach('final-screen.png', {
              body: await page.screenshot({ animations: 'disabled' }),
              contentType: 'image/png',
            })
        } finally {
          try {
            await page.close()
          } finally {
            await info.attach('runtime-diagnostics.json', {
              body: await runtime.diagnostics(),
              contentType: 'application/json',
            })
          }
        }
      } finally {
        try {
          await runtime.dispose()
        } finally {
          await info.attach('serve.log', { body: runtime.logs(), contentType: 'text/plain' })
          await info.attach('sdk-rpc-timing.json', {
            body: runtime.requests(),
            contentType: 'application/json',
          })
        }
      }
    }
  },
  browserHealth: [
    async ({ page, context, expectedBrowserErrors }, use, info) => {
      const errors: string[] = []
      const requests: { method: string; durationMs: number; code?: unknown }[] = []
      page.on('websocket', (socket) => {
        const pending = new Map<string | number, { method: string; started: number }>()
        socket.on('framesent', ({ payload }) => {
          if (typeof payload !== 'string') return
          const message = JSON.parse(payload) as { id?: string | number; method?: string }
          if (message.id !== undefined && message.method)
            pending.set(message.id, { method: message.method, started: performance.now() })
        })
        socket.on('framereceived', ({ payload }) => {
          if (typeof payload !== 'string') return
          const message = JSON.parse(payload) as {
            id?: string | number
            error?: { data?: { code?: unknown } }
          }
          if (message.id === undefined) return
          const request = pending.get(message.id)
          if (!request) return
          pending.delete(message.id)
          requests.push({
            method: request.method,
            durationMs: Math.round(performance.now() - request.started),
            ...(message.error ? { code: message.error.data?.code } : {}),
          })
        })
      })
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
      await info.attach('rpc-timing.json', {
        body: JSON.stringify(requests, null, 2),
        contentType: 'application/json',
      })
      expect(
        errors,
        'Only explicitly asserted negative-flow errors are expected; all other browser errors fail',
      ).toEqual(expectedBrowserErrors)
    },
    { auto: true },
  ],
})
export const test = root.extend({
  page: async ({ page }, use) => {
    await use(applicationPage(page))
  },
})
export { expect }
