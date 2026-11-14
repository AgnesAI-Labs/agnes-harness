import { expect, it } from 'vitest'
import { createSupervisorProfileServices } from '../src/supervisor/profile-services.js'

const lane = { sharedWorker: true, sessionKey: '@profile' }
const identity = {
  owner: 'plugin/0123456789abcdef',
  packageId: 'companion',
  integrity: 'sha256-x',
  service: 'engine',
}

function services() {
  const created = createSupervisorProfileServices({
    runtime: undefined,
    profile: 'p',
    pool: {},
    repo: undefined,
    profileHash: 'h',
    clock: () => 0,
    ownership: { resolve: () => undefined },
    workspaces: {},
    registry: {},
  } as unknown as Parameters<typeof createSupervisorProfileServices>[0])
  const calls: [string, unknown[]][] = []
  const method =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, args])
      return { state: 'absent', historyCoverage: 'partial' }
    }
  created.managedSessions.port = () =>
    ({
      admitInput: method('admitInput'),
      inputResult: method('inputResult'),
      list: method('list'),
    }) as never
  return { created, calls }
}

it('admitInput and inputResult pass the action whitelist', async () => {
  const { created, calls } = services()
  const input = { key: 'k' }
  await created.ownedSession(lane, { ...identity, action: 'admitInput', args: ['s1', input] })
  await created.ownedSession(lane, { ...identity, action: 'inputResult', args: ['s1', { key: 'k' }] })
  expect(calls).toEqual([
    ['admitInput', ['s1', input]],
    ['inputResult', ['s1', { key: 'k' }]],
  ])
})

it('an unlisted action is still refused', async () => {
  const { created, calls } = services()
  for (const action of ['admitResolved', 'decide', 'withdraw', 'constructor'])
    await expect(created.ownedSession(lane, { ...identity, action, args: ['s1'] })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
  expect(calls).toEqual([])
})
