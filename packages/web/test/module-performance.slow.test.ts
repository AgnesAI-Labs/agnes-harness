import { writeFile } from 'node:fs/promises'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@agnes/cordis'
import {
  AgnesClientService,
  CommandService,
  SessionService,
  SlotRegistry,
  ThemeService,
} from '@agnes/web-client'
import { expect, it } from 'vitest'
import { createReconciler, type ReadyClientModule } from '../src/client-modules/reconcile.js'
import { zhLocaleService } from './helpers/locale.js'

// Opt-in, serial, synthetic delays through the real lifecycle. No assets, home or daemon.
it.skipIf(!process.env.AGH_WEB_MODULE_PERFORMANCE_OUTPUT)(
  'records single-module script/style prepare latency',
  async () => {
    const samples: Record<string, number>[] = []
    for (let sample = 1; sample <= 3; sample++) {
      const ctx = new Context()
      await ctx.plugin(SlotRegistry)
      new AgnesClientService(ctx, { sessions: { get: () => undefined } } as never)
      new CommandService(ctx, async () => true)
      new SessionService(ctx)
      new ThemeService(ctx, 'light')
      zhLocaleService(ctx)
      const target: ReadyClientModule = {
        packageId: 'synthetic-panel',
        revision: 'v1',
        entryUrl: '/synthetic/panel.js',
        styleUrls: ['/synthetic/panel.css'],
        slots: [],
        extIds: [],
      }
      const times: Record<string, number> = {}
      let active = false
      let inFlight = 0
      let peakInFlight = 0
      let peakRss = process.memoryUsage().rss
      const prepare = async (kind: string, ms: number) => {
        times[`${kind}Start`] = performance.now()
        peakInFlight = Math.max(peakInFlight, ++inFlight)
        peakRss = Math.max(peakRss, process.memoryUsage().rss)
        await delay(ms)
        inFlight--
        times[`${kind}End`] = performance.now()
      }
      const reconciler = createReconciler({
        ctx,
        source: { list: async () => ({ revision: 'v1', modules: [target], statuses: [] }) },
        importer: async () => {
          await prepare('script', 120)
          return { inject: [], apply() {} }
        },
        prepareStyles: async () => {
          await prepare('style', 80)
          return {
            activate() {
              active = true
            },
            dispose() {
              active = false
            },
          }
        },
      })
      const lag = monitorEventLoopDelay({ resolution: 1 })
      lag.enable()
      await delay(0)
      const cpu = process.cpuUsage()
      const start = performance.now()
      try {
        await reconciler.reconcileNow()
        const prepareMs = performance.now() - start
        const used = process.cpuUsage(cpu)
        lag.disable()
        expect(reconciler.snapshot().get(target.packageId)?.phase).toBe('active')
        expect(active).toBe(true)
        expect(inFlight).toBe(0)
        samples.push({
          sample,
          scriptDelayMs: 120,
          styleDelayMs: 80,
          prepareMs,
          peakInFlight,
          cpuMs: (used.user + used.system) / 1000,
          peakRssMiB: Math.max(peakRss, process.memoryUsage().rss) / 1024 ** 2,
          maxEventLoopLagMs: lag.max / 1e6,
          ...Object.fromEntries(Object.entries(times).map(([key, time]) => [key, time - start])),
        })
      } finally {
        lag.disable()
        await ctx.fiber.dispose()
      }
    }
    await writeFile(process.env.AGH_WEB_MODULE_PERFORMANCE_OUTPUT ?? '', JSON.stringify(samples, null, 2))
  },
)
