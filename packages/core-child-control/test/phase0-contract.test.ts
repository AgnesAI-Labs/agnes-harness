import { describe, expect, it } from 'vitest'
import { ChildLock } from '../src/child/child-lock.js'
import { projectChildStatus, resolveTerminalChildState } from '../src/child/status-projection.js'
import { canTransitionChildState, isActiveChildState, isTerminalChildState } from '../src/child/types.js'

describe('Phase 0 child-control shared contract', () => {
  it('projects every ChildExecutionState consistently to ChildAgentStatus + executionState', () => {
    expect(projectChildStatus({ state: 'creating' })).toEqual({
      status: 'starting',
      executionState: 'creating',
      cancelling: false,
    })
    expect(projectChildStatus({ state: 'ready' })).toEqual({
      status: 'starting',
      executionState: 'ready',
      cancelling: false,
    })
    expect(projectChildStatus({ state: 'waiting_approval' })).toEqual({
      status: 'waiting_approval',
      executionState: 'waiting_approval',
      cancelling: false,
    })
    expect(projectChildStatus({ state: 'paused' })).toEqual({
      status: 'paused',
      executionState: 'paused',
      cancelling: false,
    })
    expect(projectChildStatus({ state: 'disconnected' })).toEqual({
      status: 'disconnected',
      executionState: 'disconnected',
      cancelling: false,
    })
    expect(projectChildStatus({ state: 'cancelling' })).toEqual({
      status: 'running',
      executionState: 'cancelling',
      cancelling: true,
    })
    expect(projectChildStatus({ state: 'running' }, { residentIdle: true }).status).toBe('idle')
    expect(projectChildStatus({ state: 'running' }, { humanStopped: true }).status).toBe('interrupted')
  })

  it('enforces state transition fences, non-active paused/disconnected, and failure-over-cancel', () => {
    expect(isActiveChildState('paused')).toBe(false)
    expect(isActiveChildState('disconnected')).toBe(false)
    expect(isTerminalChildState('paused')).toBe(false)
    expect(isTerminalChildState('disconnected')).toBe(false)
    expect(canTransitionChildState('running', 'paused')).toBe(true)
    expect(canTransitionChildState('paused', 'running')).toBe(true)
    expect(canTransitionChildState('running', 'disconnected')).toBe(true)
    expect(canTransitionChildState('disconnected', 'running')).toBe(true)
    expect(canTransitionChildState('failed', 'cancelled')).toBe(false)
    expect(canTransitionChildState('completed', 'running')).toBe(false)
    expect(resolveTerminalChildState('failed', 'cancelled')).toBe('failed')
    expect(resolveTerminalChildState('completed', 'cancelled')).toBe('completed')
    expect(resolveTerminalChildState('running', 'cancelled')).toBe('cancelled')
  })

  it('serializes per-child operations in ChildLock without poisoning after an error', async () => {
    const lock = new ChildLock()
    const order: string[] = []
    const first = lock
      .run('child-1', async () => {
        order.push('start-1')
        await new Promise((r) => setTimeout(r, 15))
        order.push('fail-1')
        throw new Error('boom')
      })
      .catch((e: Error) => e.message)
    const second = lock.run('child-1', async () => {
      order.push('start-2')
      return 'ok'
    })
    expect(await first).toBe('boom')
    expect(await second).toBe('ok')
    expect(order).toEqual(['start-1', 'fail-1', 'start-2'])
    expect(lock.hasPending('child-1')).toBe(false)
  })
})
