import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { expect, it, vi } from 'vitest'
import type { WireEvent } from '../../src/adapter.js'
import { PiAdapter } from '../../src/adapters/pi/index.js'
import { estimateBilling, estimateCredits } from '../../src/usage.js'
import { modelFixture } from './model-fixture.js'

it.each([
  {
    api: 'openai-completions',
    failAfterUsage: false,
    legacyUsage: false,
    gatewayFees: false,
    rate: undefined,
  },
  { api: 'anthropic-messages', failAfterUsage: false, legacyUsage: false, gatewayFees: false, rate: 100 },
  { api: 'openai-completions', failAfterUsage: true, legacyUsage: false, gatewayFees: false, rate: 100 },
  { api: 'openai-completions', failAfterUsage: false, legacyUsage: true, gatewayFees: false, rate: 100 },
  { api: 'openai-completions', failAfterUsage: true, legacyUsage: true, gatewayFees: false, rate: undefined },
  { api: 'openai-completions', failAfterUsage: false, legacyUsage: true, gatewayFees: true, rate: 100 },
  { api: 'openai-completions', failAfterUsage: false, legacyUsage: false, gatewayFees: true, rate: 100 },
] as const)(
  'retains Pi HTTP usage for $api (failure=$failAfterUsage, legacy=$legacyUsage, typed gateway=$gatewayFees, rate=$rate)',
  async ({ api, failAfterUsage, legacyUsage, gatewayFees, rate }) => {
    const directory = mkdtempSync(join(tmpdir(), 'model-usage-wire-'))
    const requests = join(directory, 'requests.jsonl')
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/model-http.mjs', import.meta.url)), requests],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    )
    const originalStream = PiAdapter.prototype.stream
    const fault =
      failAfterUsage || gatewayFees
        ? vi.spyOn(PiAdapter.prototype, 'stream').mockImplementation(async function* (
            this: PiAdapter,
            route,
            request,
            options,
          ) {
            for await (const event of originalStream.call(this, route, request, options)) {
              if (gatewayFees && event.type === 'usage') {
                // Typed evidence tests codec refusal; the actual HTTP peer reports tokens, not charges.
                const reported: WireEvent = {
                  ...event,
                  billing: { usdMicros: 0, source: 'gateway', subscription: true },
                  credits: 0,
                  creditSource: 'gateway',
                }
                yield reported
              } else yield event
              if (failAfterUsage && event.type === 'usage')
                throw new Error('Stream failed after original HTTP usage')
            }
          })
        : undefined
    let fixture: Awaited<ReturnType<typeof modelFixture>> | undefined
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('HTTP fixture startup expired')), 10000)
        child.once('message', (message) => {
          clearTimeout(timer)
          if (
            !message ||
            typeof message !== 'object' ||
            !('port' in message) ||
            typeof message.port !== 'number'
          )
            reject(new Error('Invalid HTTP fixture port'))
          else resolve(message.port)
        })
        child.once('exit', () => {
          clearTimeout(timer)
          reject(new Error('HTTP fixture exited'))
        })
      })
      fixture = await modelFixture(
        api,
        `http://127.0.0.1:${port}/v1`,
        join(directory, 'effect.json'),
        {
          input: 2,
          output: 3,
          cacheRead: 1,
          cacheWrite: 4,
        },
        legacyUsage,
        rate,
      )
      const effect = await fixture.action.execute(fixture.frame, fixture.call)
      expect(effect.outcome).toBe(
        failAfterUsage || (gatewayFees && legacyUsage) ? 'unknown_effect' : 'succeeded',
      )
      expect(effect.usage).toHaveLength(1)
      const fact = effect.usage[0]
      if (fact?.dimensions.kind !== 'inline') throw new Error('Missing original inline measurement')
      const parsed = validateRuntime('UsageMeasurement', fact.dimensions.value)
      if (!parsed.ok) throw new Error('Invalid official measurement')
      if (failAfterUsage || (gatewayFees && legacyUsage)) {
        expect(fact.certainty).toBe('unknown')
        expect(parsed.value.kind).toBe('unknown')
        expect(parsed.value.quantities).toEqual([])
      } else
        expect(parsed.value.quantities).toEqual(
          expect.arrayContaining([
            { unit: 'fixture.input-token', value: '7' },
            { unit: 'fixture.output-token', value: '3' },
          ]),
        )
      expect(parsed.value.billing).toEqual(
        legacyUsage
          ? undefined
          : gatewayFees
            ? { usdMicros: 0, source: 'gateway', subscription: true }
            : estimateBilling(fixture.source.model, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }),
      )
      expect(parsed.value.credits).toBe(
        legacyUsage || rate === undefined
          ? undefined
          : gatewayFees
            ? 0
            : estimateCredits(
                fixture.source.model,
                { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
                rate,
              ),
      )
      expect(parsed.value.creditSource).toBe(
        legacyUsage || rate === undefined ? undefined : gatewayFees ? 'gateway' : 'estimated',
      )
      expect(fact.dimensions.digest).toBe(canonicalJsonDigest(parsed.value))
      expect(fact.dimensions.bytes).toBe(Buffer.byteLength(JSON.stringify(parsed.value)))
      if (failAfterUsage || (gatewayFees && legacyUsage)) {
        const recovered = await fixture.action.reconcile(fixture.frame, [], fixture.call)
        expect(recovered.kind).toBe('resolved')
        if (recovered.kind !== 'resolved') throw new Error('Missing original saved unknown effect')
        expect(recovered.result).toEqual(effect)
      }
      expect(readFileSync(requests, 'utf8').trim().split('\n')).toHaveLength(1)
    } finally {
      fault?.mockRestore()
      await fixture?.provider.close('shutdown')
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill()
        await exited
      }
      rmSync(directory, { recursive: true, force: true })
    }
  },
  20000,
)
