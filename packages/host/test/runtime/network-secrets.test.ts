import { describe, expect, it } from 'vitest'
import {
  action,
  boundary,
  cleanup,
  consumer,
  error,
  inline,
  must,
  network,
  refreshInput,
  request,
  resolveInput,
  rule,
  scan,
  scope,
  scratch,
  secrets,
  selected,
} from './network-secrets-fixture.js'

describe.each(['default', 'reference'] as const)('%s secret broker', (kind) => {
  it('selects its binding, refuses missing features and closes through the selected container', async () => {
    const root = scratch()
    const auth = boundary()
    const broker = secrets(kind, root, auth)
    try {
      await selected(broker)
      expect(error(await broker.resolve(resolveInput, auth.call()))).toBe('denied/secret_closed')
    } finally {
      await broker.close()
      cleanup(root)
    }
  })
  it('keeps handles nonbearer across principals, scopes, tenant, audience, purpose and forged contexts', async () => {
    const root = scratch()
    const auth = boundary()
    const broker = secrets(kind, root, auth)
    const diagnostics: unknown[] = []
    try {
      const call = auth.call()
      const locator = must(await broker.resolve(resolveInput, call))
      let exposures = 0
      const consume = () => {
        exposures += 1
      }
      for (const context of [
        { ...call },
        auth.call({ principalRef: 'other' }),
        auth.call({ scope: { ...scope, workspaceId: 'other' } as typeof scope }),
        auth.call({ scope: { kind: 'runtime', installationId: 'install', runtimeId: 'runtime' } }),
      ])
        diagnostics.push(await broker.use(locator, consumer, context, consume))
      for (const patch of [
        { audience: 'other' },
        { purpose: 'other' },
        { serverRef: 'other' },
        { accountRef: 'other' },
        { consumer: 'model' as const },
      ])
        diagnostics.push(await broker.use(locator, { ...consumer, ...patch }, auth.call(), consume))
      diagnostics.push(await broker.use({ ...locator, handleId: 'forged' }, consumer, auth.call(), consume))
      diagnostics.push(await broker.use({ ...locator, token: 'not-real' }, consumer, auth.call(), consume))
      auth.tenant('foreign')
      diagnostics.push(await broker.use(locator, consumer, auth.call(), consume))
      expect(diagnostics.every((item) => !(item as { ok: boolean }).ok)).toBe(true)
      expect(exposures).toBe(0)
      auth.tenant('tenant')
      must(
        await broker.use(JSON.parse(JSON.stringify(locator)), consumer, auth.call(), (value) => {
          expect(value === 'not-real').toBe(true)
        }),
      )
      auth.revoke()
      expect(error(await broker.use(locator, consumer, auth.call(), consume))).toBe('denied/secret_denied')
      scan(root, ['not-real', 'rotated'], diagnostics)
    } finally {
      await broker.close()
      cleanup(root)
    }
  })
  it('invalidates exact versions immediately on rotation, expiry and durable revocation', async () => {
    const root = scratch()
    const auth = boundary()
    let now = Date.now()
    let broker = secrets(kind, root, auth, { now: () => now, handleMs: 50 })
    try {
      const first = must(await broker.resolve(resolveInput, auth.call()))
      expect(
        error(
          await broker.rotate({ secretId: 'credential', newVersionRef: 'secret://fixture/new' }, auth.call()),
        ),
      ).toBe('denied/secret_maintenance')
      expect(
        must(
          await broker.rotate(
            { secretId: 'credential', newVersionRef: 'secret://fixture/new' },
            auth.call({}, true),
          ),
        ).revision,
      ).toBe(2)
      expect(
        error(
          await broker.use(first, consumer, auth.call(), () => {
            throw new Error('must not expose')
          }),
        ),
      ).toBe('denied/secret_handle')
      const second = must(await broker.resolve(resolveInput, auth.call()))
      must(
        await broker.use(second, consumer, auth.call(), (value) => {
          expect(value === 'rotated').toBe(true)
        }),
      )
      now += 51
      expect(error(await broker.use(second, consumer, auth.call(), () => {}))).toBe('denied/secret_handle')
      expect(
        must(await broker.revoke({ secretId: 'credential', reason: 'test' }, auth.call({}, true))).revision,
      ).toBe(3)
      await broker.close()
      broker = secrets(kind, root, auth, { now: () => now })
      expect(error(await broker.resolve(resolveInput, auth.call()))).toBe('denied/secret_revoked')
      expect(
        must(await broker.revoke({ secretId: 'credential', reason: 'test' }, auth.call({}, true))).revision,
      ).toBe(3)
      scan(root, ['not-real', 'rotated'], [])
    } finally {
      await broker.close()
      cleanup(root)
    }
  })
  it('refuses a foreign tenant after durable reopen even with the same principal and scope identifiers', async () => {
    const root = scratch()
    const auth = boundary()
    const first = secrets(kind, root, auth)
    const locator = must(await first.resolve(resolveInput, auth.call()))
    await first.close()
    auth.tenant('foreign')
    let foreign: ReturnType<typeof secrets> | undefined
    try {
      if (kind === 'default')
        expect(() => secrets(kind, root, auth, { tenantId: 'foreign' })).toThrow('Broker ownership mismatch')
      else {
        foreign = secrets(kind, root, auth, { tenantId: 'foreign' })
        expect(
          error(
            await foreign.use(locator, consumer, auth.call(), () => {
              throw new Error('Forbidden exposure')
            }),
          ),
        ).toBe('denied/secret_catalogue')
      }
    } finally {
      await foreign?.close()
      cleanup(root)
    }
  })
  it('interrupts an unavailable identity port when disposal closes admission', async () => {
    const root = scratch()
    const auth = boundary()
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const broker = secrets(kind, root, auth, {
      identity: {
        resolve: async () => {
          entered()
          return new Promise(() => {})
        },
      },
    })
    try {
      const pending = broker.resolve(resolveInput, auth.call())
      await started
      await broker.close()
      expect(error(await pending)).toBe('cancelled/secret_cancelled')
    } finally {
      await broker.close()
      cleanup(root)
    }
  })
  it('refuses cancellation before exposure, drains cooperative consumers and sanitizes thrown material', async () => {
    const root = scratch()
    const auth = boundary()
    const broker = secrets(kind, root, auth)
    try {
      const locator = must(await broker.resolve(resolveInput, auth.call()))
      const abort = new AbortController()
      abort.abort()
      expect(
        error(
          await broker.use(locator, consumer, auth.call({ signal: abort.signal }), () => {
            throw new Error('must not expose')
          }),
        ),
      ).toBe('cancelled/secret_cancelled')
      const failed = await broker.use(locator, consumer, auth.call(), (value) => {
        throw new Error(value)
      })
      expect(error(failed)).toBe('denied/secret_unavailable')
      scan(root, ['not-real', 'rotated'], [failed])
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      let drained = false
      const operation = broker.use(locator, consumer, auth.call(), async (_value, signal) => {
        entered()
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              drained = true
              resolve()
            },
            { once: true },
          ),
        )
      })
      await started
      await broker.close()
      expect(drained).toBe(true)
      expect(error(await operation)).toBe('cancelled/secret_cancelled')
    } finally {
      await broker.close()
      cleanup(root)
    }
  })
})

describe.each(['default', 'reference'] as const)('%s network admission', (kind) => {
  it('refuses scope, forged identity, conflicting deny and malformed headers before DNS', async () => {
    const root = scratch()
    const auth = boundary()
    let resolutions = 0
    const service = network(kind, root, auth, [rule(1234), rule(1234, { effect: 'deny' })], {
      resolver: (async () => {
        resolutions += 1
        return []
      }) as never,
    })
    try {
      expect(error(await service.request(request(1234), auth.call()))).toBe('denied/network_denied')
      expect(error(await service.request(request(1234), { ...auth.call() }))).toBe('denied/network_denied')
      expect(
        error(
          await service.request(
            request(1234),
            auth.call({ scope: { ...scope, workspaceId: 'other' } as typeof scope }),
          ),
        ),
      ).toBe('denied/network_denied')
      expect(
        error(
          await service.request(request(1234, '/x', { headers: inline({ host: 'other' }) }), auth.call()),
        ),
      ).toBe('invalid_input/network_headers')
      expect(resolutions).toBe(0)
    } finally {
      await service.close()
      cleanup(root)
    }
  })
})

it('reports reference OAuth limitations instead of falling back to default code', async () => {
  const root = scratch()
  const auth = boundary()
  const broker = secrets('reference', root, auth)
  try {
    expect(broker.features.includes('refresh')).toBe(false)
    expect(error(await broker.refresh(refreshInput, action(auth.call())))).toBe(
      'incompatible/secret_refresh_unsupported',
    )
    expect(error(await broker.exchange({}, action(auth.call())))).toBe(
      'incompatible/secret_exchange_unsupported',
    )
    expect(error(await broker.acceptCallback({}, auth.ingress()))).toBe(
      'incompatible/secret_callback_unsupported',
    )
  } finally {
    await broker.close()
    cleanup(root)
  }
})
