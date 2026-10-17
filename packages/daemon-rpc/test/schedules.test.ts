import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { SchedulesPort } from '@agnes/daemon-foundation/local/ports'
import type { AgentPlan } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { registerSchedules } from '../src/local/methods/schedules.js'

it('lowers an authorized agent selection once into the saved target, refusing drift and preserving existing targets', async () => {
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  const plan = {
    ref: 'acme/kit#reader',
    loop: { id: 'shared', version: '1' },
    bundles: ['acme/kit#reader'],
    preset: 'safe',
    model: { route: 'demo', model: 'm' },
  } as AgentPlan
  let saved: unknown
  let available = true
  registerSchedules(
    ep,
    {
      host: {
        resolveAgent: async (ref) => {
          if (!available || ref !== plan.ref) throw new Error('agent unavailable')
          return plan
        },
      },
      registry: { get: () => undefined },
      schedules: {
        read: async () => undefined,
        upsert: async (value: unknown) => {
          saved = value
          return { updated: false, code: 'fixture-saved' }
        },
      } as unknown as SchedulesPort,
    },
    () => {
      throw new Error('foreign session')
    },
  )
  const create = (params: unknown) =>
    ep.handle({ jsonrpc: '2.0', id: 1, method: '_agnes/v1/schedules.upsert', params })
  const input = {
    title: 'Daily',
    prompt: 'Read',
    selector: { every_seconds: 60 },
    target: { kind: 'new-session', cwd: '/synthetic/workspace' },
  }
  expect(await create({ ...input, agent: plan.ref })).toMatchObject({ result: { code: 'fixture-saved' } })
  expect(saved).toEqual({
    ...input,
    target: {
      ...input.target,
      loop: plan.loop,
      bundles: plan.bundles,
      preset: plan.preset,
      model: plan.model,
    },
  })
  const frozen = structuredClone(saved)
  expect(
    await create({ ...input, agent: plan.ref, target: { ...input.target, preset: 'other' } }),
  ).toHaveProperty('error')
  expect(saved).toEqual(frozen)
  available = false
  expect(await create({ ...input, agent: plan.ref })).toHaveProperty('error')
  // Editing a saved target does not consult launch, even after its agent disappears.
  expect(await create(frozen)).toMatchObject({ result: { code: 'fixture-saved' } })
  expect(saved).toEqual(frozen)
})
