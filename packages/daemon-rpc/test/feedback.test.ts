import { localPackageAdminAuthority } from '@agnes/daemon-admin/packages/index'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { FeedbackPorts, FeedbackServiceFactory } from '@agnes/extension-api'
import { rpcError } from '@agnes/protocol'
import type { AdminFeedbackParams, AdminFeedbackResult } from '@agnes/protocol/gen/app-server'
import { expect, it } from 'vitest'
import { registerFeedback } from '../src/local/methods/feedback.js'

it('gates feedback by local admin and session ownership and supports replaceable services without opening cold readers', async () => {
  const ep = new LocalEndpoint({ clock: Date.now, principalId: 'owner' })
  ep.conn.initialized = true
  ep.conn.authKind = 'local'
  ep.conn.credentialKind = 'local'
  const seen: string[] = []
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
      return result
    },
  })
  registerFeedback(ep, {
    authority: localPackageAdminAuthority(),
    owner: (id) => {
      if (id !== 'cold') throw rpcError('CAPABILITY_DENIED')
    },
    actor: async () => {
      throw new Error('Read-only feedback must not open a worker to resolve an actor')
    },
    ports: () => ({}) as FeedbackPorts,
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
    expect((await rpc({ action: 'list', sessionId: 'foreign' })).error?.data?.code).toBe('CAPABILITY_DENIED')
    ep.conn.authKind = 'jwt'
    expect((await rpc({ action: 'list' })).error?.data?.code).toBe('CAPABILITY_DENIED')
    expect(seen).toEqual(['list:owner', 'list:owner'])
  } finally {
    await ep.close()
  }
})
