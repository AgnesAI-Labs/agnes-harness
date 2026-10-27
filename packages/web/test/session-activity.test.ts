import { expect, it } from 'vitest'
import { SessionActivityView } from '../src/app/session-activity.js'

it('shows a background session running, then marks it done until it is opened', () => {
  const view = new SessionActivityView()
  view.showing('b', false)
  view.apply({ sessionId: 'a', state: 'running' })
  expect(view.running()).toEqual(['a'])
  view.apply({ sessionId: 'a', state: 'idle', reason: 'completed' })
  expect(view.running()).toEqual([])
  expect(view.marks()).toEqual({ a: 'completed' })
  view.showing('a', false)
  expect(view.marks()).toEqual({})
  view.showing('b', false)
  expect(view.marks()).toEqual({})
})

it('marks a turn that stopped, failed or parked without completing as ended', () => {
  const view = new SessionActivityView()
  for (const reason of ['aborted', 'error', 'max_steps'] as const) {
    view.apply({ sessionId: reason, state: 'running' })
    view.apply({ sessionId: reason, state: 'idle', reason })
  }
  expect(view.marks()).toEqual({ aborted: 'ended', error: 'ended', max_steps: 'ended' })
})

it('keeps a waiting mark until the approval or answer arrives, even for the session on screen', () => {
  const view = new SessionActivityView()
  view.showing('a', false)
  view.apply({ sessionId: 'a', state: 'waiting', waiting: 'approval', reason: 'parked' })
  view.apply({ sessionId: 'b', state: 'waiting', waiting: 'question' })
  expect(view.marks()).toEqual({ a: 'approval', b: 'question' })
  view.apply({ sessionId: 'a', state: 'running' })
  view.apply({ sessionId: 'a', state: 'idle', reason: 'completed' })
  expect(view.marks()).toEqual({ b: 'question' })
})

it('takes the daemon state on connect without inventing finished turns', () => {
  const view = new SessionActivityView()
  view.apply({ sessionId: 'gone', state: 'running' })
  view.reset([
    { sessionId: 'a', state: 'running' },
    { sessionId: 'b', state: 'waiting', waiting: 'approval' },
  ])
  expect(view.running()).toEqual(['a'])
  expect(view.marks()).toEqual({ b: 'approval' })
  // A session this page never saw running finishing says nothing new.
  view.apply({ sessionId: 'c', state: 'idle', reason: 'completed' })
  expect(view.marks()).toEqual({ b: 'approval' })
})

it('counts the session on screen as running while its own turn is in flight', () => {
  const view = new SessionActivityView()
  view.showing('a', true)
  expect(view.running()).toEqual(['a'])
  view.showing('a', false)
  expect(view.running()).toEqual([])
})
