import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { describe, expect, it, vi } from 'vitest'
import { createReferenceModelEgress } from '../../../../examples/runtime-reference/src/providers/model-egress.js'
import { createHostModelAdapterDeployment } from '../../src/runtime/model/model-deployment.js'
import { createModelEgress } from '../../src/runtime/model/model-egress.js'
import { CONSUMER, coldModelEgress, modelFixture, type Recipe } from './model-egress-fixture.js'
import { modelJointFixture } from './model-joint-fixture.js'
import { must } from './network-secrets-fixture.js'

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value')
  return value
}

async function fixture(kind: Recipe, api?: string, path?: string) {
  const f = await modelFixture(kind, api, path)
  const mocks = ['log', 'warn', 'error'].map((name) =>
    vi
      .spyOn(console, name as 'log' | 'warn' | 'error')
      .mockImplementation((...values) => f.logs.push(String(values))),
  )
  return {
    ...f,
    async close() {
      for (const mock of mocks) mock.mockRestore()
      await f.close()
    },
  }
}

describe.each(['default', 'reference'] as const)('%s model egress', (kind) => {
  it.each(['openai-completions', 'anthropic-messages'])(
    'uses a stored envelope and the exact model handle through %s credential hook and real HTTP',
    async (api) => {
      const f = await fixture(
        kind,
        api,
        api === 'anthropic-messages' ? '/v1/messages' : '/v1/chat/completions',
      )
      try {
        const port = f.port()
        const credential = await port.resolveCredential('local-model', f.call.signal)
        // Assertions contain booleans, so a failure never prints the actual credential.
        expect(credential === f.key).toBe(true)
        const authHeader =
          api === 'anthropic-messages'
            ? { 'x-api-key': credential }
            : { authorization: `Bearer ${credential}` }
        const reply = await port.fetch(
          f.request(f.url, {
            headers: {
              'content-type': 'application/json',
              'x-stainless-lang': 'js',
              'x-stainless-retry-count': '0',
              'anthropic-dangerous-direct-browser-access': 'true',
              ...authHeader,
            },
          }),
        )
        expect(reply.status).toBe(200)
        expect(await reply.text()).toBe('data: {"answer":"local-answer"}\n\n')
        expect(reply.headers.get('set-cookie')).toBeNull()
        expect(reply.headers.get('x-secret')).toBeNull()
        expect(f.observations).toEqual([
          { path: f.target.path, correctKey: true, body: '{"model":"local","messages":[]}' },
        ])
        expect(await f.code(port.fetch(f.request()))).toBe('unknown_effect/model_egress_replay')
      } finally {
        await f.close()
      }
    },
  )
  it.each(['http', 'https'] as const)(
    'fences exactly once on each fresh %s connection, and rejects before any request bytes',
    async (scheme) => {
      const authorities = getCACertificates('default')
      if (scheme === 'https')
        setDefaultCACertificates([
          ...authorities,
          readFileSync(
            new URL('../../../../tools/test-fixtures/tls/localhost-cert.pem', import.meta.url),
            'utf8',
          ),
        ])
      const f = await modelFixture(
        kind,
        'openai-completions',
        undefined,
        CONSUMER,
        {},
        {
          scheme,
          host: '127.0.0.1',
        },
      )
      const digests: string[] = []
      try {
        for (const refusal of ['false', 'throw']) {
          const rejecting = f.port({
            beforeWrite: (digest) => {
              digests.push(digest)
              if (refusal === 'throw') throw new Error(f.key)
              return false
            },
          })
          expect(await f.code(rejecting.fetch(f.request()))).toBe('denied/model_egress_fence')
          expect(rejecting.fenced()).toBe(false)
          expect(f.stats.bytes).toBe(0)
          // A connector refusal must fail the queued request, never reconnect or replay it.
          expect(await f.code(rejecting.fetch(f.request()))).toBe('unknown_effect/model_egress_replay')
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const port = f.port({
            beforeWrite: (digest) => {
              digests.push(digest)
              return true
            },
          })
          expect(port.fenced()).toBe(false)
          expect((await port.fetch(f.request())).status).toBe(200)
          expect(port.fenced()).toBe(true)
        }
        const hash = createHash('sha256')
          .update(await f.request().text())
          .digest('hex')
        expect(digests).toEqual([hash, hash, hash, hash])
        expect(f.observations).toHaveLength(2)
        expect(f.observations.every((item) => item.correctKey)).toBe(true)
      } finally {
        await f.close()
        setDefaultCACertificates(authorities)
      }
      expect(f.stats.connections).toBe(4)
    },
  )
  it('leaves a failed TLS handshake unfenced with zero HTTP bytes', async () => {
    const f = await modelFixture(
      kind,
      'openai-completions',
      undefined,
      CONSUMER,
      {},
      {
        scheme: 'https',
        host: '127.0.0.1',
      },
    )
    const digests: string[] = []
    try {
      const port = f.port({
        beforeWrite: (digest) => {
          digests.push(digest)
          return true
        },
      })
      expect(await f.code(port.fetch(f.request()))).toBe('retryable/model_egress_connect')
      expect(port.fenced()).toBe(false)
      expect(digests).toEqual([])
      expect(f.observations).toEqual([])
    } finally {
      await f.close()
    }
    expect(f.stats.bytes).toBe(0)
    expect(f.stats.connections).toBe(1)
  })
  it('keeps a peer disconnect after the fence unknown and never sends again', async () => {
    const f = await fixture(kind, 'openai-completions', '/disconnect')
    const digests: string[] = []
    try {
      const port = f.port({
        beforeWrite: (digest) => {
          digests.push(digest)
          return true
        },
      })
      expect(await f.code(port.fetch(f.request()))).toBe('unknown_effect/model_egress_unknown')
      expect(port.fenced()).toBe(true)
      expect(await f.code(port.fetch(f.request()))).toBe('unknown_effect/model_egress_replay')
      expect(digests).toHaveLength(1)
      expect(f.observations).toHaveLength(1)
    } finally {
      await f.close()
    }
    expect(f.stats.connections).toBe(1)
  })
  it('refuses same-host different ports/paths, missing or ambiguous endpoints and unapproved target identities', async () => {
    const f = await fixture(kind)
    try {
      const other = new URL(f.url)
      other.port = String(f.target.port === 65535 ? 65534 : f.target.port + 1)
      for (const url of [other.href, `${f.url}/other`, `${f.url}?other=1`])
        expect(await f.code(f.port().fetch(f.request(url)))).toBe('denied/model_egress_target')
      for (const endpoints of [
        [],
        [...f.options.endpoints, ...f.options.endpoints],
        [{ ...f.endpoint, endpointRef: 'other' }],
      ]) {
        expect(await f.code(f.port({ endpoints }).fetch(f.request()))).toBe('denied/model_egress_target')
        expect(await f.code(f.port({ endpoints }).resolveCredential('local-model', f.call.signal))).toBe(
          'denied/model_egress_target',
        )
      }
      const endpoints = [{ ...f.endpoint, target: { ...f.target, targetId: 'other-target' } }]
      expect(await f.code(f.port({ endpoints }).fetch(f.request()))).toBe('denied/model_egress_network')
      expect(await f.code(f.port().fetch(f.request(f.url, { method: 'GET', body: null })))).toBe(
        'denied/model_egress_target',
      )
      expect(f.observations).toEqual([])
    } finally {
      await f.close()
    }
  })
  it('refuses missing owners, forged contexts, wrong bindings, unsupported APIs and a retired source', async () => {
    const f = await fixture(kind)
    try {
      for (const patch of [
        { installation: undefined },
        { endpoints: undefined },
        { current: undefined },
        { secrets: undefined },
        { network: undefined },
      ])
        expect(await f.code(f.port(patch).fetch(f.request()))).toBe('denied/model_egress_owner')
      const wrong = f.auth.call({ bindingId: 'another-model' })
      expect(await f.code(f.port({}, wrong).fetch(f.request()))).toBe('denied/model_egress_binding')
      expect(await f.code(f.port({}, { ...f.call }).fetch(f.request()))).toBe('denied/model_egress_binding')
      expect(await f.code(f.port().resolveCredential('other-route', f.call.signal))).toBe(
        'denied/model_egress_binding',
      )
      for (const api of [
        'google-generative-ai',
        'google-vertex',
        'bedrock-converse-stream',
        'openai-codex-responses',
        'openai-responses',
        'azure-openai-responses',
        'mistral-conversations',
        'pi-messages',
        'unknown-protocol',
      ]) {
        const port = f.port({ installation: { ...f.options.installation, api } })
        expect(await f.code(port.resolveCredential('local-model', f.call.signal))).toBe(
          'incompatible/model_egress_api',
        )
        expect(await f.code(port.fetch(f.request()))).toBe('incompatible/model_egress_api')
      }
      f.retire()
      expect(await f.code(f.port().fetch(f.request()))).toBe('denied/model_egress_binding')
      expect(f.observations).toEqual([])
    } finally {
      await f.close()
    }
  })
  it('intersects current network authority, deny rules and every DNS answer before consuming the key', async () => {
    const f = await fixture(kind)
    try {
      const network = f.options.network
      expect(
        await f.code(
          f
            .port({
              network: { ...network, rules: [...network.rules, { ...f.networkRule, effect: 'deny' }] },
            })
            .fetch(f.request()),
        ),
      ).toBe('denied/model_egress_network')
      expect(
        await f.code(
          f
            .port({
              network: {
                ...network,
                resolver: async () => [
                  { address: '127.0.0.1', family: 4 },
                  { address: '10.0.0.1', family: 4 },
                ],
              },
            })
            .fetch(f.request()),
        ),
      ).toBe('denied/model_egress_dns')
      expect(
        await f.code(
          f
            .port({
              network: {
                ...network,
                resolver: async () => {
                  f.denyNetwork()
                  return [{ address: '127.0.0.1', family: 4 }]
                },
              },
            })
            .fetch(f.request()),
        ),
      ).toBe('denied/model_egress_network')
      expect(f.observations).toEqual([])
    } finally {
      await f.close()
    }
  })
  it('refuses concurrent replay and network revocation while C22 is pending at the final send', async () => {
    const f = await fixture(kind)
    try {
      const port = f.port()
      const requests = await Promise.allSettled([port.fetch(f.request()), port.fetch(f.request())])
      expect(requests.filter((item) => item.status === 'fulfilled').length).toBe(1)
      const rejected = requests.find((item) => item.status === 'rejected')
      expect(await f.code(Promise.reject(rejected?.status === 'rejected' ? rejected.reason : null))).toBe(
        'unknown_effect/model_egress_replay',
      )
      expect(f.observations.length).toBe(1)
      let entered!: () => void, resume!: () => void
      const pending = new Promise<void>((resolve) => {
        entered = resolve
      })
      const released = new Promise<void>((resolve) => {
        resume = resolve
      })
      const waiting = f.port({
        secrets: {
          use: async (...args) => {
            entered()
            await released
            return f.broker.use(...args)
          },
        },
      })
      const refused = f.code(waiting.fetch(f.request()))
      await pending
      f.denyNetwork()
      resume()
      expect(await refused).toBe('denied/model_egress_network')
      expect(f.observations.length).toBe(1)
    } finally {
      await f.close()
    }
  })
  it('preserves literal IP pins, request quotas and the final owner callback fence', async () => {
    const f = await fixture(kind)
    try {
      const literalTarget = { ...f.target, host: '127.0.0.1' }
      const network = {
        ...f.options.network,
        rules: [{ ...f.networkRule, host: '127.0.0.1', addresses: ['127.0.0.2'] }],
        resolver: async () => [{ address: '127.0.0.2', family: 4 }],
      }
      const port = f.port({ endpoints: [{ ...f.endpoint, target: literalTarget }], network })
      expect(await f.code(port.fetch(f.request(f.url.replace('localhost', '127.0.0.1'))))).toBe(
        'denied/model_egress_dns',
      )
      expect(await f.code(f.port({ maxRequestBytes: 1 }).fetch(f.request()))).toBe(
        'denied/model_egress_limits',
      )
      for (const maxResponseBytes of [-1, NaN, 2 * 1024 * 1024 + 1])
        expect(await f.code(f.port({ maxResponseBytes }).fetch(f.request()))).toBe(
          'denied/model_egress_limits',
        )
      const mutable = { ...f.options.network }
      const shifted = f.port({
        network: mutable,
        current: () => {
          mutable.authorize = () => true
          return true
        },
      })
      expect(await f.code(shifted.fetch(f.request()))).toBe('denied/model_egress_binding')
      expect(f.observations).toEqual([])
    } finally {
      await f.close()
    }
  })
  it('rechecks the exact handle at send after resolution, purpose mismatch and durable revocation', async () => {
    const f = await fixture(kind)
    try {
      const wrongConsumer = { ...f.options.installation, consumer: { ...CONSUMER, purpose: 'mcp-oauth' } }
      expect(await f.code(f.port({ installation: wrongConsumer }).fetch(f.request()))).toBe(
        'denied/model_egress_credential',
      )
      const port = f.port()
      const key = await port.resolveCredential('local-model', f.call.signal)
      expect(key === f.key).toBe(true)
      must(await f.broker.revoke({ secretId: CONSUMER.secretId, reason: 'test' }, f.auth.call({}, true)))
      expect(await f.code(port.fetch(f.request()))).toBe('denied/model_egress_credential')
      expect(await f.code(port.resolveCredential('local-model', f.call.signal))).toBe(
        'denied/model_egress_credential',
      )
      expect(f.observations).toEqual([])
    } finally {
      await f.close()
    }
  })
  it('cancels before send and closes admission while DNS is pending', async () => {
    const f = await fixture(kind)
    try {
      const abort = new AbortController()
      abort.abort()
      expect(await f.code(f.port().fetch(f.request(f.url, { signal: abort.signal })))).toBe(
        'cancelled/model_egress_cancelled',
      )
      let began!: () => void
      const entered = new Promise<void>((resolve) => {
        began = resolve
      })
      const port = f.port({
        network: {
          ...f.options.network,
          resolver: async () => {
            began()
            return new Promise(() => {})
          },
        },
      })
      const result = f.code(port.fetch(f.request()))
      await entered
      await port.close()
      expect(await result).toBe('cancelled/model_egress_cancelled')
      expect(await f.code(port.fetch(f.request()))).toBe('denied/model_egress_closed')
      expect(f.observations).toEqual([])
    } finally {
      await f.close()
    }
  })
  it.each(['cancel', 'close'])(
    'keeps a %s after actual HTTP send unknown, drains and never resends',
    async (action) => {
      const f = await fixture(kind, 'openai-completions', '/hang')
      try {
        const abort = new AbortController(),
          port = f.port()
        const result = f.code(port.fetch(f.request(f.url, { signal: abort.signal })))
        await Promise.race([
          f.arrival,
          result.then(() => {
            throw new Error('Request failed before the peer was reached')
          }),
        ])
        if (action === 'cancel') abort.abort()
        else await port.close()
        expect(await result).toBe('unknown_effect/model_egress_unknown')
        expect(f.observations.length).toBe(1)
      } finally {
        await f.close()
      }
    },
  )
  it.each(['/redirect', '/echo-key'])(
    'blocks authentication redirects and secret response content at %s',
    async (path) => {
      const f = await fixture(kind, 'openai-completions', path)
      try {
        expect(await f.code(f.port().fetch(f.request()))).toBe(
          `denied/model_egress_${path === '/redirect' ? 'redirect' : 'response'}`,
        )
        expect(f.observations.length).toBe(1)
      } finally {
        await f.close()
      }
    },
  )
  it('sanitizes owner exceptions and refuses a key placed in public headers or body', async () => {
    const f = await fixture(kind)
    try {
      const port = f.port({
        network: {
          ...f.options.network,
          resolver: async () => {
            throw new Error(f.key)
          },
        },
      })
      expect(await f.code(port.fetch(f.request()))).toBe('retryable/model_egress_connect')
      expect(await f.code(f.port().fetch(f.request(f.url, { body: f.key })))).toBe(
        'denied/model_egress_headers',
      )
      expect(await f.code(f.port().fetch(f.request(f.url, { headers: { 'user-agent': f.key } })))).toBe(
        'denied/model_egress_headers',
      )
      expect(
        await f.code(f.port().fetch(f.request(f.url, { headers: { authorization: 'Bearer forged' } }))),
      ).toBe('denied/model_egress_credential')
      expect(f.observations).toEqual([])
    } finally {
      await f.close()
    }
  })
})

it('keeps reference source independent with at most half its nonblank lines shared', () => {
  const a = readFileSync(new URL('../../src/runtime/model/model-egress.ts', import.meta.url), 'utf8')
  const b = readFileSync(
    new URL('../../../../examples/runtime-reference/src/providers/model-egress.ts', import.meta.url),
    'utf8',
  )
  expect(b).not.toMatch(/from.*packages\/host|from.*model\/model-egress/)
  const lines = (source: string) =>
    new Set(
      source
        .split('\n')
        .map((line) => line.replace(/\s/g, ''))
        .filter(Boolean),
    )
  const one = lines(a),
    two = lines(b)
  expect([...one].filter((line) => two.has(line)).length / Math.min(one.size, two.size)).toBeLessThanOrEqual(
    0.5,
  )
})

it.each(['default', 'reference'] as const)(
  'cold %s consumer preserves key access and durable revocation in a fresh process',
  async (kind) => {
    expect(await coldModelEgress(kind)).toEqual({
      initialStatus: 200,
      refusal: 'denied/model_egress_credential',
      requests: 1,
    })
  },
)

it('cross-checks the same installed input, HTTP result and refusals between both independent transports', async () => {
  const f = await fixture('default')
  const first = createModelEgress(f.options, f.call)
  const second = createReferenceModelEgress(f.options, f.call)
  try {
    const outcomes = []
    for (const port of [first, second]) {
      const reply = await port.fetch(f.request())
      outcomes.push({ status: reply.status, content: await reply.text(), headers: [...reply.headers] })
    }
    expect(outcomes[0]).toEqual(outcomes[1])
    expect(f.observations.map((item) => item.correctKey)).toEqual([true, true])
    for (const target of [`${f.url}/wrong`, `${f.url}?changed=1`])
      expect(await f.code(first.fetch(f.request(target)))).toBe(await f.code(second.fetch(f.request(target))))
    f.retire()
    expect(await f.code(first.fetch(f.request()))).toBe(await f.code(second.fetch(f.request())))
    await first.close()
    await second.close()
    expect(await f.code(first.fetch(f.request()))).toBe(await f.code(second.fetch(f.request())))
  } finally {
    await first.close()
    await second.close()
    await f.close()
  }
})

// Exercise the real source store through deployment evidence, without a fetch wrapper hiding it.
it.each(['refused', 'dns', 'tls', 'policy', 'revoke', 'fence', 'normal', 'disconnect'] as const)(
  'connects the durable owner only at the boundary for %s',
  async (mode) => {
    const f = await modelJointFixture(
      'openai-completions',
      mode === 'refused' ? 'refused' : mode === 'disconnect' ? 'cut-silent' : 'normal',
      {},
      true,
      { store: true },
    )
    const tlsPeer =
      mode === 'tls'
        ? await modelFixture(
            'default',
            'openai-completions',
            undefined,
            CONSUMER,
            {},
            {
              scheme: 'https',
              host: '127.0.0.1',
            },
          )
        : undefined
    const options = { ...f.options }
    if (tlsPeer) {
      options.endpoints = [{ ...required(required(options.endpoints)[0]), target: tlsPeer.target }]
      options.network = { ...required(options.network), rules: [tlsPeer.networkRule] }
    }
    if (mode === 'dns')
      options.network = {
        ...required(f.options.network),
        resolver: async () => {
          throw new Error(f.key)
        },
      }
    if (mode === 'policy') options.network = { ...required(f.options.network), authorize: () => false }
    if (mode === 'revoke')
      options.secrets = {
        use: async (...args) => {
          must(
            await f.broker.revoke(
              { secretId: required(f.options.installation).handle.secretId, reason: 'test' },
              f.auth.call({}, true),
            ),
          )
          return required(f.options.secrets).use(...args)
        },
      }
    const owner = mode === 'fence' ? { ...f.owner, beforeSend: () => false } : f.owner
    const deployment = createHostModelAdapterDeployment(owner, [options])
    const fetch = required(required(deployment.egress)(f.source, f.frame, f.context))
    const store = required(f.store)
    const body = '{"model":"local","messages":[]}'
    try {
      const target = required(required(options.endpoints)[0]).target
      const url = `${target.scheme}://${target.host}:${target.port}${target.path}`
      const outcome = await deployment.withCredential(f.source, f.frame, f.context, async (marker) => {
        // Legacy preflight must not commit the fence before the connector either.
        expect(deployment.beforeSend(f.source, f.frame, f.context, '0'.repeat(64))).toBe(true)
        expect(store.admin.read(f.frame)).toBeUndefined()
        const job = fetch(url, {
          method: 'POST',
          body,
          headers: { authorization: `Bearer ${marker}`, 'content-type': 'application/json' },
        })
        if (mode === 'normal') expect((await job).status).toBe(200)
        else
          await expect(job).rejects.toMatchObject({
            code:
              mode === 'disconnect'
                ? 'unknown_effect'
                : ['refused', 'dns', 'tls'].includes(mode)
                  ? 'retryable'
                  : 'denied',
            detailCode:
              mode === 'disconnect'
                ? 'model_egress_unknown'
                : ['refused', 'dns', 'tls'].includes(mode)
                  ? 'model_egress_connect'
                  : mode === 'policy'
                    ? 'model_egress_network'
                    : mode === 'revoke'
                      ? 'model_egress_credential'
                      : 'model_egress_fence',
          })
      })
      expect(outcome.ok).toBe(true)
      const connected = ['normal', 'disconnect'].includes(mode)
      expect(required(fetch.fenced)()).toBe(connected)
      const row = store.admin.read(f.frame)
      expect(store.admin.pending()).toHaveLength(connected ? 1 : 0)
      if (connected) {
        expect(row).toMatchObject({
          state: 'sent_unsaved',
          bodyDigest: createHash('sha256').update(body).digest('hex'),
        })
        expect(f.hashes).toHaveLength(1)
      } else {
        expect(row).toBeUndefined()
        expect(f.hashes).toEqual([])
        expect(f.peerStats.bytes).toBe(0)
        expect(f.observations).toEqual([])
        expect(required(fetch.refusal)()).toBeDefined()
        expect(await store.deployment.lookup(f.frame, [], f.context, null)).toMatchObject({
          kind: 'not_found',
          safeToRetry: false,
        })
      }
      if (tlsPeer) expect(tlsPeer.stats.bytes).toBe(0)
      expect(JSON.stringify({ refusal: required(fetch.refusal)(), row })).not.toContain(f.key)
    } finally {
      await f.close()
      await tlsPeer?.close()
    }
  },
)
