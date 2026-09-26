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
  transcript.tabIndex = -1
  const button = document.createElement('button')
  document.body.append(transcript, button)
  const mount = mountTranscriptRegion(registry, transcript, {
    nodeHost: 'react',
    newContentButton: button,
    claim: (entry, extId) => entry.owner === extId,
    ...(options.onFork ? { onFork: options.onFork } : {}),
  })
  mounts.push(mount)
  return { registry, transcript, button, mount }
}

function measureTranscript(transcript: HTMLElement) {
  let top = 0
  let viewportHeight = 100
  const height = () => transcript.querySelectorAll('[data-node-id]').length * 100
  Object.defineProperties(transcript, {
    scrollHeight: { configurable: true, get: height },
    clientHeight: { configurable: true, get: () => viewportHeight },
    scrollTop: {
      configurable: true,
      get: () => Math.min(top, Math.max(0, height() - viewportHeight)),
      set(value: number) {
        top = Math.min(Math.max(0, value), Math.max(0, height() - viewportHeight))
      },
    },
  })
  return {
    resize(value: number) {
      viewportHeight = value
    },
  }
}

const user: UINode = {
  kind: 'user',
  id: 'user',
  seq: 1,
  content: [{ type: 'text', text: 'hello' }],
}
const say = (id: string, seq: number, text = id): UINode => ({ kind: 'assistant', id, seq, text })
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

  it('follows the bottom until a reader scrolls away, then offers and clears new content', async () => {
    const { transcript, button, mount } = await setup()
    measureTranscript(transcript)
    await act(async () => mount.render([say('a', 1), say('b', 2)]))
    expect(transcript.scrollTop).toBe(100)
    await act(async () => mount.render([say('a', 1), say('b', 2), say('c', 3)]))
    expect(transcript.scrollTop).toBe(200)
    transcript.scrollTop = 20
    transcript.dispatchEvent(new Event('scroll'))
    expect(button.hidden).toBe(false)
    await act(async () => mount.render([say('a', 1), say('b', 2), say('c', 3), say('d', 4)]))
    expect(transcript.scrollTop).toBe(20)
    expect(button.hidden).toBe(false)
    button.click()
    expect(transcript.scrollTop).toBe(300)
    expect(button.hidden).toBe(true)
    expect(document.activeElement).toBe(transcript)
    await act(async () => mount.render([say('a', 1), say('b', 2), say('c', 3), say('d', 4), say('e', 5)]))
    expect(transcript.scrollTop).toBe(400)
    transcript.scrollTop = 250
    transcript.dispatchEvent(new Event('scroll'))
    expect(button.hidden).toBe(false)
    transcript.scrollTop = 400
    transcript.dispatchEvent(new Event('scroll'))
    expect(button.hidden).toBe(true)
    await act(async () =>
      mount.render([say('a', 1), say('b', 2), say('c', 3), say('d', 4), say('e', 5), say('f', 6)]),
    )
    expect(transcript.scrollTop).toBe(500)
  })

  it('keeps following after an external approval or panel changes the viewport', async () => {
    const { transcript, mount } = await setup()
    const measured = measureTranscript(transcript)
    await act(async () => mount.render([say('a', 1), say('b', 2), say('c', 3)]))
    expect(transcript.scrollTop).toBe(200)
    measured.resize(50)
    mount.pinToBottom()
    expect(transcript.scrollTop).toBe(250)
    await act(async () => mount.render([say('a', 1), say('b', 2), say('c', 3), say('d', 4)]))
    expect(transcript.scrollTop).toBe(350)
  })

  it('loads one earlier page at a time and preserves the reader anchor across prepend and replay', async () => {
    const { transcript, button, mount } = await setup()
    measureTranscript(transcript)
    let finishLoad: (() => void) | undefined
    const loadEarlier = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishLoad = resolve
        }),
    )
    const tail = [say('c', 3), say('d', 4), say('e', 5)]
    await act(async () => mount.render(tail, [], { hasEarlier: true, loadEarlier }))
    const earlier = transcript.querySelector<HTMLElement>('.transcript-earlier')
    const loadButton = earlier?.querySelector<HTMLButtonElement>('button')
    expect(earlier?.hidden).toBe(false)
    transcript.scrollTop = 20
    transcript.dispatchEvent(new Event('scroll'))
    loadButton?.click()
    loadButton?.click()
    await act(async () => mount.render(tail, [], { hasEarlier: true, loadEarlier }))
    loadButton?.click()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    await act(async () => finishLoad?.())
    const old = item(transcript, 'c')
    const all = [say('a', 1), say('b', 2), ...tail]
    await act(async () => mount.render(all, [], { hasEarlier: false }))
    expect(earlier?.hidden).toBe(true)
    expect(transcript.scrollTop).toBe(220)
    expect(item(transcript, 'c')).toBe(old)
    expect(
      [...transcript.querySelectorAll('[data-node-id]')].map((node) => node.getAttribute('data-node-id')),
    ).toEqual(['a', 'b', 'c', 'd', 'e'])
    await act(async () => mount.render(all, [], { hasEarlier: false }))
    expect(transcript.querySelectorAll('[data-node-id]')).toHaveLength(5)
    expect(transcript.scrollTop).toBe(220)
    expect(button.hidden).toBe(false)
  })

  it('keeps a new history request locked when a pre-reset request settles', async () => {
    const { transcript, mount } = await setup()
    let finishOld: (() => void) | undefined
    let finishNew: (() => void) | undefined
    const oldLoad = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishOld = resolve
        }),
    )
    const newLoad = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishNew = resolve
        }),
    )
    await act(async () => mount.render([say('old', 1)], [], { hasEarlier: true, loadEarlier: oldLoad }))
    transcript.querySelector<HTMLButtonElement>('.transcript-earlier button')?.click()
    expect(oldLoad).toHaveBeenCalledTimes(1)
    await act(async () => mount.reset())
    await act(async () => mount.render([say('new', 1)], [], { hasEarlier: true, loadEarlier: newLoad }))
    const button = transcript.querySelector<HTMLButtonElement>('.transcript-earlier button')
    button?.click()
    expect(newLoad).toHaveBeenCalledTimes(1)
    await act(async () => finishOld?.())
    button?.click()
    expect(newLoad).toHaveBeenCalledTimes(1)
    await act(async () => finishNew?.())
    button?.click()
    expect(newLoad).toHaveBeenCalledTimes(2)
    await act(async () => finishNew?.())
  })

  it('keeps a fire-and-forget history callback locked until another projection arrives', async () => {
    const { transcript, mount } = await setup()
    const loadEarlier = vi.fn(() => undefined)
    const nodes = [say('c', 3)]
    await act(async () => mount.render(nodes, [], { hasEarlier: true, loadEarlier }))
    const button = transcript.querySelector<HTMLButtonElement>('.transcript-earlier button')
    button?.click()
    await act(async () => Promise.resolve())
    button?.click()
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    await act(async () => mount.render(nodes, [], { hasEarlier: true, loadEarlier }))
    button?.click()
    expect(loadEarlier).toHaveBeenCalledTimes(2)
  })

  it('releases the history lock after a failed page and cleans the observer on unmount', async () => {
    const observed: Array<{ disconnect: ReturnType<typeof vi.fn>; notify: () => void }> = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        disconnect = vi.fn()
        notify: () => void
        constructor(callback: IntersectionObserverCallback) {
          this.notify = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never)
          observed.push(this)
        }
        observe() {}
      },
    )
    try {
      const { transcript, button, mount } = await setup()
      const loadEarlier = vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary history failure'))
        .mockResolvedValueOnce(undefined)
      await act(async () => mount.render([say('a', 1)], [], { hasEarlier: true, loadEarlier }))
      observed.at(-1)?.notify()
      await act(async () => Promise.resolve())
      transcript.querySelector<HTMLButtonElement>('.transcript-earlier button')?.click()
      expect(loadEarlier).toHaveBeenCalledTimes(2)
      await act(async () => mount.dispose())
      expect(observed.at(-1)?.disconnect).toHaveBeenCalledTimes(1)
      const focus = vi.spyOn(transcript, 'focus')
      button.click()
      expect(focus).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('resets history, follow state and reused node IDs when the selected session changes', async () => {
    const { registry, transcript, button, mount } = await setup()
    measureTranscript(transcript)
    await act(async () =>
      mount.render([say('same', 1, 'old'), say('b', 2), say('c', 3)], [], {
        hasEarlier: true,
        loadEarlier: () => undefined,
      }),
    )
    const previous = item(transcript, 'same')
    transcript.scrollTop = 20
    transcript.dispatchEvent(new Event('scroll'))
    expect(button.hidden).toBe(false)
    registry.setSession('session-b')
    await act(async () => mount.reset())
    await act(async () => mount.render([say('same', 1, 'new')], [], { hasEarlier: false }))
    expect(item(transcript, 'same')).not.toBe(previous)
    expect(item(transcript, 'same')?.textContent).toContain('new')
    expect(transcript.querySelectorAll('[data-node-id]')).toHaveLength(1)
    expect(transcript.querySelector<HTMLElement>('.transcript-earlier')?.hidden).toBe(true)
    expect(transcript.scrollTop).toBe(0)
    expect(button.hidden).toBe(true)
  })
})
