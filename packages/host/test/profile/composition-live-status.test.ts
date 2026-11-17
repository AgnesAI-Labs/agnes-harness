import { expect, it, vi } from 'vitest'
import { createCompositionLiveStatus } from '../../src/runtime/profile/composition-live-status.js'

// The description is a pass-through of the session key, failing for chosen keys.
const failing = vi.hoisted(() => new Set<string>())
vi.mock('../../src/runtime/profile/session-capability-view.js', () => ({
  describeCapabilitySession: (_host: unknown, session: { key: string }) => {
    if (failing.has(session.key)) throw new Error(`cannot describe ${session.key}`)
    return { sessionKey: session.key }
  },
}))

const registry = { onChange: () => () => {} }
const session = (key: string) => ({
  key,
  closingOrClosed: false,
  onSettingsChanged: () => () => {},
  onClosed: () => () => {},
  currentTools: () => registry,
  currentResources: () => registry,
})

function liveStatus(log?: { warn: (message: string, detail: unknown) => void }) {
  const sessions = new Map([
    ['a', session('a')],
    ['b', session('b')],
  ])
  const container = { host: { kernel: { sessions, onSessionOpened: () => () => {} } } }
  const writes: string[][] = []
  const status = createCompositionLiveStatus({
    containers: () => [container as never],
    tree: () => ({}) as never,
    bundles: undefined,
    writer: { writeFragments: (fragments) => void writes.push([...fragments]) },
    ...(log ? { log: log as never } : {}),
  })
  return { status, writes }
}

it('warns with the session key and still writes every other session', async () => {
  failing.add('a')
  try {
    const warn = vi.fn()
    const { status, writes } = liveStatus({ warn })
    status.markDirty(['a', 'b'])
    await Promise.resolve()
    expect(writes).toEqual([[JSON.stringify({ sessionKey: 'b' })]])
    expect(warn).toHaveBeenCalledWith('Composition live status could not describe a session', {
      sessionKey: 'a',
      error: 'Error: cannot describe a',
    })
  } finally {
    failing.clear()
  }
})

it('never lets a throwing logger or a missing one escape the flush', async () => {
  failing.add('a')
  try {
    for (const log of [
      {
        warn: () => {
          throw new Error('logger down')
        },
      },
      undefined,
    ]) {
      const { status, writes } = liveStatus(log)
      status.markDirty(['a', 'b'])
      // An uncaught throw in the flush microtask would fail this file as an unhandled error.
      await Promise.resolve()
      expect(writes).toEqual([[JSON.stringify({ sessionKey: 'b' })]])
      status.close()
    }
  } finally {
    failing.clear()
  }
})
