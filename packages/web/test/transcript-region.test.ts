/** @vitest-environment happy-dom */

import type { UINode } from '@agnes/protocol'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TRANSCRIPT_SLOT } from '../src/region-slots.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

// A slot card or shadow commits in a few milliseconds, but a loaded runner has taken longer than the
// fixed 20 ms these checks used to sleep. Wait for the rendered state instead.
const committed = { timeout: 5_000 }

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
    runtime = await mountRenderedIndex({ claim: () => true })
    const slot: UINode = {
      kind: 'slot',
      id: 'slot-1',
      fill: { slot: 'tool.card.inline', extId: 'fixture.card', payload: { value: 1 } },
    } as UINode
    runtime.transcript?.render([slot])
    await vi.waitFor(() => {
      expect(document.querySelector('[data-slot-node="tool.card.inline"]')).toBeTruthy()
      expect(
        document.querySelector('[data-slot-node="tool.card.inline"] [data-slot="tool.card.inline"]'),
      ).toBeTruthy()
    }, committed)

    const remove = runtime.registry.register(
      { name: TRANSCRIPT_SLOT as string, id: 'fixture-transcript-shadow', owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'shadow-transcript' }, '替换时间线'),
    )
    await vi.waitFor(() => {
      expect(document.querySelector('#shadow-transcript')?.textContent).toBe('替换时间线')
      expect(document.querySelector('#transcript-content')).toBeNull()
    }, committed)

    remove()
    await vi.waitFor(() => {
      expect(document.querySelector('#transcript-content')).toBeTruthy()
      expect(document.querySelector('#shadow-transcript')).toBeNull()
    }, committed)
  })

  it('renders a claimed plugin card through the default React region bootstrap', async () => {
    runtime = await mountRenderedIndex({
      transcript: { nodeHost: 'react' },
      claim: (entry, extId) => entry.owner === extId,
    })
    const remove = runtime.registry.register(
      'tool.card.inline',
      () => createElement('span', null, '已认领卡片'),
      { owner: 'fixture.card', id: 'claimed-card' },
    )
    try {
      const slot: UINode = {
        kind: 'slot',
        id: 'slot-claimed',
        seq: 1,
        fill: { slot: 'tool.card.inline', extId: 'fixture.card', payload: {} },
      }
      runtime.transcript?.render([slot])
      await vi.waitFor(() =>
        expect(document.querySelector('[data-slot-node="tool.card.inline"]')?.textContent).toContain(
          '已认领卡片',
        ),
      )
      expect(document.querySelector('[data-slot-node="tool.card.inline"]')?.textContent).not.toContain(
        '此卡片的插件未就绪',
      )
    } finally {
      remove()
    }
  })
})
