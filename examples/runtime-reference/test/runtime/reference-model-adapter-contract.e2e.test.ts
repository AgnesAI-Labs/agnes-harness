import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallContext } from '@agnes/extension-api/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import type { EffectResult } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { createReferenceModelAdapterFactory } from '../../src/providers/model-adapter.js'
import { referenceModelFixture } from './reference-model-fixture.js'

const tckUrl = new URL(
  '../../../../packages/extension-api/testkit/runtime/contracts/model-adapter.ts',
  import.meta.url,
).href
it.each(['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'] as const)(
  'runs actual independent reference model adapter contract %s',
  async (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), 'model-tck-'))
    const requests = join(directory, 'requests.jsonl'),
      receipt = join(directory, 'receipt.json')
    const child: ChildProcess = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL('../../../../packages/ai/test/runtime/fixtures/model-http.mjs', import.meta.url),
        ),
        requests,
      ],
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

// A revocation must never hide what was already saved: reconcile reads the original facts after
// the grant is gone, while invoke still refuses before it loads or sends anything.
async function revokedFixture(save: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'model-revoked-'))
  const receipt = join(directory, 'receipt.json')
  const fixture = await referenceModelFixture('http://127.0.0.1:9/v1', receipt)
  const saved: EffectResult = {
    outcome: 'failed',
    error: {
      code: 'denied',
      detailCode: 'saved_fixture_fact',
      message: 'Saved fixture fact',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'fixture',
    },
    externalRequests: [],
    usage: [],
    references: [],
  }
  if (save) writeFileSync(receipt, JSON.stringify({ frame: fixture.frame, result: saved, bodyDigest: 'x' }))
  fixture.revoke()
  const settle = async <T>(work: () => Promise<T>) => {
    try {
      return await work()
    } finally {
      await fixture.provider.close('shutdown')
      rmSync(directory, { recursive: true, force: true })
    }
  }
  return { fixture, saved, settle }
}
const answer = (effect: EffectResult) => {
  if (effect.outcome !== 'succeeded' || effect.result?.kind !== 'inline')
    throw new Error(`Reconcile did not answer: ${JSON.stringify(effect.error)}`)
  return effect.result.value
}

it('answers reconcile execute from the saved facts after the grant is revoked, without load or send', async () => {
  const { fixture, saved, settle } = await revokedFixture(true)
  await settle(async () => {
    const effect = await fixture.reconciler.execute(fixture.reconcileFrame(), fixture.call)
    expect(answer(effect)).toMatchObject({ kind: 'resolved', result: saved })
    expect(fixture.loads()).toBe(0)
    expect(fixture.sends()).toBe(0)
  })
})

it('answers the leaf reconcile from the saved facts after the grant is revoked', async () => {
  const { fixture, saved, settle } = await revokedFixture(true)
  await settle(async () => {
    const answered = await fixture.reconciler.reconcile(fixture.frame, [], fixture.call)
    expect(answered).toMatchObject({ kind: 'resolved', result: saved })
    expect(fixture.loads()).toBe(0)
    expect(fixture.sends()).toBe(0)
  })
})

it('still refuses invoke after the grant is revoked, before any load or send', async () => {
  const { fixture, settle } = await revokedFixture(true)
  await settle(async () => {
    const effect = await fixture.action.execute(fixture.frame, fixture.call)
    expect(effect).toMatchObject({
      outcome: 'failed',
      error: { code: 'denied', detailCode: 'reference_model' },
    })
    expect(fixture.loads()).toBe(0)
    expect(fixture.sends()).toBe(0)
  })
})

it('keeps an unsaved or unknown attempt unknown after the grant is revoked', async () => {
  const { fixture, settle } = await revokedFixture(false)
  await settle(async () => {
    const unsaved = answer(await fixture.reconciler.execute(fixture.reconcileFrame(), fixture.call))
    expect(unsaved).toMatchObject({ kind: 'unknown' })
    const other = answer(
      await fixture.reconciler.execute(fixture.reconcileFrame('never-issued'), fixture.call),
    )
    expect(other).toMatchObject({ kind: 'unknown' })
    expect(await fixture.reconciler.reconcile(fixture.frame, [], fixture.call)).toMatchObject({
      kind: 'unknown',
    })
    expect(fixture.loads()).toBe(0)
    expect(fixture.sends()).toBe(0)
  })
})

it.each([
  ['an aborted call', (call: CallContext): CallContext => ({ ...call, signal: AbortSignal.abort() })],
  [
    'an expired deadline',
    (call: CallContext): CallContext => ({ ...call, deadline: '2000-01-01T00:00:00.000Z' }),
  ],
  [
    'a scope the factory does not own',
    (call: CallContext): CallContext => ({ ...call, scope: { ...call.scope, runtimeId: 'other-runtime' } }),
  ],
  [
    'a binding the factory does not own',
    (call: CallContext): CallContext => ({ ...call, bindingId: 'other-binding' }),
  ],
])('still refuses reconcile execute for %s after the grant is revoked', async (_name, change) => {
  const { fixture, settle } = await revokedFixture(true)
  await settle(async () => {
    const effect = await fixture.reconciler.execute(fixture.reconcileFrame(), {
      ...fixture.call,
      call: change(fixture.context),
    })
    expect(effect).toMatchObject({ outcome: 'failed', error: { code: 'denied' } })
    expect(fixture.loads()).toBe(0)
    expect(fixture.sends()).toBe(0)
  })
})
