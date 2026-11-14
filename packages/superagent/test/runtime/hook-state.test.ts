// The process's one hook state: every application of the plugin row reads the same holder, which no code can replace;
// each service generation sets and clears only its own state, and a stop leaves Superagent's sessions refused.
import { describe, expect, it } from 'vitest'
import {
  claimHookState,
  createHookStateHolder,
  type HookState,
  INERT_HOOK_STATE,
  processHookState,
  stoppedHookState,
} from '../../src/runtime/hook-state.js'

const named = (name: string): HookState => ({
  isSuperagentSession: () => true,
  promptSections: () => ({ stable: [{ id: name, order: 1, content: name }] }),
  guardTool: () => name,
})

describe('the hook state holder', () => {
  it('replaces a state only when it still holds the one expected', () => {
    const holder = createHookStateHolder()
    const [a, b, c, rest] = ['a', 'b', 'c', 'rest'].map(named) as [HookState, HookState, HookState, HookState]
    expect(holder.get()).toBe(INERT_HOOK_STATE)
    holder.claim(a)
    expect(holder.compareAndSet(b, c)).toBe(false)
    expect(holder.get()).toBe(a)
    expect(holder.compareAndSet(a, c)).toBe(true)
    expect(holder.compareAndClear(a, rest)).toBe(false)
    expect(holder.get()).toBe(c)
    expect(holder.compareAndClear(c, rest)).toBe(true)
    expect(holder.get()).toBe(rest)
  })

  it("lets a generation set and clear only its own state, never a newer generation's", () => {
    const holder = createHookStateHolder()
    const old = claimHookState(holder, named('old'), () => named('old-rest'))
    old.set(named('old-ready'))
    const current = claimHookState(holder, named('new'), () => named('new-rest'))
    const ready = named('new-ready')
    current.set(ready)
    // The old generation's slow shutdown runs after the new one took over: it changes nothing.
    old.set(named('old-late'))
    old.clear()
    expect(holder.get()).toBe(ready)
    current.clear()
    expect(holder.get().guardTool({ sessionId: 's', toolName: 'read', input: {} })).toBe('new-rest')
  })

  it('lives on the process under a property no code can overwrite or remove', () => {
    const holder = processHookState()
    expect(processHookState()).toBe(holder)
    const slot = Symbol.for('agnes.superagent.hookState')
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, slot)
    expect(descriptor).toMatchObject({ writable: false, configurable: false, enumerable: false })
    expect(descriptor?.value).toBe(holder)
    expect(Object.isFrozen(holder)).toBe(true)
    expect(() => {
      ;(globalThis as Record<symbol, unknown>)[slot] = createHookStateHolder()
    }).toThrow(TypeError)
    expect(() => Object.defineProperty(globalThis, slot, { value: {} })).toThrow(TypeError)
    expect(processHookState()).toBe(holder)
  })
})

describe('the state a stop leaves', () => {
  it("refuses every tool of Superagent's sessions and their subagents, keeps their live notes, and passes the rest", () => {
    const state = stoppedHookState(
      new Map([
        ['superagent:orchestrator', { id: 'superagent-notices', content: 'Settings saved' }],
        ['superagent:worker:t1', undefined],
      ]),
      'Superagent is not running',
    )
    for (const id of ['superagent:orchestrator', 'superagent:worker:t1', 'superagent:worker:t1/01CHILD']) {
      expect(state.isSuperagentSession(id), id).toBe(true)
      expect(state.guardTool({ sessionId: id, toolName: 'read', input: {} }), id).toBe(
        'Superagent is not running',
      )
    }
    expect(state.promptSections('superagent:orchestrator')).toEqual({
      stable: [],
      liveNote: { id: 'superagent-notices', content: 'Settings saved' },
    })
    expect(state.promptSections('superagent:worker:t1')).toEqual({ stable: [] })
    for (const id of ['01OWNER', 'superagent:worker:t2']) {
      expect(state.isSuperagentSession(id)).toBe(false)
      expect(state.guardTool({ sessionId: id, toolName: 'read', input: {} })).toBeUndefined()
    }
  })
})
