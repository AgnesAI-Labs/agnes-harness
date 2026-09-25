/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { UINode } from '@agnes/protocol'
import { SlotRegistry } from '@agnes/web-client'
import { act, createElement, useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountTranscriptRegion } from '../src/region-slots.js'

const contexts: Context[] = []
const mounts: Array<ReturnType<typeof mountTranscriptRegion>> = []

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SlotRegistry)
  const registry = (ctx as unknown as { slots: SlotRegistry }).slots
  registry.setSession('session-a')
  const transcript = document.createElement('section')
  transcript.id = 'transcript'
  const button = document.createElement('button')
  document.body.append(transcript, button)
  const mount = mountTranscriptRegion(registry, transcript, {
    nodeHost: 'react',
    newContentButton: button,
    claim: (entry, extId) => entry.owner === extId,
  })
  mounts.push(mount)
  return { registry, transcript, mount }
}

const user: UINode = {
  kind: 'user',
  id: 'user',
  seq: 1,
  content: [{ type: 'text', text: 'hello' }],
}
const slot = (value: number): UINode =>
  ({
    kind: 'slot',
    id: 'slot',
    seq: 2,
    fill: { slot: 'tool.card.inline', extId: 'plugin-a', payload: { value } },
  }) as UINode
const tool = (status: 'running' | 'failed'): UINode =>
  ({
    kind: 'tool',
    id: 'tool',
    seq: 3,
    toolUseId: 'call-1',
    name: 'bash',
    status,
    summary: status,
  }) as UINode

const item = (transcript: HTMLElement, id: string) =>
  transcript.querySelector<HTMLElement>(`[data-node-id="${id}"]`)

afterEach(async () => {
  while (mounts.length) mounts.pop()?.dispose()
  while (contexts.length) await contexts.pop()?.fiber.dispose()
  document.body.replaceChildren()
})

describe('W4a opt-in transcript node host', () => {
  it('owns creation, in-place update, order, deletion and reset in one React tree', async () => {
    const { transcript, mount } = await setup()
    await act(async () => mount.render([slot(1), tool('running')]))
    const content = transcript.querySelector('#transcript-content')
    expect(content?.querySelector('[data-agnes-conversation-messages]')).toBeTruthy()
    const original = item(transcript, 'slot')
    expect(original?.querySelector('[data-slot-node="tool.card.inline"]')).toBeTruthy()
    await act(async () => mount.render([user, slot(2), tool('failed')]))
    expect(item(transcript, 'slot')).toBe(original)
    expect(
      Array.from(content?.querySelectorAll('[data-node-id]') ?? []).map((el) =>
        el.getAttribute('data-node-id'),
      ),
    ).toEqual(['user', 'slot', 'tool'])
    expect(item(transcript, 'tool')?.textContent).toContain('failed')
    await act(async () => mount.render([user, slot(2)]))
    expect(item(transcript, 'tool')).toBeNull()
    await act(async () => mount.reset())
    expect(content?.querySelectorAll('[data-node-id]')).toHaveLength(0)
  })

  it('preserves the slot card through updates, then unmounts on deletion and region disposal', async () => {
    const { registry, transcript, mount } = await setup()
    const lifecycle: string[] = []
    function Card({ fill }: { fill: { payload: { value: number } } }) {
      const [count, setCount] = useState(0)
      useEffect(() => {
        lifecycle.push('mount')
        return () => {
          lifecycle.push('unmount')
        }
      }, [])
      return createElement(
        'button',
        { type: 'button', onClick: () => setCount(count + 1) },
        `${fill.payload.value}:${count}`,
      )
    }
    await act(async () => mount.render([slot(1)]))
    const host = item(transcript, 'slot')?.querySelector<HTMLElement>('[data-agnes-region="slot-card"]')
    expect(host?.textContent).toContain('此卡片的插件未就绪')
    const wrongOwner = registry.register('tool.card.inline', Card as never, {
      owner: 'plugin-b',
      id: 'wrong-owner',
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(host?.textContent).toContain('此卡片的插件未就绪')
    wrongOwner()
    const off = registry.register('tool.card.inline', Card as never, { owner: 'plugin-a', id: 'card' })
    await vi.waitFor(() => expect(host?.querySelector('button')?.textContent).toBe('1:0'))
    const button = host?.querySelector('button')
    await act(async () => button?.click())
    await act(async () => mount.render([user, slot(2)]))
    expect(item(transcript, 'slot')?.querySelector('[data-agnes-region="slot-card"]')).toBe(host)
    expect(host?.querySelector('button')).toBe(button)
    expect(button?.textContent).toBe('2:1')
    await act(async () => off())
    expect(host?.textContent).toContain('此卡片的插件未就绪')
    expect(lifecycle).toEqual(['mount', 'unmount'])
    await act(async () => mount.render([user]))
    expect(item(transcript, 'slot')).toBeNull()
    const offAgain = registry.register('tool.card.inline', Card as never, { owner: 'plugin-a', id: 'again' })
    await act(async () => mount.render([slot(3)]))
    expect(lifecycle).toEqual(['mount', 'unmount', 'mount'])
    await act(async () => mount.reset())
    expect(lifecycle).toEqual(['mount', 'unmount', 'mount', 'unmount'])
    await act(async () => mount.render([slot(4)]))
    expect(lifecycle).toEqual(['mount', 'unmount', 'mount', 'unmount', 'mount'])
    await act(async () => mount.dispose())
    expect(lifecycle).toEqual(['mount', 'unmount', 'mount', 'unmount', 'mount', 'unmount'])
    offAgain()
  })

  it('exposes native, parent and child DSH datasets and restores native fallback', async () => {
    const { registry, transcript, mount } = await setup()
    await act(async () => mount.render([tool('running')]))
    const article = item(transcript, 'tool')
    expect(article?.querySelector('[data-agnes-timeline-native]')).toBeTruthy()
    expect(article?.querySelector('[data-agnes-dsh-slot="tool.call.toolview"]')).toBeTruthy()
    expect(article?.querySelector('[data-agnes-dsh-children="tool.call.toolview"]')).toBeTruthy()
    const off = registry.register(
      { name: 'tool.call.toolview', key: 'bash', id: 'view' },
      ({ owner }: { owner: { block: { status: string } } }) =>
        createElement('div', { id: 'view' }, owner.block.status),
    )
    await vi.waitFor(() => expect(article?.querySelector('#view')?.textContent).toBe('running'))
    await act(async () => mount.render([tool('failed')]))
    expect(article?.querySelector('#view')?.textContent).toBe('failed')
    await act(async () => off())
    expect(article?.querySelector('#view')).toBeNull()
    expect(article?.querySelector<HTMLElement>('[data-agnes-timeline-native]')?.hidden).toBe(false)
    const offChild = registry.register({ name: 'tool.view.cordis', key: 'bash', id: 'child' }, () =>
      createElement('div', { id: 'child' }, 'child'),
    )
    await vi.waitFor(() => expect(article?.querySelector('#child')?.textContent).toBe('child'))
    offChild()
    await vi.waitFor(() => expect(article?.querySelector('#child')).toBeNull())
    await act(async () => mount.render([{ kind: 'assistant', id: 'assistant', seq: 4, text: 'answer' }]))
    const assistant = item(transcript, 'assistant')
    expect(assistant?.querySelector('[data-agnes-dsh-slot="conversation.chat.node"]')).toBeTruthy()
    expect(assistant?.querySelector('[data-agnes-dsh-children="conversation.chat.node"]')).toBeTruthy()
    const offActions = registry.register({ name: 'conversation.chat.assistant-actions', id: 'actions' }, () =>
      createElement('button', { id: 'actions', type: 'button' }, 'action'),
    )
    await vi.waitFor(() => expect(assistant?.querySelector('#actions')?.textContent).toBe('action'))
    offActions()
  })
})
