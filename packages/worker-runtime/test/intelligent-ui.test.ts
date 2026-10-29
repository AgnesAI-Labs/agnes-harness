import type { Host, HostSession } from '@agnes/host'
import { rpcError, type UiActionParams } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { handleCommand } from '../src/commands.js'

const actor = {
  id: 'operator',
  org: 'synthetic',
  role: 'reviewer',
  deptPath: ['review'],
  attrs: { scope: 'read' },
}
const credential = { kind: 'local', principal: 'operator' }
const input: UiActionParams = {
  sessionId: 'owned',
  surfaceId: 'review',
  revision: 1,
  actionId: 'confirm',
  commandId: 'one',
  input: {},
  selection: {},
}

it('resolves UI action identity from credentials and refuses forged body actors before dispatch', async () => {
  const deliveries: unknown[] = []
  const receipt = { status: 'received' }
  const session = {
    key: 'owned',
    ac: new AbortController(),
    intelligentUi: {
      action: async (request: unknown, resolved: unknown) => {
        deliveries.push({ request, actor: resolved })
        return receipt
      },
    },
  } as unknown as HostSession
  const host = {
    resolveActor: async (provided: unknown, surface: string) => {
      if (JSON.stringify(provided) !== JSON.stringify(credential) || surface !== 'session')
        throw rpcError('CAPABILITY_DENIED')
      return actor
    },
  } as unknown as Host
  const call = (params: Record<string, unknown>) =>
    handleCommand(
      session,
      {
        kind: 'command',
        requestId: 'ui-test',
        method: 'ui.action',
        params,
      },
      { host, aborts: new Map() },
    )
  for (const params of [
    { input, credential, actor: { ...actor, id: 'someone-else' } },
    { input, credential, actor: { ...actor, role: 'admin' } },
    { input, actor },
    { input },
    { input, credential: { kind: 'forged' } },
  ])
    await expect(call(params)).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  expect(deliveries).toEqual([])
  await expect(call({ input, credential })).resolves.toEqual(receipt)
  expect(deliveries).toEqual([{ request: input, actor }])
})
