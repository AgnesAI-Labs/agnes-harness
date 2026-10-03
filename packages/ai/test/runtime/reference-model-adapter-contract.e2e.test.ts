import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import { expect, it } from 'vitest'
import { createReferenceModelAdapterFactory } from '../../../../examples/runtime-reference/src/providers/model-adapter.js'
import { referenceModelFixture } from './reference-model-fixture.js'

const tckUrl = new URL('../../../extension-api/testkit/runtime/contracts/model-adapter.ts', import.meta.url)
  .href
it.each(['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'] as const)(
  'runs actual independent reference model adapter contract %s',
  async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), 'model-tck-'))
    const requests = join(directory, 'requests.jsonl'),
      receipt = join(directory, 'receipt.json')
    const child: ChildProcess = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/model-http.mjs', import.meta.url)), requests],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, LANG: 'C' } },
    )
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture startup deadline')), 10000)
      child.once('message', (message) => {
        clearTimeout(timer)
        resolve((message as { port: number }).port)
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('Fixture startup exited'))
      })
    })
    const open = async () => {
      const fixture = await referenceModelFixture(`http://127.0.0.1:${port}/v1`, receipt)
      const configuration = fixture.deployment.config.encode({})
      if (!configuration.ok) throw new Error('Missing genuine fixture config')
      return {
        factory: createReferenceModelAdapterFactory(fixture.deployment),
        configuration: configuration.value,
        dependencies: createTestServiceContainer().dependencies,
        factoryContext: {
          instanceId: 'contract-instance',
          scope: fixture.context.scope,
          bindingId: fixture.context.bindingId,
          signal: new AbortController().signal,
        },
        call: fixture.context,
        frame: fixture.frame,
        actionContext: (call: typeof fixture.context) => ({ ...fixture.call, call }),
        revoke: async () => fixture.revoke(),
        restart: open,
        deliveries: () =>
          existsSync(requests) ? readFileSync(requests, 'utf8').trim().split('\n').length : 0,
        close: async () => fixture.provider.close('shutdown'),
      }
    }
    try {
      const tck = await import(tckUrl)
      const result = await tck.runModelAdapterContractScenario(scenario, open)
      expect(result.providerDigest).toBe('c'.repeat(64))
    } finally {
      if (child.exitCode === null) {
        const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill()
        await exit
      }
      rmSync(directory, { recursive: true, force: true })
    }
  },
  20000,
)
