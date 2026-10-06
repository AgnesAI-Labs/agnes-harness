import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EffectResult, validateRuntimeErrorDetail } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import { modelFixture } from './model-fixture.js'

async function lostFixture(save: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'model-lost-'))
  const receipt = join(directory, 'receipt.json')
  const fixture = await modelFixture(
    'openai-completions',
    'http://127.0.0.1:9/v1',
    receipt,
    undefined,
    false,
    undefined,
    true,
  )
  const saved: EffectResult = {
    outcome: 'succeeded',
    externalRequests: [],
    usage: [],
    references: [],
  }
  if (save) writeFileSync(receipt, JSON.stringify({ frame: fixture.frame, result: saved, bodyDigest: 'x' }))
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

it('returns the saved result when the prepared call is lost but the store already holds one, and sends nothing', async () => {
  const { fixture, saved, settle } = await lostFixture(true)
  await settle(async () => {
    const effect = await fixture.action.execute(fixture.frame, fixture.call)
    expect(effect).toEqual(saved)
    expect(fixture.sends()).toBe(0)
    expect(fixture.credentialUses()).toBe(0)
  })
})

it('reports an unknown effect, without resending, when the prepared call is lost and the store cannot say', async () => {
  const { fixture, settle } = await lostFixture(false)
  await settle(async () => {
    const effect = await fixture.action.execute(fixture.frame, fixture.call)
    expect(effect).toMatchObject({
      outcome: 'unknown_effect',
      error: {
        detailCode: 'model_prepared_unknown',
        retryAdvice: { kind: 'reconcile', ownerRef: { kind: 'action', id: fixture.frame.actionId } },
      },
    })
    expect(validateRuntimeErrorDetail(effect.error).ok).toBe(true)
    expect(fixture.sends()).toBe(0)
    expect(fixture.credentialUses()).toBe(0)
  })
})
