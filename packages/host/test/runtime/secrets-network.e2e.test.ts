import { join } from 'node:path'
import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import {
  action,
  boundary,
  cleanup,
  consumer,
  loopback,
  must,
  network,
  peer,
  refreshInput,
  request,
  rule,
  scan,
  scope,
  scratch,
  secrets,
} from './network-secrets-fixture.js'

it('renews purpose-bound credentials through a selected real loopback network service and encrypted callback escrow', async () => {
  const root = scratch()
  const remote = await peer()
  const auth = boundary()
  const outbound = network('default', join(root, 'network'), auth, [rule(remote.port)], {
    resolver: loopback,
  })
  const invoke = async () => {
    expect(must(await outbound.request(request(remote.port), auth.call())).status).toBe(200)
    return { state: 'ready' as const, newVersionRef: 'secret://fixture/new' }
  }
  const flow = {
    flowId: 'flow',
    stateDigest: canonicalJsonDigest('state'),
    redirectUri: 'http://localhost/callback',
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    grant: { principalRef: 'actor', scope, binding: consumer },
  }
  const refreshed = secrets('default', join(root, 'refresh'), auth, { refresh: invoke })
  const exchanged = secrets('default', join(root, 'exchange'), auth, {
    flows: [flow],
    trustedIngress: auth.trustedIngress,
    exchange: async (_input, code) => {
      expect(Buffer.from(code).toString() === 'bad-code').toBe(true)
      return invoke()
    },
  })
  try {
    const ready = must(await refreshed.refresh(refreshInput, action(auth.call())))
    expect(ready.state).toBe('ready')
    must(
      await refreshed.use(ready.handle, consumer, auth.call(), (value) => {
        expect(value === 'rotated').toBe(true)
      }),
    )
    const escrow = must(
      await exchanged.acceptCallback(
        { flowId: 'flow', state: 'state', redirectUri: flow.redirectUri, authorizationCode: 'bad-code' },
        auth.ingress(),
      ),
    )
    const output = must(
      await exchanged.exchange(
        {
          requestId: 'exchange',
          ...escrow,
          expectedVersion: 'v1',
          audience: consumer.audience,
          accountRef: 'account',
          serverRef: 'server',
        },
        action(auth.call()),
      ),
    )
    expect(output.state).toBe('ready')
    expect(remote.requests()).toBe(2)
    scan(join(root, 'refresh'), ['not-real', 'rotated', 'bad-code'], [ready])
    scan(join(root, 'exchange'), ['not-real', 'rotated', 'bad-code'], [output])
  } finally {
    await refreshed.close()
    await exchanged.close()
    await outbound.close()
    await remote.close()
    cleanup(root)
  }
})
