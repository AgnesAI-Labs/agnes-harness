/** @vitest-environment happy-dom */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { UINode, UITurn } from '@agnes/protocol'
import {
  currentTurn,
  railHidden,
  TURN_NAV_FLASH_MS,
  TurnNav,
  type TurnNavProps,
  tickGap,
  tickWidth,
  toggleBookmark,
  turnNavEntries,
} from '@agnes/web-ui/conversation'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zhT } from './locale.js'

const user = (id: string, text: string, system = false): UINode =>
  system
    ? {
        kind: 'user',
        id,
        seq: 1,
        content: [{ type: 'text', text }],
        origin: 'system',
        system: { kind: 'schedule' } as never,
      }
    : { kind: 'user', id, seq: 1, content: [{ type: 'text', text }] }
const assistant = (id: string, text: string, streaming = false): UINode => ({
  kind: 'assistant',
  id,
  seq: 2,
  text,
  ...(streaming ? { streaming } : {}),
})
const tool = (id: string): UINode => ({
  kind: 'tool',
  id,
  seq: 3,
  toolUseId: id,
  name: 'read',
  status: 'completed',
  summary: 'read',
})
function turn(n: number, nodeIds: string[], changes: Partial<UITurn> = {}): UITurn {
  return {
    id: `turn:${n}`,
    turn: n,
    startSeq: n,
    startedAt: '2026-10-14T07:02:00.000Z',
    status: 'completed',
    nodeIds,
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
    inherited: false,
    forkable: true,
    ...changes,
  }
}

/** n completed turns, each a prompt and a two-paragraph answer. */
function conversation(n: number) {
  const nodes: UINode[] = []
  const turns: UITurn[] = []
  for (let i = 1; i <= n; i++) {
    nodes.push(
      user(`u${i}`, `问题 ${i}`),
      assistant(`a${i}`, `**回答** ${i} 第一段\n\n第二段 ${i}\n\n第三段`),
    )
    turns.push(turn(i, [`u${i}`, `a${i}`], { finalAssistantId: `a${i}` }))
  }
  return { nodes, turns }
}

describe('turn navigator model', () => {
  it('makes one entry per prompt the reader wrote, with the answer the card previews', () => {
    const nodes = [
      user('u1', '迁移 MCP\n和技能'),
      assistant('a1', '# 结果\n\n已完成 [迁移](https://x)，共 `9` 项。\n\n- 下一步：验证'),
      user('s1', '定时任务开始', true),
      assistant('a2', '定时结果'),
      user('u3', '只用工具'),
      tool('t1'),
      tool('t2'),
      user('u4', '还在写'),
      assistant('a4', '部分', true),
      user('u5', '失败了'),
    ]
    const turns = [
      turn(1, ['u1', 'a1'], { finalAssistantId: 'a1' }),
      turn(2, ['s1', 'a2']),
      turn(3, ['u3', 't1', 't2']),
      turn(4, ['u4', 'a4'], { status: 'running' }),
      turn(5, ['u5'], { status: 'failed' }),
    ]
    const entries = turnNavEntries(nodes, turns)
    expect(entries.map((entry) => entry.id)).toEqual(['u1', 'u3', 'u4', 'u5'])
    expect(entries[0]).toMatchObject({
      number: 1,
      prompt: '迁移 MCP 和技能',
      anchor: { attribute: 'data-turn-id', value: 'turn:1' },
      reply: { kind: 'text', lead: '结果', more: '已完成 迁移，共 9 项。' },
    })
    expect(entries[1]?.reply).toEqual({ kind: 'tools', count: 2 })
    expect(entries[2]?.reply).toEqual({ kind: 'streaming' })
    expect(entries[3]?.reply).toEqual({ kind: 'status', status: 'failed' })
  })

  it('falls back to user messages when the transcript has no turns', () => {
    const entries = turnNavEntries([
      user('u1', '一'),
      assistant('a1', '答一'),
      user('u2', '二'),
      assistant('a2', '写', true),
    ])
    expect(
      entries.map((entry) => [entry.id, entry.number, entry.anchor.attribute, entry.reply.kind]),
    ).toEqual([
      ['u1', 1, 'data-node-id', 'text'],
      ['u2', 2, 'data-node-id', 'streaming'],
    ])
  })

  it('keeps all ticks short at rest and only lengthens near the pointer without reduced motion', () => {
    expect(tickWidth(undefined, false, false)).toBe(12)
    expect(tickWidth(undefined, true, false)).toBe(12)
    expect(tickWidth(undefined, true, true)).toBe(12)
    expect(tickWidth(0, false, false)).toBe(30)
    expect(tickWidth(20, false, false)).toBe(21)
    expect(tickWidth(-20, false, false)).toBe(21)
    expect(tickWidth(40, false, false)).toBe(12)
    expect(tickWidth(90, true, false)).toBe(22)
    expect(tickWidth(0, false, true)).toBe(12)
    expect(tickWidth(0, true, true)).toBe(12)
  })

  it('compresses the gap above 40 prompts and keeps the rail within 60% of the pane', () => {
    expect(tickGap(10, 600)).toBe(7)
    expect(tickGap(40, 600)).toBe(7)
    expect(tickGap(60, 2000)).toBe(5)
    expect(tickGap(80, 2000)).toBe(3)
    expect(tickGap(200, 2000)).toBe(3)
    // 50 prompts in a 300px pane: 180px of rail → (180 - 100) / 49 ≈ 1.6, floored at 3.
    expect(tickGap(50, 300)).toBe(3)
    // 50 prompts in a 500px pane fit at (300 - 100) / 49 ≈ 4.08, below the count-based 6.
    expect(tickGap(50, 500)).toBeCloseTo(200 / 49)
  })

  it('follows the turn whose top reached the upper part of the viewport', () => {
    expect(currentTurn([-900, -100, 200, 700], 1000)).toBe(2)
    expect(currentTurn([100, 900], 1000)).toBe(0)
    expect(currentTurn([500, 900], 1000)).toBe(0)
  })

  it('hides for one prompt, narrow windows and a gutter under 56px', () => {
    expect(railHidden({ count: 2, viewportWidth: 1320, gutter: 120 })).toBe(false)
    expect(railHidden({ count: 1, viewportWidth: 1320, gutter: 120 })).toBe(true)
    expect(railHidden({ count: 5, viewportWidth: 899, gutter: 120 })).toBe(true)
    expect(railHidden({ count: 5, viewportWidth: 1320, gutter: 55 })).toBe(true)
  })

  it('toggles a bookmark keeping insertion order', () => {
    expect(toggleBookmark(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(toggleBookmark(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })
})

describe('turn navigator', () => {
  let shell: HTMLDivElement
  let viewport: HTMLElement
  let mount: HTMLDivElement
  let root: Root
  let gutter = 120
  let reduced = false
  let scrollTo: ReturnType<typeof vi.fn>

  /** Lay the transcript out: each turn 400px tall, the viewport 600px, scrolled by `scrollTop`. */
  function layout() {
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 600)
    viewport.getClientRects = () => [new DOMRect(0, 0, 1000, 600)] as unknown as DOMRectList
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 })
    shell.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 600)
    for (const section of viewport.querySelectorAll<HTMLElement>('[data-turn-id]')) {
      const index = Number(section.dataset.index)
      section.getBoundingClientRect = () => new DOMRect(0, index * 400 - viewport.scrollTop, 1000, 400)
    }
    const messages = viewport.querySelector<HTMLElement>('[data-agnes-conversation-messages]')
    if (messages) messages.getBoundingClientRect = () => new DOMRect(gutter, 0, 700, 400)
  }

  async function render(n: number, props: Partial<TurnNavProps> = {}) {
    const { nodes, turns } = conversation(n)
    const messages = document.createElement('section')
    messages.setAttribute('data-agnes-conversation-messages', '')
    turns.forEach((item, index) => {
      const section = document.createElement('section')
      section.dataset.turnId = item.id
      section.dataset.index = String(index)
      messages.append(section)
    })
    viewport.append(messages)
    layout()
    await act(async () => root.render(createElement(TurnNav, { t: zhT, nodes, turns, viewport, ...props })))
  }
  const ticks = () => [...shell.querySelectorAll<HTMLElement>('[data-testid="turn-nav-tick"]')]
  const card = () => shell.querySelector<HTMLElement>('[data-testid="turn-nav-card"]')
  const press = async (key: string, init: KeyboardEventInit = {}, target: EventTarget = document) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))
    })

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
    vi.stubGlobal('innerWidth', 1320)
    gutter = 120
    reduced = false
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduced-motion') && reduced,
      addEventListener() {},
      removeEventListener() {},
    }))
    shell = document.createElement('div')
    viewport = document.createElement('section')
    scrollTo = vi.fn((options: ScrollToOptions) => {
      viewport.scrollTop = options.top ?? 0
    })
    viewport.scrollTo = scrollTo as unknown as HTMLElement['scrollTo']
    mount = document.createElement('div')
    shell.append(viewport, mount)
    document.body.append(shell)
    root = createRoot(mount)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('draws one labelled tick per prompt beside the transcript, the first one current', async () => {
    await render(3)
    expect(shell.querySelector('nav')?.getAttribute('aria-label')).toBe('提问导航')
    expect(ticks().map((tick) => tick.getAttribute('aria-label'))).toEqual([
      '第 1 轮：问题 1',
      '第 2 轮：问题 2',
      '第 3 轮：问题 3',
    ])
    expect(ticks()[0]?.getAttribute('aria-current')).toBe('location')
    expect(ticks().map((tick) => tick.style.width)).toEqual(['12px', '12px', '12px'])
    // Only the current tick is a tab stop; arrows move between the others.
    expect(ticks().map((tick) => tick.tabIndex)).toEqual([0, -1, -1])
  })

  it('moves the current tick as the reader scrolls', async () => {
    await render(3)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    viewport.scrollTop = 700
    await act(async () => {
      viewport.dispatchEvent(new Event('scroll'))
    })
    expect(ticks()[2]?.getAttribute('aria-current')).toBe('location')
    expect(ticks()[0]?.hasAttribute('aria-current')).toBe(false)
    expect(ticks().map((tick) => tick.style.width)).toEqual(['12px', '12px', '12px'])
  })

  it('hides for one prompt, a narrow window and a gutter taken by the workbench', async () => {
    await render(1)
    expect(ticks()).toHaveLength(0)
    await act(async () => root.render(null))
    viewport.replaceChildren()
    vi.stubGlobal('innerWidth', 800)
    await render(3)
    expect(ticks()).toHaveLength(0)
    await act(async () => root.render(null))
    viewport.replaceChildren()
    vi.stubGlobal('innerWidth', 1320)
    gutter = 40
    await render(3)
    expect(ticks()).toHaveLength(0)
  })

  it('magnifies ticks near the pointer and previews the hovered prompt', async () => {
    vi.useFakeTimers()
    await render(5)
    const first = ticks()[0]
    if (!first) throw new Error('missing tick')
    first.getBoundingClientRect = () => new DOMRect(18, 100, 12, 2)
    const nav = shell.querySelector('nav')
    // Pitch is 9px (7px gap + 2px line); the first tick's centre is at 101. Point at the third.
    await act(async () => {
      nav?.dispatchEvent(new PointerEvent('pointermove', { clientY: 101 + 18, bubbles: true }))
    })
    expect(ticks().map((tick) => tick.style.width)).toEqual(['22px', '26px', '30px', '26px', '21.9px'])
    expect(ticks()[2]?.dataset.hot).toBe('true')
    expect(card()?.hidden).toBe(false)
    expect(card()?.textContent).toContain('第 3 轮')
    expect(card()?.querySelector('[data-testid="turn-nav-card-prompt"]')?.textContent).toBe('问题 3')
    expect(card()?.querySelector('[data-testid="turn-nav-card-reply"]')?.textContent).toBe('回答 3 第一段')
    expect(card()?.querySelector('[data-testid="turn-nav-card-more"]')?.textContent).toBe('第二段 3')
    // Leaving the rail restores every length immediately; the card stays briefly so it is reachable.
    await act(async () => {
      nav?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: card() }))
    })
    expect(ticks().map((tick) => tick.style.width)).toEqual(Array(5).fill('12px'))
    await act(async () => {
      card()?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: nav }))
      vi.advanceTimersByTime(200)
    })
    expect(card()?.hidden).toBe(false)
    await act(async () => {
      card()?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
      vi.advanceTimersByTime(200)
    })
    expect(card()?.hidden).toBe(true)
    expect(ticks().every((tick) => tick.dataset.hot === undefined)).toBe(true)
    expect(ticks().map((tick) => tick.style.width)).toEqual(Array(5).fill('12px'))
  })

  it('does not magnify under reduced motion', async () => {
    reduced = true
    await render(3)
    const first = ticks()[0]
    if (!first) throw new Error('missing tick')
    first.getBoundingClientRect = () => new DOMRect(18, 100, 12, 2)
    await act(async () => {
      shell
        .querySelector('nav')
        ?.dispatchEvent(new PointerEvent('pointermove', { clientY: 113.5, bubbles: true }))
    })
    expect(ticks().map((tick) => tick.style.width)).toEqual(['12px', '12px', '12px'])
    await act(async () => ticks()[2]?.click())
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 784, behavior: 'auto' })
  })

  it('says the answer is still being written, or how many tools ran without a reply', async () => {
    const nodes = [
      user('u1', '一'),
      assistant('a1', '写', true),
      user('u2', '二'),
      tool('t1'),
      tool('t2'),
      tool('t3'),
    ]
    const turns = [turn(1, ['u1', 'a1'], { status: 'running' }), turn(2, ['u2', 't1', 't2', 't3'])]
    const messages = document.createElement('section')
    messages.setAttribute('data-agnes-conversation-messages', '')
    viewport.append(messages)
    layout()
    await act(async () => root.render(createElement(TurnNav, { t: zhT, nodes, turns, viewport })))
    await act(async () => ticks()[0]?.focus())
    expect(card()?.querySelector('[data-testid="turn-nav-card-reply"]')?.textContent).toBe('回答中…')
    await act(async () => ticks()[1]?.focus())
    expect(card()?.querySelector('[data-testid="turn-nav-card-reply"]')?.textContent).toBe('调用了 3 个工具')
  })

  it('scrolls to the clicked or entered prompt and highlights it for 1.2 seconds', async () => {
    vi.useFakeTimers()
    await render(4)
    await act(async () => ticks()[2]?.click())
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 784, behavior: 'smooth' })
    const third = viewport.querySelector('[data-turn-id="turn:3"]')
    expect(third?.getAttribute('data-turn-nav-flash')).toBe('true')
    await act(async () => vi.advanceTimersByTime(TURN_NAV_FLASH_MS))
    expect(third?.hasAttribute('data-turn-nav-flash')).toBe(false)
    expect(ticks()[2]?.getAttribute('aria-current')).toBe('location')

    layout()
    await act(async () => ticks()[2]?.focus())
    await press('ArrowDown', {}, ticks()[2] as HTMLElement)
    expect(document.activeElement).toBe(ticks()[3])
    await press('Enter', {}, ticks()[3] as HTMLElement)
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1184, behavior: 'smooth' })
  })

  it('arrives within a screen of a far prompt at once and glides the rest', async () => {
    await render(6)
    viewport.scrollTop = 2000
    const seen: number[] = []
    scrollTo.mockImplementation((options: ScrollToOptions) => {
      seen.push(viewport.scrollTop)
      viewport.scrollTop = options.top ?? 0
    })
    await act(async () => ticks()[0]?.click())
    // Turn 1 sits at 0: the reader is put one screen (600px) below it, then glides up.
    expect(seen).toEqual([600])
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' })
  })

  it('moves to the previous and next prompt with ⌥↑ / ⌥↓, not while typing or when hidden', async () => {
    await render(3)
    await press('ArrowDown', { altKey: true })
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 384, behavior: 'smooth' })
    expect(ticks()[1]?.getAttribute('aria-current')).toBe('location')
    layout()
    await press('ArrowDown', { altKey: true })
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 784, behavior: 'smooth' })
    layout()
    await press('ArrowUp', { altKey: true })
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 384, behavior: 'smooth' })
    expect(scrollTo).toHaveBeenCalledTimes(3)

    const field = document.createElement('textarea')
    document.body.append(field)
    await press('ArrowUp', { altKey: true }, field)
    expect(scrollTo).toHaveBeenCalledTimes(3)

    // The trace view hides the conversation: the transcript has no boxes.
    viewport.getClientRects = () => [] as unknown as DOMRectList
    await press('ArrowUp', { altKey: true })
    expect(scrollTo).toHaveBeenCalledTimes(3)
  })

  it('loads earlier history with ⌥↑ on the first loaded prompt', async () => {
    const loadEarlier = vi.fn()
    await render(2, { hasEarlier: true, loadEarlier })
    await press('ArrowUp', { altKey: true })
    expect(loadEarlier).toHaveBeenCalledTimes(1)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('packs many prompts tighter', async () => {
    await render(80)
    expect(shell.querySelector('nav')?.getAttribute('data-dense')).toBe('true')
    // 80 prompts in a 600px pane: the 3px floor, so each row is 5px.
    expect(shell.querySelector<HTMLElement>('.turn-nav-item')?.style.height).toBe('5px')
  })

  it('saves bookmarks optimistically and puts the old list back when saving fails', async () => {
    let reject: (error: Error) => void = () => undefined
    const save = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail
        }),
    )
    await render(3, { bookmarks: ['u1'], onBookmarksChange: save })
    expect(ticks()[0]?.dataset.bookmarked).toBe('true')
    expect(ticks()[0]?.getAttribute('aria-label')).toBe('第 1 轮（已加书签）：问题 1')
    await act(async () => ticks()[2]?.focus())
    const button = () => card()?.querySelector<HTMLElement>('[data-testid="turn-nav-bookmark"]')
    expect(button()?.getAttribute('aria-pressed')).toBe('false')
    expect(button()?.getAttribute('aria-label')).toBe('加书签')
    await act(async () => button()?.click())
    expect(save).toHaveBeenCalledWith(['u1', 'u3'])
    expect(ticks()[2]?.dataset.bookmarked).toBe('true')
    expect(button()?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => reject(new Error('offline')))
    expect(ticks()[2]?.dataset.bookmarked).toBeUndefined()
    expect(card()?.textContent).toContain('书签没有保存，请重试。')
  })

  it('keeps the newest change on screen when an earlier save answers or fails first', async () => {
    const replies: { ok: () => void; fail: (error: Error) => void }[] = []
    const save = vi.fn(
      (_list: readonly string[]) =>
        new Promise<void>((ok, fail) => {
          replies.push({ ok, fail })
        }),
    )
    const { nodes, turns } = conversation(4)
    await render(4, { bookmarks: [], onBookmarksChange: save })
    const marked = () => ticks().flatMap((tick, index) => (tick.dataset.bookmarked ? [index] : []))
    const press = async (index: number) => {
      await act(async () => ticks()[index]?.focus())
      await act(async () => card()?.querySelector<HTMLElement>('[data-testid="turn-nav-bookmark"]')?.click())
    }
    await press(0)
    await press(1)
    expect(save.mock.calls.map(([list]) => list)).toEqual([['u1'], ['u1', 'u2']])
    // The first save answers and the host reports what it saved: the newer change stays.
    await act(async () => replies[0]?.ok())
    await act(async () =>
      root.render(
        createElement(TurnNav, {
          t: zhT,
          nodes,
          turns,
          viewport,
          bookmarks: ['u1'],
          onBookmarksChange: save,
        }),
      ),
    )
    expect(marked()).toEqual([0, 1])
    // A third change builds on the newest list, not on the first response.
    await press(2)
    expect(save).toHaveBeenLastCalledWith(['u1', 'u2', 'u3'])
    // The second save fails, but a newer change owns the list: no rollback, no error.
    await act(async () => replies[1]?.fail(new Error('offline')))
    expect(marked()).toEqual([0, 1, 2])
    expect(card()?.textContent).not.toContain('书签没有保存')
    // The newest save fails: the host's saved list comes back and the reader is told.
    await act(async () => replies[2]?.fail(new Error('offline')))
    expect(marked()).toEqual([0])
    expect(card()?.textContent).toContain('书签没有保存，请重试。')
  })

  it('offers no bookmark control when the host cannot save bookmarks', async () => {
    await render(3)
    await act(async () => ticks()[1]?.focus())
    expect(card()?.hidden).toBe(false)
    expect(card()?.querySelector('[data-testid="turn-nav-bookmark"]')).toBeNull()
  })
})

describe('turn navigator bookmark styling', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/conversation/messages.css'), 'utf8')
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`)
    if (start < 0) throw new Error(`missing rule ${selector}`)
    return css.slice(start, css.indexOf('}', start))
  }

  it('draws a bookmarked tick in the brand colour, thicker than the others', () => {
    expect(rule('.turn-nav-rail')).toContain('opacity: 0')
    expect(rule('.turn-nav-rail:is(:hover, :focus-within)')).toContain('opacity: 1')
    const tick = rule('.turn-nav-tick[data-bookmarked="true"]')
    expect(tick).toContain('background: var(--agnes-brand-primary)')
    expect(tick).toContain('height: 3px')
    // Declared after the current/hover rule, so a current or hovered bookmark stays brand.
    expect(css.indexOf('.turn-nav-tick[data-bookmarked="true"] {')).toBeGreaterThan(
      css.indexOf('.turn-nav-tick:is([data-current="true"], [data-hot="true"])'),
    )
  })

  it('puts the bookmark dot right of the tick, inside the rail, where scrolling cannot clip it', () => {
    const dot = rule('.turn-nav-tick[data-bookmarked="true"]::before')
    expect(dot).toContain('left: calc(100% + 4px)')
    expect(dot).toContain('width: 6px')
    expect(dot).toContain('background: var(--agnes-brand-primary)')
    expect(dot).not.toMatch(/left:\s*-/)
    // The dot (4px gap + 6px) fits in the rail's right padding.
    expect(rule('.turn-nav-rail')).toContain('padding: var(--s8) var(--s16) var(--s8) var(--s4)')
    // The hit area is unchanged.
    expect(rule('.turn-nav-tick::after')).toContain('inset: -4px -10px -4px -4px')
  })
})
