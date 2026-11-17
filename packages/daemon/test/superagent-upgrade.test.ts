import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { RuntimeGenerationSnapshotStore } from '@agnes/package-manager'
import { rpcError } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { registerSuperagentUpgrade } from '../src/superagent/upgrade.js'
import { WorkerRegistry } from '../src/supervisor/registry.js'
import type { WorkerPool } from '../src/supervisor/worker-pool.js'

const identity = { integrity: 'new-code', incarnation: 'current-service' }
function fixture(transport: 'unix' | 'ws' = 'unix') {
  const endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  Object.assign(endpoint.conn, {
    initialized: true,
    authKind: 'local',
    credentialKind: 'local',
    bundledApp: true,
    clientId: 'bundled-app:@agnes/superagent/superagent',
  })
  const pins = new Map([
    ['registered-main', 'old'],
    ['registered-worker', 'old'],
    ['superagent:ordinary', 'old'],
  ])
  const state = {
    current: true,
    unknown: false,
    unreadable: '',
    retireAfterMigration: false,
    roster: ['registered-main', 'registered-worker'],
  }
  const pool = {
    async acquireSharedWorker() {
      return {
        async command(method: string, params: Record<string, unknown>) {
          if (method === 'profileManaged.superagentUpgradeSessions') {
            if (
              !state.current ||
              params.integrity !== identity.integrity ||
              params.incarnation !== identity.incarnation
            )
              throw rpcError('CAPABILITY_DENIED')
            return [...state.roster]
          }
          if (method !== 'pluginGenerations.migrate') throw new Error(method)
          if (state.unknown && params.sessionId === 'registered-worker')
            throw new Error('E_GENERATION_EXECUTION_UNSETTLED')
          expect(params.superagentIntegrity).toBe(identity.integrity)
          pins.set(String(params.sessionId), identity.integrity)
          if (state.retireAfterMigration) state.current = false
          return { changed: true, generationId: 'new' }
        },
      }
    },
  } as unknown as WorkerPool
  const registry = new WorkerRegistry(pool)
  const owners = new Map(state.roster.map((key) => [key, 'owner']))
  registerSuperagentUpgrade(
    endpoint,
    transport,
    pool,
    registry,
    {
      resolve: (key) => (owners.has(key) ? { active: true, principalId: owners.get(key)! } : undefined),
    },
    {
      session: (key: string) => {
        if (state.unreadable === 'pin') throw new Error('invalid pin identity')
        return pins.has(key) ? { sessionKey: key, generationId: pins.get(key)! } : undefined
      },
      read: (integrity: string) => {
        if (state.unreadable === 'snapshot') throw new Error('unreadable generation')
        return { sources: [{ snapshot: { packageId: '@agnes/superagent', integrity } }] }
      },
    } as unknown as Pick<RuntimeGenerationSnapshotStore, 'session' | 'read'>,
  )
  const call = (params: unknown = identity) =>
    endpoint.handle({
      jsonrpc: '2.0',
      id: 1,
      method: '_agnes/v1/superagent.sessions.upgrade',
      params,
    })
  return { endpoint, state, owners, pins, registry, call }
}

it('accepts only the current bundled SA connection and service roster, never caller ids or key prefixes', async () => {
  const f = fixture()
  expect(await f.call({ ...identity, sessionIds: ['superagent:ordinary'] })).toHaveProperty('error')
  for (const changed of [
    { bundledApp: undefined },
    { clientId: 'bundled-app:@acme/other/service' },
    { clientId: 'owner-sdk' },
    { authKind: 'surface' },
  ]) {
    const previous = Object.fromEntries(
      Object.keys(changed).map((key) => [key, (f.endpoint.conn as unknown as Record<string, unknown>)[key]]),
    )
    Object.assign(f.endpoint.conn, changed)
    expect(await f.call()).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
    Object.assign(f.endpoint.conn, previous)
  }
  expect(await fixture('ws').call()).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
  expect(await f.call({ ...identity, incarnation: 'retired-service' })).toHaveProperty('error')
  f.owners.set('registered-worker', 'other')
  expect(await f.call()).toHaveProperty('error')
  expect([...f.pins.values()]).toEqual(['old', 'old', 'old'])
  f.owners.set('registered-worker', 'owner')
  expect(await f.call()).toMatchObject({ result: { sessionIds: f.state.roster } })
  expect([...f.pins.values()]).toEqual(['new-code', 'new-code', 'old'])
})

it('keeps an unknown session pinned, tolerates a partial migration on retry, and handles a new install', async () => {
  const f = fixture()
  f.state.unknown = true
  expect(await f.call()).toHaveProperty('error')
  expect([...f.pins.values()]).toEqual(['new-code', 'old', 'old'])
  // The underlying recovery is independent; a retry cannot assume the first pin write rolled back.
  f.state.unknown = false
  expect(await f.call()).toMatchObject({ result: { sessionIds: ['registered-worker'] } })
  expect([...f.pins.values()]).toEqual(['new-code', 'new-code', 'old'])
  f.state.roster = []
  expect(await f.call()).toMatchObject({ result: { sessionIds: [] } })
})

it('leaves current-code sessions alone on restart and revalidates the service after an awaited migration', async () => {
  for (const unreadable of ['pin', 'snapshot']) {
    const corrupt = fixture()
    corrupt.state.unreadable = unreadable
    expect(await corrupt.call()).toHaveProperty('error')
    expect([...corrupt.pins.values()]).toEqual(['old', 'old', 'old'])
  }
  const same = fixture()
  for (const key of same.state.roster) same.pins.set(key, identity.integrity)
  same.state.unknown = true
  // A busy/unknown current session still belongs to ordinary recovery, without any close or migration.
  same.registry.upgradeIdleSessions = async () => {
    throw new Error('busy session must not be closed')
  }
  expect(await same.call()).toMatchObject({ result: { sessionIds: [] } })
  same.pins.delete('registered-worker')
  expect(await same.call()).toMatchObject({ result: { sessionIds: [] } })

  const retired = fixture()
  retired.state.retireAfterMigration = true
  expect(await retired.call()).toMatchObject({ error: { data: { code: 'CAPABILITY_DENIED' } } })
  expect([...retired.pins.values()]).toEqual(['new-code', 'old', 'old'])
})
