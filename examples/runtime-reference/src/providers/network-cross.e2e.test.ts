import { expect, it } from 'vitest'
import {
  boundary,
  cleanup,
  error,
  loopback,
  must,
  network,
  peer,
  request,
  rule,
  scratch,
} from '../../../../packages/host/test/runtime/network-secrets-fixture.js'

it('returns the same network result and refusal codes for the same input', async () => {
  const root = scratch()
  const remote = await peer()
  const auth = boundary()
  const input = request(remote.port)
  const call = auth.call({ invocationId: 'cross-request' })
  const providers = ['default', 'reference'].map((kind) =>
    network(kind as 'default' | 'reference', `${root}/${kind}`, auth, [rule(remote.port)], {
      resolver: loopback,
    }),
  )
  try {
    const results = []
    for (const service of providers)
      results.push({
        output: must(await service.request(input, call)),
        forged: error(await service.request(input, { ...call })),
        unlisted: error(
          await service.request({ ...input, target: { ...input.target, targetId: 'other' } }, auth.call()),
        ),
        redirect: error(await service.request(request(remote.port, '/private'), auth.call())),
        limit: error(await service.request(request(remote.port, '/oversize'), auth.call())),
      })
    expect(results[0]).toEqual(results[1])
  } finally {
    for (const service of providers) await service.close()
    await remote.close()
    cleanup(root)
  }
})
