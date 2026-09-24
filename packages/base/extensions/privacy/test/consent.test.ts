import { createHash } from 'node:crypto'
import type { ExtensionAPI, HookContext } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import {
  allowsContent,
  allowsUpload,
  canTransition,
  changeConsent,
  transitionConsent,
} from '../src/consent.js'
import { egressReceipt } from '../src/egress.js'
import {
  createPrivacyExtension,
  createSessionEgressGate,
  EgressCommitError,
  privacyExtension,
  recordEgress,
  sessionEgressAuthority,
} from '../src/index.js'

function eventApi(events: unknown[]): ExtensionAPI {
  return {
    events: {
      append: async (name: string, data: unknown) => {
        events.push([name, data])
        return 1
      },
    },
  } as unknown as ExtensionAPI
}

async function activeApi(
  events: unknown[],
  consent: 'DISABLED' | 'LOCAL' | 'ANON' | 'FULL',
  append?: (name: string, data: unknown) => Promise<number>,
) {
  const handlers = new Map<string, (payload: unknown, context: HookContext) => unknown>()
  const api = {
    events: {
      append:
        append ??
        (async (name: string, data: unknown) => {
          events.push([name, data])
          return events.length
        }),
    },
    registerHook: (event: string, handler: (payload: unknown, context: HookContext) => unknown) => {
      handlers.set(event, handler)
      return () => undefined
    },
  } as unknown as ExtensionAPI
  const dispose = privacyExtension(api)
  const session = Object.freeze({
    key: `s-${consent}-${Math.random()}`,
    lane: 'main',
    workspaceRoot: '/workspace',
    telemetryConsent: consent,
    telemetryConsentPendingAudit: true,
  })
  const context = { session } as HookContext
  await handlers.get('session_start')?.({ preset: 'standard' }, context)
  return { api, handlers, session, context, dispose }
}

describe('consent', () => {
  it('allows every downgrade, stepwise upgrades, and a direct upgrade to ANON', () => {
    expect(canTransition('FULL', 'DISABLED')).toEqual({ ok: true })
    expect(canTransition('FULL', 'LOCAL')).toEqual({ ok: true })
    expect(canTransition('DISABLED', 'LOCAL')).toEqual({ ok: true })
    expect(canTransition('DISABLED', 'ANON')).toEqual({ ok: true })
    expect(canTransition('DISABLED', 'FULL')).toMatchObject({ ok: false })
    expect(canTransition('LOCAL', 'FULL')).toMatchObject({ ok: false })
    expect(canTransition('ANON', 'FULL')).toEqual({ ok: true })
  })

  it('requires explicit consent whenever FULL is selected', () => {
    expect(transitionConsent('ANON', 'FULL', { explicit: false, by: 'alice' })).toEqual({
      ok: false,
      reason: 'FULL requires explicit consent',
    })
    expect(transitionConsent('ANON', 'FULL', { explicit: true, by: 'alice' })).toEqual({
      ok: true,
    })
  })

  it('gates upload and content independently', () => {
    expect(allowsUpload('LOCAL')).toBe(false)
    expect(allowsUpload('ANON')).toBe(true)
    expect(allowsContent('ANON')).toBe(false)
    expect(allowsContent('FULL')).toBe(true)
  })

  it('changeConsent appends only accepted transitions', async () => {
    const events: unknown[] = []
    const api = eventApi(events)

    expect(await changeConsent(api, 'ANON', 'FULL', 'alice', false)).toMatchObject({ ok: false })
    expect(await changeConsent(api, 'DISABLED', 'FULL', 'alice', true)).toMatchObject({ ok: false })
    expect(await changeConsent(api, 'ANON', 'FULL', 'alice', true)).toEqual({ ok: true })
    expect(events).toEqual([['consent', { from: 'ANON', to: 'FULL', by: 'alice' }]])
  })
})

describe('egress receipts', () => {
  it('hashes bytes and chains each receipt to its predecessor', () => {
    const firstBytes = new Uint8Array([1])
    const secondBytes = new Uint8Array([2])
    const a = egressReceipt(null, firstBytes, 'ANON')
    const b = egressReceipt(a.chain, secondBytes, 'ANON')

    const sha256 = createHash('sha256').update(firstBytes).digest('hex')
    expect(a).toEqual({
      sha256,
      bytes: 1,
      consent: 'ANON',
      prev: null,
      chain: createHash('sha256').update(sha256).digest('hex'),
    })
    expect(b.prev).toBe(a.chain)
    expect(b.chain).not.toBe(a.chain)
  })

  it('records the exact receipt as an egress event', async () => {
    const events: unknown[] = []
    const bytes = new Uint8Array([1, 2, 3])
    const receipt = await recordEgress(eventApi(events), null, bytes, 'FULL')
    expect(events).toEqual([['egress', receipt]])
  })

  it('redacts ANON output, sends before receipt, and advances the receipt chain', async () => {
    const events: unknown[] = []
    const sent: string[] = []
    const { api, session } = await activeApi(events, 'ANON')
    const gate = createSessionEgressGate(api, session)
    const first = await gate.send('email alice@example.com', async (bytes) => {
      sent.push(new TextDecoder().decode(bytes))
    })
    const second = await gate.send('safe', async (bytes) => {
      sent.push(new TextDecoder().decode(bytes))
    })
    expect(sent).toEqual(['email [REDACTED:email]', 'safe'])
    expect(second.receipt.prev).toBe(first.receipt.chain)
    expect(events).toEqual([
      ['consent', { from: 'DISABLED', to: 'ANON', by: 'profile:standard' }],
      ['egress', first.receipt],
      ['egress', second.receipt],
    ])
  })

  it('denies upload without consent and records nothing when the sender fails', async () => {
    const deniedEvents: unknown[] = []
    const denied = await activeApi(deniedEvents, 'LOCAL')
    await expect(
      createSessionEgressGate(denied.api, denied.session).send('x', async () => undefined),
    ).rejects.toThrow(/does not allow upload/)
    expect(deniedEvents).toEqual([['consent', { from: 'DISABLED', to: 'LOCAL', by: 'profile:standard' }]])

    const failedEvents: unknown[] = []
    const failed = await activeApi(failedEvents, 'FULL')
    const gate = createSessionEgressGate(failed.api, failed.session)
    await expect(
      gate.send('x', async () => {
        throw new Error('offline')
      }),
    ).rejects.toThrow('offline')
    expect(failedEvents).toEqual([['consent', { from: 'DISABLED', to: 'FULL', by: 'profile:standard' }]])
    await expect(gate.send('retry', async () => undefined)).resolves.toBeDefined()
  })

  it('cannot mint FULL authority from a caller-supplied session value', async () => {
    const events: unknown[] = []
    const active = await activeApi(events, 'ANON')
    const copiedIdentity = {
      key: active.session.key,
      lane: active.session.lane,
      workspaceRoot: active.session.workspaceRoot,
      telemetryConsent: 'FULL' as const,
    }
    expect(() => createSessionEgressGate(active.api, copiedIdentity)).toThrow('egress session is not active')
  })

  it('binds authority to both the exact API instance and exact session reference', async () => {
    const first = await activeApi([], 'FULL')
    const second = await activeApi([], 'FULL')
    expect(() => createSessionEgressGate(second.api, first.session)).toThrow('egress session is not active')
    expect(() => createSessionEgressGate(first.api, second.session)).toThrow('egress session is not active')
    await expect(
      createSessionEgressGate(first.api, first.session).send('owned', async () => undefined),
    ).resolves.toBeDefined()
  })

  it('authorizes only gates minted by the active privacy state', async () => {
    const active = await activeApi([], 'FULL')
    const gate = createSessionEgressGate(active.api, active.session)
    expect(() => sessionEgressAuthority.assert(gate)).not.toThrow()
    expect(() => sessionEgressAuthority.assert({ ...gate })).toThrow('not minted by privacy')
  })

  it('serializes concurrent sends into one receipt chain', async () => {
    const events: unknown[] = []
    const active = await activeApi(events, 'FULL')
    const gate = createSessionEgressGate(active.api, active.session)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent: string[] = []
    const first = gate.send('first', async () => {
      sent.push('first')
      await blocked
    })
    const second = gate.send('second', async () => {
      sent.push('second')
    })
    await Promise.resolve()
    expect(sent).toEqual(['first'])
    release()
    const [a, b] = await Promise.all([first, second])
    expect(sent).toEqual(['first', 'second'])
    expect(b.receipt.prev).toBe(a.receipt.chain)
  })

  it('shares ordering, chain head, and poison state across every gate for one session', async () => {
    const events: unknown[] = []
    const active = await activeApi(events, 'FULL')
    const firstGate = createSessionEgressGate(active.api, active.session)
    const secondGate = createSessionEgressGate(active.api, active.session)
    const first = await firstGate.send('first', async () => undefined)
    const second = await secondGate.send('second', async () => undefined)
    expect(second.receipt.prev).toBe(first.receipt.chain)

    let fail = false
    const failing = await activeApi([], 'FULL', async () => {
      if (fail) throw new Error('ledger unavailable')
      fail = true
      return 1
    })
    const poisoned = createSessionEgressGate(failing.api, failing.session)
    const sibling = createSessionEgressGate(failing.api, failing.session)
    await expect(poisoned.send('sent', async () => undefined)).rejects.toBeInstanceOf(EgressCommitError)
    await expect(sibling.send('blocked', async () => undefined)).rejects.toBeInstanceOf(EgressCommitError)
  })

  it('marks a post-send receipt failure as non-retryable and poisons the gate', async () => {
    let sends = 0
    let appends = 0
    const active = await activeApi([], 'FULL', async () => {
      if (appends++ > 0) throw new Error('ledger unavailable')
      return 1
    })
    const gate = createSessionEgressGate(active.api, active.session)
    const error = await gate
      .send('once', async () => {
        sends++
      })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EgressCommitError)
    expect(error).toMatchObject({ sent: true, retrySafe: false })
    await expect(
      gate.send('twice', async () => {
        sends++
      }),
    ).rejects.toBe(error)
    expect(sends).toBe(1)
  })
})

describe('privacy extension lifecycle', () => {
  it('restores the durable receipt head before the next lifecycle sends', async () => {
    const events: unknown[] = []
    const handlers = new Map<string, (payload: unknown, context: HookContext) => unknown>()
    const previous = 'a'.repeat(64)
    const api = {
      events: {
        append: async (name: string, data: unknown) => {
          events.push([name, data])
          return events.length
        },
      },
      registerHook: (event: string, handler: (payload: unknown, context: HookContext) => unknown) => {
        handlers.set(event, handler)
        return () => undefined
      },
    } as unknown as ExtensionAPI
    createPrivacyExtension({
      trajectory: {
        previous: async () => previous,
        upload: async (_session, gate) => {
          await gate.send('continued', async () => undefined)
        },
      },
    })(api)
    const session = Object.freeze({
      key: 'resumed',
      lane: 'main',
      telemetryConsent: 'FULL' as const,
      telemetryConsentPendingAudit: false,
    })
    const context = { session, signal: new AbortController().signal } as HookContext
    await handlers.get('session_start')?.({ preset: 'standard' }, context)
    await handlers.get('shutdown')?.({}, context)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(['egress', expect.objectContaining({ prev: previous })])
  })

  it('freezes resolved consent on start and releases it on shutdown', async () => {
    const events: unknown[] = []
    const handlers = new Map<string, (payload: unknown, context: HookContext) => unknown>()
    const api = {
      events: {
        append: async (name: string, data: unknown) => {
          events.push([name, data])
          return events.length
        },
      },
      registerHook: (event: string, handler: (payload: unknown, context: HookContext) => unknown) => {
        handlers.set(event, handler)
        return () => undefined
      },
    } as unknown as ExtensionAPI
    const dispose = privacyExtension(api)
    const session = Object.freeze({
      key: 's',
      lane: 'main',
      workspaceRoot: '/workspace',
      telemetryConsent: 'ANON' as const,
      telemetryConsentPendingAudit: true,
    })
    const context = { session } as HookContext

    await handlers.get('session_start')?.({ preset: 'standard' }, context)
    const gate = createSessionEgressGate(api, session)
    expect(gate.session).toBe(session)
    expect(gate.active).toBe(true)
    expect(gate.consent).toBe('ANON')
    expect(events).toEqual([['consent', { from: 'DISABLED', to: 'ANON', by: 'profile:standard' }]])
    await handlers.get('shutdown')?.({}, context)
    expect(gate.active).toBe(false)
    expect(gate.consent).toBe('DISABLED')
    await expect(gate.send('after-close', async () => undefined)).rejects.toThrow(
      'egress session is not active',
    )
    if (typeof dispose === 'function') dispose()
  })

  it('invalidates old gates when the extension instance is disposed', async () => {
    const active = await activeApi([], 'FULL')
    const gate = createSessionEgressGate(active.api, active.session)
    if (typeof active.dispose !== 'function') throw new Error('privacy extension returned no disposer')
    active.dispose()
    expect(gate.consent).toBe('DISABLED')
    await expect(gate.send('after-dispose', async () => undefined)).rejects.toThrow(
      'egress session is not active',
    )
  })

  it('fails closed when the initial consent audit cannot be committed', async () => {
    const handlers = new Map<string, (payload: unknown, context: HookContext) => unknown>()
    const api = {
      events: { append: async () => Promise.reject(new Error('ledger unavailable')) },
      registerHook: (event: string, handler: (payload: unknown, context: HookContext) => unknown) => {
        handlers.set(event, handler)
        return () => undefined
      },
    } as unknown as ExtensionAPI
    privacyExtension(api)
    const session = Object.freeze({
      key: 'audit-failure',
      lane: 'main',
      workspaceRoot: '/workspace',
      telemetryConsent: 'FULL' as const,
      telemetryConsentPendingAudit: true,
    })
    await expect(
      handlers.get('session_start')?.({ preset: 'standard' }, { session } as HookContext),
    ).rejects.toThrow('ledger unavailable')
    expect(() => createSessionEgressGate(api, session)).toThrow('egress session is not active')
  })
})
