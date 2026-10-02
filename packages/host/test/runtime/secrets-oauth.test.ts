import { canonicalJsonDigest } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  action,
  boundary,
  cleanup,
  consumer,
  error,
  must,
  refreshInput,
  resolveInput,
  scan,
  scope,
  scratch,
  secrets,
} from './network-secrets-fixture.js'

function flow() {
  return {
    flowId: 'flow',
    stateDigest: canonicalJsonDigest('expected-state'),
    redirectUri: 'http://localhost/callback',
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    grant: { principalRef: 'actor', scope, binding: consumer },
  }
}
const callback = {
  flowId: 'flow',
  state: 'expected-state',
  authorizationCode: 'bad-code',
  redirectUri: 'http://localhost/callback',
}

describe('restricted credential effects', () => {
  it('does not publish a renewal after maintenance changes the credential revision and restores its version label', async () => {
    const root = scratch()
    const auth = boundary()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const broker = secrets('default', root, auth, {
      refresh: async () => {
        entered()
        await held
        return { state: 'ready', newVersionRef: 'secret://fixture/new' }
      },
    })
    try {
      const pending = broker.refresh(refreshInput, action(auth.call()))
      await started
      must(
        await broker.rotate(
          { secretId: 'credential', newVersionRef: 'secret://fixture/new' },
          auth.call({}, true),
        ),
      )
      expect(
        must(
          await broker.rotate(
            { secretId: 'credential', newVersionRef: 'secret://fixture/old' },
            auth.call({}, true),
          ),
        ).revision,
      ).toBe(3)
      release()
      expect(error(await pending)).toBe('conflict/secret_version')
      expect(must(await broker.refresh(refreshInput, action(auth.call()))).state).toBe('unknown')
      expect(error(await broker.resolve(resolveInput, auth.call()))).toBe('denied/secret_refresh_pending')
    } finally {
      release()
      await broker.close()
      cleanup(root)
    }
  })
  it('serializes refresh per credential, CASes the old version and replays the same ready result', async () => {
    const root = scratch()
    const auth = boundary()
    let start!: () => void
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    let finish!: () => void
    const release = new Promise<void>((resolve) => {
      finish = resolve
    })
    let sends = 0
    const broker = secrets('default', root, auth, {
      refresh: async (_input, _context, signal) => {
        sends += 1
        start()
        await release
        signal.throwIfAborted()
        return { state: 'ready', newVersionRef: 'secret://fixture/new' }
      },
    })
    try {
      const old = must(await broker.resolve(resolveInput, auth.call()))
      const pending = broker.refresh(refreshInput, action(auth.call()))
      await started
      expect(must(await broker.refresh(refreshInput, action(auth.call()))).state).toBe('unknown')
      expect(error(await broker.refresh({ ...refreshInput, requestId: 'second' }, action(auth.call())))).toBe(
        'conflict/secret_refresh_pending',
      )
      expect(
        error(
          await broker.use(old, consumer, auth.call(), () => {
            throw new Error('Forbidden exposure')
          }),
        ),
      ).toBe('denied/secret_refresh_pending')
      finish()
      const ready = must(await pending)
      expect(ready.state).toBe('ready')
      expect(ready.handle?.version).toBe('v2')
      expect(must(await broker.refresh(refreshInput, action(auth.call())))).toEqual(ready)
      expect(sends).toBe(1)
      expect(error(await broker.refresh({ ...refreshInput, audience: 'other' }, action(auth.call())))).toBe(
        'denied/secret_denied',
      )
      expect(error(await broker.refresh({ ...refreshInput, requestId: 'stale' }, action(auth.call())))).toBe(
        'conflict/secret_version',
      )
      expect(error(await broker.use(old, consumer, auth.call(), () => {}))).toBe('denied/secret_handle')
      must(
        await broker.use(ready.handle, consumer, auth.call(), (value) => {
          expect(value === 'rotated').toBe(true)
        }),
      )
      scan(root, ['not-real', 'rotated'], [ready])
    } finally {
      finish()
      await broker.close()
      cleanup(root)
    }
  })
  it('leaves uncertain renewal locked, sanitizes material-bearing failures and refuses wrong consumer bindings before effects', async () => {
    const root = scratch()
    const auth = boundary()
    let sends = 0
    const broker = secrets('default', root, auth, {
      refresh: async () => {
        sends += 1
        throw new Error('not-real')
      },
    })
    try {
      const denied = await broker.refresh({ ...refreshInput, serverRef: 'other' }, action(auth.call()))
      expect(error(denied)).toBe('denied/secret_consumer')
      expect(sends).toBe(0)
      const unresolved = must(await broker.refresh(refreshInput, action(auth.call())))
      expect(unresolved.state).toBe('unknown')
      expect(unresolved.handle).toBeNull()
      expect(must(await broker.refresh(refreshInput, action(auth.call())))).toEqual(unresolved)
      expect(sends).toBe(1)
      expect(error(await broker.resolve(resolveInput, auth.call()))).toBe('denied/secret_refresh_pending')
      scan(root, ['not-real', 'rotated'], [denied, unresolved])
    } finally {
      await broker.close()
      cleanup(root)
    }
  })
  it('encrypts single-use callback escrow, checks ingress/state/redirect/owner and exchanges only the locked version', async () => {
    const root = scratch()
    const auth = boundary()
    let sends = 0
    const definition = flow()
    let broker = secrets('default', root, auth, {
      flows: [definition],
      trustedIngress: auth.trustedIngress,
      exchange: async (_input, code) => {
        sends += 1
        expect(Buffer.from(code).toString() === 'bad-code').toBe(true)
        return { state: 'ready', newVersionRef: 'secret://fixture/new' }
      },
    })
    try {
      const denied = []
      for (const input of [
        { ...callback, state: 'wrong' },
        { ...callback, redirectUri: 'http://other/callback' },
        { ...callback, flowId: 'other' },
      ])
        denied.push(await broker.acceptCallback(input, auth.ingress()))
      denied.push(await broker.acceptCallback(callback, { ...auth.ingress() }))
      expect(denied.every((outcome) => !outcome.ok)).toBe(true)
      const escrow = must(await broker.acceptCallback(callback, auth.ingress()))
      expect(Object.keys(escrow).sort()).toEqual(['escrowId', 'flowId'])
      expect(error(await broker.acceptCallback(callback, auth.ingress()))).toBe(
        'denied/secret_callback_replay',
      )
      scan(root, ['bad-code', 'not-real', 'rotated'], [escrow, denied])
      await broker.close()
      broker = secrets('default', root, auth, {
        flows: [definition],
        trustedIngress: auth.trustedIngress,
        exchange: async (_input, code) => {
          sends += 1
          expect(Buffer.from(code).toString() === 'bad-code').toBe(true)
          return { state: 'ready', newVersionRef: 'secret://fixture/new' }
        },
      })
      const input = {
        requestId: 'exchange',
        flowId: 'flow',
        escrowId: escrow.escrowId,
        expectedVersion: 'v1',
        audience: consumer.audience,
        accountRef: 'account',
        serverRef: 'server',
      }
      expect(error(await broker.exchange(input, action(auth.call({ principalRef: 'other' }))))).toBe(
        'denied/secret_denied',
      )
      expect(error(await broker.exchange({ ...input, serverRef: 'other' }, action(auth.call())))).toBe(
        'denied/secret_consumer',
      )
      expect(sends).toBe(0)
      const ready = must(await broker.exchange(input, action(auth.call())))
      expect(ready.state).toBe('ready')
      expect(ready.handle?.version).toBe('v2')
      expect(must(await broker.exchange(input, action(auth.call())))).toEqual(ready)
      expect(sends).toBe(1)
      expect(error(await broker.exchange({ ...input, requestId: 'different' }, action(auth.call())))).toBe(
        'denied/secret_escrow',
      )
      scan(root, ['bad-code', 'not-real', 'rotated'], [ready])
    } finally {
      await broker.close()
      cleanup(root)
    }
  })
  it('cannot transfer an existing callback to a replacement flow owner when the broker reopens', async () => {
    const root = scratch()
    const auth = boundary()
    const definition = flow()
    const original = secrets('default', root, auth, {
      flows: [definition],
      trustedIngress: auth.trustedIngress,
      exchange: async () => ({ state: 'ready', newVersionRef: 'secret://fixture/new' }),
    })
    const escrow = must(await original.acceptCallback(callback, auth.ingress()))
    await original.close()
    let dispatched = false
    const replacement = { ...definition, grant: { ...definition.grant, principalRef: 'other' } }
    const broker = secrets('default', root, auth, {
      grants: [replacement.grant],
      flows: [replacement],
      trustedIngress: auth.trustedIngress,
      exchange: async () => {
        dispatched = true
        return { state: 'ready', newVersionRef: 'secret://fixture/new' }
      },
    })
    try {
      expect(
        error(
          await broker.exchange(
            {
              requestId: 'exchange',
              ...escrow,
              expectedVersion: 'v1',
              audience: consumer.audience,
              accountRef: 'account',
              serverRef: 'server',
            },
            action(auth.call({ principalRef: 'other' })),
          ),
        ),
      ).toBe('denied/secret_flow')
      expect(dispatched).toBe(false)
      scan(root, ['bad-code', 'not-real', 'rotated'], [])
    } finally {
      await broker.close()
      cleanup(root)
    }
  })
  it('provisions the first credential through a null-version exchange and rejects expired flow ingress', async () => {
    const root = scratch()
    const auth = boundary()
    const definition = flow()
    let now = Date.now()
    const broker = secrets('default', root, auth, {
      now: () => now,
      entries: [
        {
          secretId: 'credential',
          initialVersion: null,
          versions: [{ version: 'v1', ref: 'secret://fixture/old' }],
        },
      ],
      flows: [definition],
      trustedIngress: auth.trustedIngress,
      exchange: async () => ({ state: 'ready', newVersionRef: 'secret://fixture/old' }),
    })
    try {
      expect(error(await broker.resolve(resolveInput, auth.call()))).toBe('denied/secret_not_provisioned')
      const escrow = must(await broker.acceptCallback(callback, auth.ingress()))
      const ready = must(
        await broker.exchange(
          {
            requestId: 'first',
            ...escrow,
            expectedVersion: null,
            audience: consumer.audience,
            accountRef: 'account',
            serverRef: 'server',
          },
          action(auth.call()),
        ),
      )
      expect(ready.handle?.version).toBe('v1')
      must(await broker.use(ready.handle, consumer, auth.call(), () => {}))
      now = Date.parse(definition.expiresAt) + 1
      expect(error(await broker.acceptCallback(callback, auth.ingress()))).toBe('denied/secret_callback')
      scan(root, ['bad-code', 'not-real'], [ready])
    } finally {
      await broker.close()
      cleanup(root)
    }
  })
})
