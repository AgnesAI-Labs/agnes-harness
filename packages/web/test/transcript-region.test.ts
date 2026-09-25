/** @vitest-environment happy-dom */

import type { UINode } from '@agnes/protocol'
import { createElement, useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSlotCardContext } from '../src/client-modules/timeline-slot.js'
import { TRANSCRIPT_SLOT } from '../src/region-slots.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

const assistant: UINode = { kind: 'assistant', id: 'assistant-1', seq: 1, text: '渲染后的时间线' }

describe('rendered transcript region', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
  })

  it('renders the component-owned timeline through the public region handle', async () => {
    runtime = await mountRenderedIndex()
    const transcript = document.querySelector('section#transcript')
    const content = transcript?.querySelector('#transcript-content')
    expect(content?.closest('[data-slot]')?.getAttribute('data-slot')).toBe('ui:transcript')
    expect(runtime.transcript).toBeDefined()

    runtime.transcript?.render([assistant])

    expect(content?.querySelector('[data-node-id="assistant-1"]')?.textContent).toContain('渲染后的时间线')
    runtime.transcript?.reset()
    expect(content?.querySelector('[data-node-id="assistant-1"]')).toBeNull()
  })

  it('mounts slot cards with a per-card React root and restores the built-in after shadow unload', async () => {
    runtime = await mountRenderedIndex()
    bindSlotCardContext({ registry: runtime.registry, claim: () => true })
    const lifecycle: string[] = []
    function Card() {
      useEffect(() => {
        lifecycle.push('mount')
        return () => {
          lifecycle.push('unmount')
        }
      }, [])
      return createElement('div', { id: 'fixture-slot-card' }, '插件卡')
    }
    const removeCard = runtime.registry.register('tool.card.inline', Card as never, {
      owner: 'fixture.card',
      id: 'fixture-slot-card',
    })
    const slot: UINode = {
      kind: 'slot',
      id: 'slot-1',
      fill: { slot: 'tool.card.inline', extId: 'fixture.card', payload: { value: 1 } },
    } as UINode
    runtime.transcript?.render([slot])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.querySelector('[data-slot-node="tool.card.inline"]')).toBeTruthy()
    expect(
      document.querySelector('[data-slot-node="tool.card.inline"] [data-slot="tool.card.inline"]'),
    ).toBeTruthy()
    await vi.waitFor(() => expect(lifecycle).toContain('mount'))

    const remove = runtime.registry.register(
      { name: TRANSCRIPT_SLOT as string, id: 'fixture-transcript-shadow', owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'shadow-transcript' }, '替换时间线'),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.querySelector('#shadow-transcript')?.textContent).toBe('替换时间线')
    expect(document.querySelector('#transcript-content')).toBeNull()
    await vi.waitFor(() => expect(lifecycle).toEqual(['mount', 'unmount']))

    remove()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.querySelector('#transcript-content')).toBeTruthy()
    expect(document.querySelector('#shadow-transcript')).toBeNull()
    removeCard()
  })
})
