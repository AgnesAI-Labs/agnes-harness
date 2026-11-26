import { test as base, expect, type Page } from '@playwright/test'
import { testCertificatePath } from './oauth-fixture.js'
import { isolatedRuntime, type Runtime } from './runtime.js'

/** All local surfaces mount directly in the top-level document; only Cloud B uses an isolated frame. */
export const root = base.extend<{
  runtime: Runtime
  runtimeSetup: NonNullable<Parameters<typeof isolatedRuntime>[1]> & {
    prepare?: (runtime: Runtime) => Promise<void>
  }
  browserHealth: undefined
  expectedBrowserErrors: string[]
}>({
  runtimeSetup: [{}, { option: true }],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright inspects the destructured fixture dependencies.
  expectedBrowserErrors: async ({}, use) => {
    await use([])
  },
  runtime: async ({ page, screenshot, runtimeSetup }, use, info) => {
    const { prepare, ...options } = runtimeSetup
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
        ...options,
      },
    )
    try {
      await prepare?.(runtime)
      await runtime.start()
      // UI specs own their navigation and screen assertions; SDK flows do not boot a second client.
      await use({
        ...runtime,
        cli: async (args) => {
          if (args[0] === 'daemon' && args[1] === 'stop') info.setTimeout(Math.max(info.timeout, 120_000))
          return runtime.cli(args)
        },
        restart: async (entry) => {
          info.setTimeout(Math.max(info.timeout, 120_000))
          await runtime.restart(entry)
        },
      })
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
export const test = root
export { expect }
