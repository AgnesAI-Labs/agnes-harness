/** @vitest-environment happy-dom */
import type { UINode } from '@agnes/protocol'
import { act } from 'react'
import { expect, it, vi } from 'vitest'

// The first test pays for loading the client runtime.
vi.setConfig({ testTimeout: 60_000 })

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const said = (id: string) => ({ kind: 'assistant', id, seq: 1, text: id }) as unknown as UINode

/** The conversation presentation's transcript port, as a remounted conversation region attaches to it. */
async function conversation() {
  const { startClientModules } = await import('../src/client-modules/boot.js')
  const { PresentationService } = await import('@agnes/web-client')
  const container = document.createElement('div')
  document.body.append(container)
  let runtime!: Awaited<ReturnType<typeof startClientModules>>
  await act(async () => {
    runtime = await startClientModules({
      agnes: { sessions: { get: (id: string) => ({ id, listeners: new Set() }) } } as never,
      conversationContainer: container,
    })
  })
  const port = (runtime.ctx.get('presentation') as InstanceType<typeof PresentationService>).host
    .conversation!.transcript
  const mount = () => {
    const rendered: string[][] = []
    const detach = port.attach({
      render: (nodes: readonly UINode[]) => rendered.push(nodes.map((node) => node.id)),
      reset() {},
      pinToBottom() {},
      dispose() {},
      setEmptyStateVisible() {},
    } as never)
    return { rendered, detach }
  }
  return {
    runtime,
    mount,
    async dispose() {
      await act(async () => {
        await runtime.dispose()
      })
      container.remove()
    },
  }
}

it('does not replay the previous session into a region remounted while switching to another one', async () => {
  const { runtime, mount, dispose } = await conversation()
  try {
    runtime.session.setSession('A')
    const first = mount()
    runtime.transcript!.render([said('a1'), said('a2')])
    expect(first.rendered).toEqual([['a1', 'a2']])
    first.detach()
    // Opening another session leaves the concrete session first; the region remounts for that.
    runtime.session.setSession(undefined)
    const switching = mount()
    expect(switching.rendered).toEqual([])
    // The new selection's own content still reaches the fresh region.
    runtime.transcript!.render([said('b1')])
    expect(switching.rendered).toEqual([['b1']])
    switching.detach()
    // Directly between concrete sessions as well.
    runtime.session.setSession('B')
    runtime.transcript!.render([said('b2')])
    runtime.session.setSession('C')
    expect(mount().rendered).toEqual([])
  } finally {
    await dispose()
  }
})

it('replays the shown content into a region remounted for the same selection', async () => {
  const { runtime, mount, dispose } = await conversation()
  try {
    runtime.session.setSession('A')
    const first = mount()
    runtime.transcript!.render([said('a1')])
    first.detach()
    expect(mount().rendered).toEqual([['a1']])
    // A preview painted before admission belongs to no concrete session yet.
    runtime.session.setSession(undefined)
    runtime.transcript!.render([said('preview')])
    expect(mount().rendered).toEqual([['preview']])
    // A reset forgets it.
    runtime.transcript!.reset()
    expect(mount().rendered).toEqual([])
  } finally {
    await dispose()
  }
})
