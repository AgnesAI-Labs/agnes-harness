import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { rpcError, type UiActionParams } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { CommandQueue } from '../src/local/command-queue.js'
import type { AgnesContext } from '../src/local/methods/agnes.js'
import { registerIntelligentUi } from '../src/local/methods/intelligent-ui.js'

it('checks session ownership before state/dedupe, binds the actor and repairs a cold session via existing ports', async () => {
  const endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'operator' })
  endpoint.conn.initialized = true
  endpoint.conn.authKind = 'local'
  endpoint.conn.credentialKind = 'local'
  const commandQueue = new CommandQueue()
  const actor = { id: 'server-actor', org: 'synthetic', role: 'owner', deptPath: [], attrs: {} }
  const seen: unknown[] = []
  let cold = true,
    enabled = true
  const receipt = {
    sessionId: 'owned',
    surfaceId: 'review',
    revision: 1,
    actionId: 'confirm',
    commandId: 'one',
    status: 'received',
    seq: 4,
    duplicate: false,
  }
  const result = { sessionId: 'owned', lastSeq: 4, surfaces: [], actions: [receipt] }
  const entry = {
    session: {
      get intelligentUi() {
        return enabled
          ? {
              async action(input: unknown, boundActor: unknown) {
                seen.push({ input, actor: boundActor })
                return receipt
              },
              async read() {
                return result
              },
            }
          : undefined
      },
    },
  }
  const cx = {
    commandQueue,
    registry: {
      get: () => (cold ? undefined : entry),
      open: async (input: unknown) => {
        seen.push(input)
        cold = false
        return entry
      },
    },
    workspaces: { restoreBinding: async () => ({ canonicalRoot: '/synthetic', sessionKey: 'owned' }) },
    resolveActor: async () => actor,
    journal: { begin: async () => ({ state: 'new' }), complete: async () => {}, abandon: async () => {} },
    continueFollowUps: (_entry: unknown, _inherited: unknown, restart: boolean) => {
      seen.push({ restart })
    },
  } as unknown as AgnesContext
  registerIntelligentUi(endpoint, cx, (_method, id) => {
    if (id !== 'owned') throw rpcError('CAPABILITY_DENIED')
  })
  const request: UiActionParams = {
    sessionId: 'owned',
    surfaceId: 'review',
    revision: 1,
    actionId: 'confirm',
    commandId: 'one',
    input: {},
    selection: {},
  }
  const call = async (method: string, params: unknown) =>
    (await endpoint.handle({ jsonrpc: '2.0', id: 1, method, params })) as {
      result?: unknown
      error?: { data?: { code?: string } }
    }
  try {
    expect((await call('_agnes/v1/ui.action', { ...request, sessionId: 'foreign' })).error?.data?.code).toBe(
      'CAPABILITY_DENIED',
    )
    expect(seen).toEqual([])
    expect((await call('_agnes/v1/ui.action', request)).result).toEqual(receipt)
    expect(seen).toContainEqual({ input: request, actor })
    expect((await call('_agnes/v1/ui.read', { sessionId: 'owned' })).result).toEqual(result)
    expect(seen.filter((value) => typeof value === 'object' && value !== null && 'restart' in value)).toEqual(
      [{ restart: true }, { restart: true }],
    )
    enabled = false
    expect((await call('_agnes/v1/ui.action', request)).error?.data?.code).toBe('CAPABILITY_DENIED')
  } finally {
    await commandQueue.close()
    await endpoint.close()
  }
})
