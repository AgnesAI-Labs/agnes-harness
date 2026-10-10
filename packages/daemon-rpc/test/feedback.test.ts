import { localPackageAdminAuthority } from '@agnes/daemon-admin/packages/index'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { FeedbackPorts, FeedbackServiceFactory } from '@agnes/extension-api'
import { rpcError, type Actor } from '@agnes/protocol'
import type { AdminFeedbackParams, AdminFeedbackResult } from '@agnes/protocol/gen/app-server'
import { expect, it } from 'vitest'
import { registerFeedback } from '../src/local/methods/feedback.js'

it('gates feedback by local admin and session ownership and supports replaceable services without opening cold readers', async () => {
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  ep.conn.credentialKind = 'local'
  const seen: string[] = []
  const scopes: string[] = []
  const resolvedActor: Actor = { id: 'owner', org: 'fixture', role: 'admin', deptPath: [], attrs: {} }
  let actorResolutions = 0
  const result: AdminFeedbackResult = {
    items: [],
    growth: [],
    counts: { up: 0, down: 0, withdrawn: 0, withCandidate: 0 },
    truncated: false,
  }
  const factory: FeedbackServiceFactory = () => ({
    async execute(input, actor, signal) {
      signal.throwIfAborted()
      seen.push(`${input.action}:${actor.id}`)
      actor.id = 'provider-mutation'
      return result
    },
  })
  registerFeedback(ep, {
    authority: localPackageAdminAuthority(),
    owner: (id) => {
      if (id !== 'cold') throw rpcError('CAPABILITY_DENIED')
    },
    actor: async () => {
      actorResolutions++
      return resolvedActor
    },
    ports: (_context, input) => {
      scopes.push(`${input.action}:${input.sessionId ?? ''}`)
      return {} as FeedbackPorts
    },
    serialize: (_id, signal, work) => work(signal),
    factory,
  })
  const rpc = async (params: AdminFeedbackParams) =>
    (await ep.handle({
      jsonrpc: '2.0',
      id: 1,
      method: '_agnes/v1/admin.feedback',
      params,
    })) as { result?: AdminFeedbackResult; error?: { data?: { code?: string } } }
  try {
    expect((await rpc({ action: 'list' })).result).toEqual(result)
    expect((await rpc({ action: 'list', sessionId: 'cold' })).result).toEqual(result)
    expect(actorResolutions).toBe(0)
    expect(
      (
        await rpc({
          action: 'put',
          sessionId: 'cold',
          target: { messageSeq: null, turn: null },
          rating: 'up',
          expectedRevision: null,
        })
      ).result,
    ).toEqual(result)
    expect(actorResolutions).toBe(1)
    expect(resolvedActor.id).toBe('owner')
    expect((await rpc({ action: 'list', sessionId: 'foreign' })).error?.data?.code).toBe('CAPABILITY_DENIED')
    ep.conn.authKind = 'jwt'
    expect((await rpc({ action: 'list' })).error?.data?.code).toBe('CAPABILITY_DENIED')
    expect(seen).toEqual(['list:owner', 'list:owner', 'put:owner'])
    expect(scopes).toEqual(['list:', 'list:cold', 'put:cold'])
  } finally {
    await ep.close()
  }
})
