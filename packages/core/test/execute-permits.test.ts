import { describe, expect, it } from 'vitest'
import { ExecutePermitRegistry } from '../src/effects/execute-permits.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession, readTool } from './helpers/open-session.js'

describe('execute permits', () => {
  it('binds each attempt to one owner, effect and durable start sequence, then consumes it once', () => {
    const registry = new ExecutePermitRegistry()
    const owner = {}
    const permit = registry.issue({ effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })

    expect(() => registry.consume(permit, { effectId: 'effect-1', startSeq: 8, owner, attempt: 1 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
    expect(() => registry.consume(permit, { effectId: 'effect-1', startSeq: 7, owner, attempt: 2 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
    registry.consume(permit, { effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })
    expect(() => registry.consume(permit, { effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
    expect(() =>
      registry.consume(Object.freeze({}) as never, {
        effectId: 'effect-1',
        startSeq: 7,
        owner,
        attempt: 1,
      }),
    ).toThrow('E_EXECUTE_PERMIT')
    expect(() => registry.issue({ effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
  })

  it('requires attempts to be issued and consumed in strict order', () => {
    const registry = new ExecutePermitRegistry()
    const owner = {}

    expect(() => registry.issue({ effectId: 'effect-skip', startSeq: 7, owner, attempt: 2 })).toThrow(
      'E_EXECUTE_PERMIT',
    )

    const first = registry.issue({ effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })
    expect(() => registry.issue({ effectId: 'effect-1', startSeq: 7, owner, attempt: 2 })).toThrow(
      'E_EXECUTE_PERMIT',
    )

    registry.consume(first, { effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })
    const second = registry.issue({ effectId: 'effect-1', startSeq: 7, owner, attempt: 2 })
    registry.consume(second, { effectId: 'effect-1', startSeq: 7, owner, attempt: 2 })

    expect(() => registry.issue({ effectId: 'effect-1', startSeq: 7, owner, attempt: 2 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
  })

  it('keeps owner and durable start sequence fixed across both attempts', () => {
    const registry = new ExecutePermitRegistry()
    const owner = {}
    const first = registry.issue({ effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })
    registry.consume(first, { effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })

    expect(() => registry.issue({ effectId: 'effect-1', startSeq: 7, owner: {}, attempt: 2 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
    expect(() => registry.issue({ effectId: 'effect-1', startSeq: 8, owner, attempt: 2 })).toThrow(
      'E_EXECUTE_PERMIT',
    )

    const second = registry.issue({ effectId: 'effect-1', startSeq: 7, owner, attempt: 2 })
    registry.consume(second, { effectId: 'effect-1', startSeq: 7, owner, attempt: 2 })
  })

  it('restores a durably consumed first attempt after restart and permits only attempt 2', () => {
    const registry = new ExecutePermitRegistry()
    const owner = {}
    registry.restoreConsumed({ effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })

    expect(() => registry.issue({ effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
    expect(() => registry.issue({ effectId: 'effect-1', startSeq: 8, owner, attempt: 2 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
    expect(() => registry.issue({ effectId: 'effect-1', startSeq: 7, owner: {}, attempt: 2 })).toThrow(
      'E_EXECUTE_PERMIT',
    )

    const second = registry.issue({ effectId: 'effect-1', startSeq: 7, owner, attempt: 2 })
    registry.consume(second, { effectId: 'effect-1', startSeq: 7, owner, attempt: 2 })
  })

  it('refuses duplicate, malformed and post-close restored state', () => {
    const registry = new ExecutePermitRegistry()
    const owner = {}
    registry.restoreConsumed({ effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })
    expect(() => registry.restoreConsumed({ effectId: 'effect-1', startSeq: 7, owner, attempt: 1 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
    expect(() => registry.restoreConsumed({ effectId: 'effect-2', startSeq: 0, owner, attempt: 1 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
    expect(() =>
      registry.restoreConsumed({ effectId: 'effect-3', startSeq: 7, owner, attempt: 3 as 2 }),
    ).toThrow('E_EXECUTE_PERMIT')
    registry.close()
    expect(() => registry.restoreConsumed({ effectId: 'effect-4', startSeq: 7, owner, attempt: 1 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
  })

  it('rejects attempt numbers outside the closed capability contract', () => {
    const registry = new ExecutePermitRegistry()
    const owner = {}

    expect(() => registry.issue({ effectId: 'effect-0', startSeq: 1, owner, attempt: 0 as 1 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
    expect(() => registry.issue({ effectId: 'effect-3', startSeq: 1, owner, attempt: 3 as 2 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
  })

  it('invalidates unconsumed permits when the owning dispatch boundary closes', () => {
    const registry = new ExecutePermitRegistry()
    const owner = {}
    const permit = registry.issue({ effectId: 'effect-1', startSeq: 1, owner, attempt: 1 })
    registry.close()

    expect(() => registry.consume(permit, { effectId: 'effect-1', startSeq: 1, owner, attempt: 1 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
    expect(() => registry.issue({ effectId: 'effect-2', startSeq: 2, owner, attempt: 1 })).toThrow(
      'E_EXECUTE_PERMIT',
    )
  })

  it('does not enter the tool backend until effect/intent is durably visible', async () => {
    const registry = new ToolRegistry()
    let opened: Awaited<ReturnType<typeof openSession>> | undefined
    let intentsAtExecute = 0
    registry.add(
      readTool(async () => {
        const intents = (await opened?.log.scan({ type: 'effect/intent', limit: 10 })) ?? []
        intentsAtExecute = intents.filter((row) => (row.data as { kind?: unknown }).kind === 'tool').length
        return { content: [{ type: 'text', text: 'ok' }] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    opened = await openSession({
      registry,
      provider: fakeProvider([toolTurn('read', { path: 'README' }), textTurn('done')]),
    })
    await opened.session.enqueue('next-turn', {
      actor,
      content: [{ type: 'text', text: 'read it' }],
    })

    expect(
      (await opened.session.run({ until: 'turn-end', signal: new AbortController().signal })).reason,
    ).toBe('completed')
    expect(intentsAtExecute).toBe(1)
  })
})
