import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { SchedulesPort } from '@agnes/daemon-foundation/local/ports'
import type { AgentPlan } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { registerSchedules } from '../src/local/methods/schedules.js'

it('looks up only sessions bound to reminders when filtering a workspace', async () => {
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  let selected: unknown
  let bound = ['reminder']
  registerSchedules(
    ep,
    {
      registry: { get: () => undefined },
      lister: {
        list: async (query) => {
          expect(query.sessionIds).toEqual(bound)
          return { items: [{ sessionId: 'reminder' } as never] }
        },
      },
      schedules: {
        boundSessionKeys: async () => bound,
        list: async (query: unknown) => {
          selected = query
          return { schedules: [] }
        },
      } as unknown as SchedulesPort,
    },
    () => undefined,
  )
  const call = () =>
    ep.handle({
      jsonrpc: '2.0',
      id: 1,
      method: '_agnes/v1/schedules.list',
      params: { scope: 'all', workspace: '/work' },
    })
  expect(await call()).toMatchObject({ result: { schedules: [] } })
  expect(selected).toMatchObject({ workspaceSessionKeys: ['reminder'] })
  bound = []
  expect(await call()).toMatchObject({ result: { schedules: [] } })
  expect(selected).toMatchObject({ workspaceSessionKeys: [] })
})

it('restricts global history, per-task history and receipt writes to their authorized owner', async () => {
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  const id = 'sched_0123456789abcdef'
  const runId = 'run_' + '1'.repeat(32)
  let ownerAllowed = false
  let updates = 0
  let listed: unknown
  registerSchedules(
    ep,
    {
      registry: { get: () => undefined },
      lister: {
        list: async (query) => ({
          items: [{ sessionId: query.cursor ? 'older' : 'recent' } as never],
          ...(!query.cursor ? { cursor: 'next' } : {}),
        }),
      },
      schedules: {
        list: async (query: unknown) => {
          listed = query
          return { schedules: [] }
        },
        read: async (key: string) =>
          key === id ? { sessionKey: 'owned', target: { kind: 'session' } } : undefined,
        history: async () => ({ runs: [] }),
        receipt: async () => {
          updates++
          return { updated: true }
        },
      } as unknown as SchedulesPort,
    },
    () => {
      if (!ownerAllowed) throw new Error('foreign session')
    },
  )
  const call = (method: string, params: unknown) => ep.handle({ jsonrpc: '2.0', id: 1, method, params })
  expect(await call('_agnes/v1/schedules.history', {})).toMatchObject({ result: { runs: [] } })
  expect(await call('_agnes/v1/schedules.history', { id })).toHaveProperty('error')
  expect(await call('_agnes/v1/schedules.receipt', { id, runId, read: true })).toHaveProperty('error')
  expect(updates).toBe(0)
  ownerAllowed = true
  expect(await call('_agnes/v1/schedules.history', { id })).toMatchObject({ result: { runs: [] } })
  expect(await call('_agnes/v1/schedules.receipt', { id, runId, read: true })).toMatchObject({
    result: { updated: true },
  })
  expect(updates).toBe(1)
  expect(
    await call('_agnes/v1/schedules.list', { scope: 'all', workspace: '/synthetic/work' }),
  ).toMatchObject({ result: { schedules: [] } })
  expect(listed).toEqual({
    scope: 'all',
    workspace: '/synthetic/work',
    workspaceSessionKeys: ['recent', 'older'],
  })
  expect(
    await call('_agnes/v1/schedules.list', { scope: 'all', workspaceSessionKeys: ['forged'] }),
  ).toHaveProperty('error')
  expect(await call('_agnes/v1/schedules.history', { limit: 101 })).toHaveProperty('error')
  ep.conn.authKind = 'jwt'
  expect(await call('_agnes/v1/schedules.history', {})).toHaveProperty('error')
})

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
