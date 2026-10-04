import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { expect, it, vi } from 'vitest'
import { PiAdapter } from '../../src/adapters/pi/index.js'
import { estimateBilling } from '../../src/usage.js'
import { modelFixture } from './model-fixture.js'

it.each([
  { api: 'openai-completions', failAfterUsage: false },
  { api: 'anthropic-messages', failAfterUsage: false },
  { api: 'openai-completions', failAfterUsage: true },
] as const)(
  'retains actual Pi HTTP token-derived billing for $api (failure=$failAfterUsage)',
  async ({ api, failAfterUsage }) => {
    const directory = mkdtempSync(join(tmpdir(), 'model-usage-wire-'))
    const requests = join(directory, 'requests.jsonl')
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/model-http.mjs', import.meta.url)), requests],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    )
    const originalStream = PiAdapter.prototype.stream
    const fault = failAfterUsage
      ? vi.spyOn(PiAdapter.prototype, 'stream').mockImplementation(async function* (
          this: PiAdapter,
          route,
          request,
          options,
        ) {
          for await (const event of originalStream.call(this, route, request, options)) {
            yield event
            if (event.type === 'usage') throw new Error('Stream failed after original HTTP usage')
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
      fixture = await modelFixture(api, `http://127.0.0.1:${port}/v1`, join(directory, 'effect.json'), {
        input: 2,
        output: 3,
        cacheRead: 1,
        cacheWrite: 4,
      })
      const effect = await fixture.action.execute(fixture.frame, fixture.call)
      expect(effect.outcome).toBe(failAfterUsage ? 'unknown_effect' : 'succeeded')
      expect(effect.usage).toHaveLength(1)
      const fact = effect.usage[0]
      if (fact?.dimensions.kind !== 'inline') throw new Error('Missing original inline measurement')
      const parsed = validateRuntime('UsageMeasurement', fact.dimensions.value)
      if (!parsed.ok) throw new Error('Invalid official measurement')
      if (failAfterUsage) {
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
        estimateBilling(fixture.source.model, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }),
      )
      expect(parsed.value.credits).toBeUndefined()
      expect(fact.dimensions.digest).toBe(canonicalJsonDigest(parsed.value))
      expect(fact.dimensions.bytes).toBe(Buffer.byteLength(JSON.stringify(parsed.value)))
      if (failAfterUsage) {
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
