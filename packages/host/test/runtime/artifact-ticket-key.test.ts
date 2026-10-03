import { describe, expect, it } from 'vitest'
import {
  nonceBytes,
  ticketAAD,
  ticketBinding,
  ticketBoundary,
  ticketBroker,
} from './artifact-ticket-key-fixture.js'
import { ticketScenario } from './artifact-ticket-key-scenarios.js'
import { cleanup, error, must, scratch } from './network-secrets-fixture.js'

describe.each(['default', 'reference'] as const)('%s restricted ticket material', (kind) => {
  it.each(['select', 'normal', 'deny', 'cancel', 'dispose'] as const)('%s contract', async (scenario) => {
    await ticketScenario(kind, scenario)
  })
  it('preserves the winning envelope when two brokers seal the same ticket concurrently', async () => {
    const root = scratch()
    const auth = ticketBoundary()
    const first = ticketBroker(kind, root, auth)
    const second = ticketBroker(kind, root, auth)
    try {
      const input = { binding: ticketBinding, aad: ticketAAD(), nonce: nonceBytes() }
      const outcomes = await Promise.all([
        first.port.sealNonce(input, auth.delegate()),
        second.port.sealNonce(input, auth.delegate()),
      ])
      const winner = outcomes.find((value) => value.ok)
      const loser = outcomes.find((value) => !value.ok)
      expect(winner).toBeDefined()
      expect(loser && error(loser)).toBe('conflict/ticket_exists')
      if (!winner) throw new Error('Missing committed envelope')
      const envelope = must(winner)
      for (const port of [first.port, second.port]) {
        expect(
          Buffer.from(
            must(
              await port.openNonce({ binding: ticketBinding, aad: ticketAAD(), envelope }, auth.delegate()),
            ),
          ),
        ).toEqual(nonceBytes())
      }
    } finally {
      await first.broker.close()
      await second.broker.close()
      cleanup(root)
    }
  })
  it('requires a configured delegation verifier and the installed owner', async () => {
    const root = scratch()
    const auth = ticketBoundary()
    const denied = ticketBroker(kind, `${root}/missing`, auth, { authorize: undefined })
    const owner = ticketBroker(kind, `${root}/owner`, auth, {
      installation: {
        binding: ticketBinding,
        ownerId: 'other-owner',
        principalRef: 'actor',
        bindingId: 'consumer-binding',
        scope: auth.delegate().scope,
        authorityId: 'selected-blob',
      },
    })
    try {
      const input = { binding: ticketBinding, aad: ticketAAD(), nonce: nonceBytes() }
      expect(error(await denied.port.sealNonce(input, auth.delegate()))).toBe('denied/ticket_delegation')
      expect(error(await owner.port.sealNonce(input, auth.delegate()))).toBe('denied/ticket_delegation')
    } finally {
      await denied.broker.close()
      await owner.broker.close()
      cleanup(root)
    }
  })
  it('refuses revocation during verification and disposal of pending work', async () => {
    for (const revoke of [true, false]) {
      const root = scratch()
      const auth = ticketBoundary()
      let release!: (value: boolean) => void
      let notify!: () => void
      const reached = new Promise<void>((resolve) => {
        notify = resolve
      })
      const instance = ticketBroker(kind, root, auth, {
        authorize: async () => {
          notify()
          return new Promise<boolean>((resolve) => {
            release = resolve
          })
        },
      })
      try {
        const request = { binding: ticketBinding, aad: ticketAAD(), nonce: nonceBytes() }
        const pending = instance.port.sealNonce(request, auth.delegate())
        await reached
        if (revoke) {
          must(
            await instance.broker.revoke(
              { secretId: 'ticket-key', reason: 'emergency' },
              auth.call({}, true),
            ),
          )
          release(true)
          expect(error(await pending)).toBe('denied/ticket_revoked')
        } else {
          await instance.broker.close()
          expect(error(await pending)).toBe('cancelled/ticket_cancelled')
          release(true)
          expect(error(await instance.port.sealNonce(request, auth.delegate()))).toBe('denied/ticket_closed')
        }
      } finally {
        release?.(true)
        await instance.broker.close()
        cleanup(root)
      }
    }
  })
  it('cancels a pending verifier without writing an issuance and checks current identity on open', async () => {
    const root = scratch()
    const auth = ticketBoundary()
    let unblock!: (value: boolean) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let delayed = true
    const instance = ticketBroker(kind, root, auth, {
      authorize: async (call, installed) => {
        if (delayed) {
          delayed = false
          entered()
          return new Promise<boolean>((resolve) => {
            unblock = resolve
          })
        }
        return auth.authorize(call, installed)
      },
    })
    try {
      const abort = new AbortController()
      const request = { binding: ticketBinding, aad: ticketAAD(), nonce: nonceBytes() }
      const pending = instance.port.sealNonce(request, auth.delegate({ signal: abort.signal }))
      await started
      abort.abort()
      expect(error(await pending)).toBe('cancelled/ticket_cancelled')
      unblock(true)
      const envelope = must(await instance.port.sealNonce(request, auth.delegate()))
      auth.revoke()
      expect(
        error(
          await instance.port.openNonce(
            { binding: ticketBinding, aad: ticketAAD(), envelope },
            auth.delegate(),
          ),
        ),
      ).toBe('denied/ticket_delegation')
    } finally {
      unblock?.(true)
      await instance.broker.close()
      cleanup(root)
    }
  })
})
