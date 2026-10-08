import { test as base, expect } from '@playwright/test'
import { isolatedRuntime, type Runtime } from './runtime.js'

export const test = base.extend<{ runtime: Runtime; browserHealth: undefined }>({
  runtime: async ({ page }, use, info) => {
    const runtime = await isolatedRuntime()
    try {
      await runtime.start()
      // UI specs own their navigation and screen assertions; SDK flows do not boot a second client.
      await use(runtime)
    } finally {
      try {
        try {
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
    async ({ page, context }, use, info) => {
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
      expect(errors, 'All console errors, page errors and external requests fail the gate').toEqual([])
    },
    { auto: true },
  ],
})
export { expect }
