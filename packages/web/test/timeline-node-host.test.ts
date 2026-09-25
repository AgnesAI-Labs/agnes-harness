/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { UINode, UITurn } from '@agnes/protocol'
import { SlotRegistry } from '@agnes/web-client'
import { act, createElement, useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountTranscriptRegion } from '../src/region-slots.js'

const contexts: Context[] = []
const mounts: Array<ReturnType<typeof mountTranscriptRegion>> = []

async function setup(options: { onFork?: (turn: UITurn) => Promise<void> } = {}) {
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
    ...(options.onFork ? { onFork: options.onFork } : {}),
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

const turn = (changes: Partial<UITurn> = {}): UITurn => ({
  id: 'turn:1',
  turn: 1,
  startSeq: 1,
  startedAt: '2026-09-25T00:00:00.000Z',
  status: 'running',
  nodeIds: ['user', 'assistant'],
  usage: {
    totals: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: true,
    calls: [],
  },
  inherited: false,
  forkable: false,
  ...changes,
})

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

  it('projects turn status, process, attention, final answer and orphan order', async () => {
    const { transcript, mount } = await setup()
    const assistant: UINode = {
      kind: 'assistant',
      id: 'assistant',
      seq: 2,
      text: '',
      thinking: '分析中',
      streaming: true,
    }
    const approval: UINode = {
      kind: 'approval',
      id: 'approval',
      seq: 3,
      state: 'pending',
      summary: '需要授权',
      risk: 'unknown',
      options: ['allow_once', 'reject_once'],
    }
    const orphan: UINode = { kind: 'assistant', id: 'orphan', seq: 4, text: '游离消息' }
    const nodes = [user, assistant, approval, orphan]
    const running = turn({ nodeIds: ['user', 'assistant', 'approval'] })
    await act(async () => mount.render(nodes, [running]))
    const shell = transcript.querySelector<HTMLElement>('.conversation-turn')
    expect(shell?.dataset.turnId).toBe(running.id)
    expect(shell?.dataset.status).toBe('running')
    expect(shell?.querySelector('.turn-process summary')?.textContent).toContain('等待审批')
    expect(shell?.querySelector('.turn-attention')?.textContent).toContain('需要授权')
    expect(transcript.querySelector('.timeline-unassigned')?.textContent).toContain('游离消息')
    expect(
      [...transcript.querySelectorAll('[data-node-id]')].map((el) => el.getAttribute('data-node-id')),
    ).toEqual(['user', 'assistant', 'approval', 'orphan'])
    await act(async () =>
      mount.render(
        [user, assistant, tool('running')],
        [turn({ status: 'waiting', nodeIds: ['user', 'assistant', 'tool'] })],
      ),
    )
    expect(shell?.querySelector('.turn-process summary')?.textContent).toContain('等待处理')
    await act(async () =>
      mount.render([user, assistant, tool('running')], [turn({ nodeIds: ['user', 'assistant', 'tool'] })]),
    )
    expect(shell?.querySelector('.turn-process summary')?.textContent).toContain('正在执行工具')
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      await act(async () =>
        mount.render(
          [user, { ...assistant, text: '最终回答', streaming: false }, tool('failed')],
          [turn({ status, nodeIds: ['user', 'assistant', 'tool'], finalAssistantId: 'assistant' })],
        ),
      )
      expect(shell?.dataset.status).toBe(status)
      expect(shell?.querySelector('.turn-final')?.textContent).toContain('最终回答')
      expect(shell?.querySelector('.turn-process .thinking-content')?.textContent).toContain('分析中')
      expect(shell?.querySelectorAll('.thinking')).toHaveLength(1)
    }
  })

  it('keeps the final article, selection, focus and manual process preference across settlement', async () => {
    const { transcript, mount } = await setup()
    const assistant: UINode = {
      kind: 'assistant',
      id: 'assistant',
      seq: 2,
      text: '稳定段落\n\n后续输出',
      streaming: true,
    }
    const running = turn()
    await act(async () => mount.render([user, assistant], [running]))
    const article = item(transcript, 'assistant')
    const paragraph = article?.querySelector('.node-body p')
    const summary = transcript.querySelector<HTMLElement>('.turn-process summary')
    const details = transcript.querySelector<HTMLDetailsElement>('.turn-process')
    expect(details?.open).toBe(true)
    await act(async () => summary?.click())
    expect(details?.open).toBe(false)
    await act(async () => mount.render([user, assistant], [running]))
    expect(details?.open).toBe(false)
    const range = document.createRange()
    range.selectNodeContents(paragraph?.firstChild ?? transcript)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)
    summary?.focus()
    await act(async () =>
      mount.render(
        [user, { ...assistant, streaming: false }],
        [turn({ status: 'completed', finalAssistantId: 'assistant', endedAt: '2026-09-25T00:00:01.000Z' })],
      ),
    )
    expect(item(transcript, 'assistant')).toBe(article)
    expect(transcript.querySelector('.turn-final .node-body p')).toBe(paragraph)
    expect(document.getSelection()?.toString()).toBe('稳定段落')
    expect(document.activeElement).toBe(summary)
    expect(details?.open).toBe(false)
    await act(async () => summary?.click())
    await act(async () =>
      mount.render(
        [user, { ...assistant, streaming: false }],
        [turn({ status: 'completed', finalAssistantId: 'assistant' })],
      ),
    )
    expect(details?.open).toBe(true)
  })

  it('reuses Web message actions for settled copy and fork availability', async () => {
    let finishFork: (() => void) | undefined
    const onFork = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFork = resolve
        }),
    )
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { transcript, mount } = await setup({ onFork })
    const assistant: UINode = { kind: 'assistant', id: 'assistant', seq: 2, text: '复制这段' }
    const running = turn({ finalAssistantId: 'assistant', forkable: true })
    await act(async () => mount.render([user, assistant], [running]))
    const footer = transcript.querySelector<HTMLElement>('.turn-footer')
    const copy = footer?.querySelector<HTMLButtonElement>('[aria-label="复制回答"]')
    const fork = footer?.querySelector<HTMLButtonElement>('[aria-label="分支到新聊天"]')
    expect(footer?.hidden).toBe(true)
    expect(copy?.disabled).toBe(false)
    await act(async () =>
      mount.render(
        [user, assistant],
        [
          turn({
            status: 'completed',
            finalAssistantId: 'assistant',
            forkable: true,
            endedAt: '2026-09-25T00:00:01.000Z',
            durationMs: 1000,
          }),
        ],
      ),
    )
    expect(footer?.hidden).toBe(false)
    expect(copy?.disabled).toBe(false)
    expect(fork?.disabled).toBe(false)
    await act(async () => copy?.click())
    expect(writeText).toHaveBeenCalledWith('复制这段')
    await act(async () => fork?.click())
    expect(onFork).toHaveBeenCalledTimes(1)
    expect(fork?.disabled).toBe(true)
    await act(async () => finishFork?.())
    expect(fork?.disabled).toBe(false)
    await act(async () =>
      mount.render(
        [user, assistant],
        [
          turn({
            status: 'failed',
            finalAssistantId: 'assistant',
            forkable: false,
          }),
        ],
      ),
    )
    expect(copy?.disabled).toBe(false)
    expect(fork?.hidden).toBe(true)
    await act(async () =>
      mount.render([user], [turn({ status: 'cancelled', finalAssistantId: 'assistant' })]),
    )
    expect(copy?.disabled).toBe(true)
    const withoutCallback = await setup()
    await act(async () =>
      withoutCallback.mount.render(
        [user, assistant],
        [
          turn({
            status: 'completed',
            finalAssistantId: 'assistant',
            forkable: true,
          }),
        ],
      ),
    )
    const unavailable = withoutCallback.transcript.querySelector<HTMLButtonElement>(
      '[aria-label="分支到新聊天"]',
    )
    expect(unavailable?.hidden).toBe(false)
    expect(unavailable?.disabled).toBe(true)
  })

  it('stops the active clock on terminal state, reset and unmount, and retains no-turn display', async () => {
    const setClock = vi.spyOn(globalThis, 'setInterval')
    const clearClock = vi.spyOn(globalThis, 'clearInterval')
    try {
      const { transcript, mount } = await setup()
      await act(async () => mount.render([user], [turn({ nodeIds: ['user'] })]))
      const clock = setClock.mock.results.find(
        (result, index) => setClock.mock.calls[index]?.[1] === 1000 && result.type === 'return',
      )?.value
      expect(clock).toBeDefined()
      await act(async () => mount.render([user], [turn({ status: 'completed', nodeIds: ['user'] })]))
      expect(clearClock).toHaveBeenCalledWith(clock)
      await act(async () => mount.render([user]))
      expect(transcript.querySelector('.conversation-turn')).toBeNull()
      expect(item(transcript, 'user')).toBeTruthy()
      await act(async () => mount.render([user], [turn({ nodeIds: ['user'] })]))
      const nextClock = setClock.mock.results.at(-1)?.value
      await act(async () => mount.reset())
      expect(clearClock).toHaveBeenCalledWith(nextClock)
      await act(async () => mount.render([user], [turn({ nodeIds: ['user'] })]))
      const lastClock = setClock.mock.results.at(-1)?.value
      await act(async () => mount.dispose())
      expect(clearClock).toHaveBeenCalledWith(lastClock)
    } finally {
      setClock.mockRestore()
      clearClock.mockRestore()
    }
  })

  it('keeps a claimed process card mounted while a streamed answer becomes final', async () => {
    const { registry, transcript, mount } = await setup()
    const lifecycle: string[] = []
    function Card() {
      const [count, setCount] = useState(0)
      useEffect(() => {
        lifecycle.push('mount')
        return () => {
          lifecycle.push('unmount')
        }
      }, [])
      return createElement('button', { type: 'button', onClick: () => setCount(count + 1) }, `${count}`)
    }
    const off = registry.register('tool.card.inline', Card as never, { owner: 'plugin-a', id: 'card' })
    const assistant: UINode = {
      kind: 'assistant',
      id: 'assistant',
      seq: 3,
      text: '最终回答',
      streaming: true,
    }
    const active = turn({ nodeIds: ['user', 'slot', 'assistant'] })
    await act(async () => mount.render([user, slot(1), assistant], [active]))
    const card = item(transcript, 'slot')?.querySelector<HTMLButtonElement>('button')
    const answer = item(transcript, 'assistant')
    await act(async () => card?.click())
    expect(card?.textContent).toBe('1')
    await act(async () =>
      mount.render(
        [user, slot(2), { ...assistant, streaming: false }],
        [
          turn({
            status: 'completed',
            nodeIds: ['user', 'slot', 'assistant'],
            finalAssistantId: 'assistant',
          }),
        ],
      ),
    )
    expect(item(transcript, 'slot')?.querySelector('button')).toBe(card)
    expect(card?.textContent).toBe('1')
    expect(item(transcript, 'assistant')).toBe(answer)
    expect(lifecycle).toEqual(['mount'])
    await act(async () => mount.reset())
    expect(lifecycle).toEqual(['mount', 'unmount'])
    off()
  })

  it('renders a node claimed by two turn records only once in the last owning turn', async () => {
    const { transcript, mount } = await setup()
    const assistant: UINode = { kind: 'assistant', id: 'assistant', seq: 2, text: '唯一回答' }
    await act(async () =>
      mount.render(
        [user, assistant],
        [
          turn({ id: 'turn:old', nodeIds: ['user', 'assistant'] }),
          turn({
            id: 'turn:new',
            turn: 2,
            nodeIds: ['assistant'],
            finalAssistantId: 'assistant',
            status: 'completed',
          }),
        ],
      ),
    )
    expect(transcript.querySelectorAll('[data-node-id="assistant"]')).toHaveLength(1)
    expect(transcript.querySelector('[data-turn-id="turn:new"] .turn-final')?.textContent).toContain(
      '唯一回答',
    )
  })
})
