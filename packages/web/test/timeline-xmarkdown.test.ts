/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { UINode, UITurn } from '@agnes/protocol'
import { SlotRegistry } from '@agnes/web-client'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { mountTranscriptRegion } from '../src/region-slots.js'

const active: Array<{ ctx: Context; mount: ReturnType<typeof mountTranscriptRegion>; host: HTMLElement }> = []
afterEach(async () => {
  document.getSelection()?.removeAllRanges()
  for (const { ctx, mount, host } of active.splice(0)) {
    await act(async () => mount.dispose())
    await ctx.fiber.dispose()
    host.remove()
  }
  vi.restoreAllMocks()
})
async function setup() {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const registry = (ctx as unknown as { slots: SlotRegistry }).slots
  registry.setSession('session')
  const host = document.createElement('section')
  host.id = 'transcript'
  document.body.append(host)
  const mount = mountTranscriptRegion(registry, host, { nodeHost: 'react', markdownRenderer: 'xmarkdown' })
  active.push({ ctx, mount, host })
  return { registry, host, mount }
}
const assistant = (text: string, thinking = '', streaming = true): UINode => ({
  kind: 'assistant',
  id: 'a',
  seq: 2,
  effectId: 'e',
  text,
  thinking,
  streaming,
})
const user: UINode = { kind: 'user', id: 'u', seq: 1, content: [{ type: 'text', text: 'request' }] }
const turn = (status: UITurn['status'] = 'running', final = false): UITurn => ({
  id: 't',
  turn: 1,
  startSeq: 1,
  startedAt: '2026-09-26T00:00:00Z',
  status,
  nodeIds: ['u', 'a'],
  ...(final ? { finalAssistantId: 'a' } : {}),
  usage: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: true,
    calls: [],
  },
  inherited: false,
  forkable: false,
})

it.each(['completed', 'failed', 'cancelled'] as const)(
  'flushes body and thinking at %s despite a retained node stream flag',
  async (status) => {
    const { host, mount } = await setup()
    await act(async () =>
      mount.render([user, assistant('body **unfinished', 'thought `unfinished')], [turn()]),
    )
    expect(host.querySelector('[data-conversation-markdown="body"]')).not.toBeNull()
    expect(host.querySelector('.node-body')?.textContent).not.toContain('**unfinished')
    expect(host.querySelector('.thinking-content')?.textContent).not.toContain('`unfinished')
    const article = host.querySelector('[data-node-id="a"]')
    await act(async () =>
      mount.render([user, assistant('body **unfinished', 'thought `unfinished')], [turn(status)]),
    )
    expect(host.querySelector('[data-node-id="a"]')).toBe(article)
    expect(article?.getAttribute('data-streaming')).toBe('false')
    expect(article?.querySelector('.node-body')?.textContent).toContain('body **unfinished')
    expect(article?.querySelector('.thinking-content')?.textContent).toContain('thought `unfinished')
    expect(host.querySelector('[data-turn-id="t"]')?.getAttribute('data-status')).toBe(status)
  },
)

it('holds selection through final promotion, preserves code focus, replay/order and session reset', async () => {
  const { registry, host, mount } = await setup()
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const initial = 'stable\n\nselected tail\n\n```ts\nold code\n```'
  await act(async () => mount.render([user, assistant(initial)], [turn()]))
  const article = host.querySelector('[data-node-id="a"]')
  const stable = article?.querySelector('.node-body p')
  const selected = article?.querySelectorAll('.node-body p')[1]
  const selection = document.getSelection()
  const range = document.createRange()
  range.selectNodeContents(selected ?? host)
  selection?.addRange(range)
  const final = 'stable\n\nfinal **answer**\n\n```ts\nnew code\n```'
  await act(async () =>
    mount.render([user, assistant(final, 'final thought', false)], [turn('completed', true)]),
  )
  expect(host.querySelector('[data-node-id="a"]')).toBe(article)
  expect(selection?.toString()).toBe('selected tail')
  expect(article?.querySelector('.node-body p')).toBe(stable)
  expect(article?.querySelector('.node-body')?.textContent).not.toContain('answer')
  await act(async () => {
    selection?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
  })
  expect(article?.querySelector('.node-body strong')?.textContent).toBe('answer')
  expect(host.querySelectorAll('[data-conversation-markdown="thinking"]')).toHaveLength(1)
  expect(host.querySelector('.turn-process [data-conversation-markdown="thinking"]')?.textContent).toContain(
    'final thought',
  )
  const copy = article?.querySelector<HTMLButtonElement>('.code-copy')
  await act(async () => {
    copy?.focus()
    copy?.click()
  })
  await act(async () =>
    mount.render(
      [user, assistant('stable\n\nreplacement\n\n```ts\nlatest code\n```', '', false)],
      [turn('completed', true)],
    ),
  )
  expect(document.activeElement).toBe(copy)
  expect(article?.querySelector('pre code')?.textContent).toBe('new code\n')
  expect(copy?.textContent).toBe('已复制')
  await act(async () => copy?.click())
  expect(writeText).toHaveBeenLastCalledWith('new code')
  await act(async () => {
    copy?.blur()
    await Promise.resolve()
  })
  expect(article?.querySelector('pre code')?.textContent).toBe('latest code\n')
  expect(article?.querySelector('.code-copy')).toBe(copy)
  const nodes = [user, assistant('stable\n\nreplacement\n\n```ts\nlatest code\n```', '', false)]
  await act(async () => mount.render(nodes, [turn('completed', true)]))
  expect(host.querySelector('[data-node-id="a"]')).toBe(article)
  expect(
    [...host.querySelectorAll('[data-node-id]')].map((node) => node.getAttribute('data-node-id')),
  ).toEqual(['u', 'a'])
  const older: UINode = { kind: 'assistant', id: 'older', seq: 0, text: 'history' }
  await act(async () => mount.render([older, ...nodes], [turn('completed', true)]))
  expect(host.querySelector('[data-node-id="a"]')).toBe(article)
  await act(async () => copy?.focus())
  await act(async () => mount.render([assistant('pending replacement')]))
  await act(async () => {
    registry.setSession('new')
    mount.reset()
    mount.render([assistant('new session', '', false)])
  })
  expect(host.querySelector('[data-node-id="a"]')).not.toBe(article)
  expect(host.textContent).toContain('new session')
  document.dispatchEvent(new Event('selectionchange'))
  expect(host.textContent).not.toContain('pending replacement')
})

it('retains selected thinking until release when a final answer promotes it into the process area', async () => {
  const { host, mount } = await setup()
  await act(async () => mount.render([user, assistant('', 'selected thought')], [turn()]))
  const thinking = host.querySelector('[data-node-id="a"] [data-conversation-markdown="thinking"]')
  const paragraph = thinking?.querySelector('p')
  const selection = document.getSelection()
  const range = document.createRange()
  range.selectNodeContents(paragraph ?? host)
  selection?.addRange(range)
  await act(async () =>
    mount.render([user, assistant('final body', 'latest thought', false)], [turn('completed', true)]),
  )
  expect(thinking?.isConnected).toBe(true)
  expect(selection?.toString()).toBe('selected thought')
  expect(host.querySelectorAll('[data-conversation-markdown="thinking"]')).toHaveLength(1)
  await act(async () => {
    selection?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
  })
  expect(host.querySelector('.turn-process [data-conversation-markdown="thinking"]')?.textContent).toContain(
    'latest thought',
  )
  expect(host.querySelectorAll('[data-conversation-markdown="thinking"]')).toHaveLength(1)
  expect(host.querySelector('.turn-final .node-body')?.textContent).toContain('final body')
})

it('retains focused thinking code through terminal handover and clears it on dispose', async () => {
  const { host, mount } = await setup()
  await act(async () => mount.render([user, assistant('', '```ts\nold thought\n```')], [turn()]))
  const copy = host.querySelector<HTMLButtonElement>('.thinking-content .code-copy')
  await act(async () => copy?.focus())
  await act(async () =>
    mount.render([user, assistant('answer', '```ts\nfinal thought\n```', false)], [turn('completed', true)]),
  )
  expect(copy?.isConnected).toBe(true)
  expect(document.activeElement).toBe(copy)
  expect(host.querySelectorAll('[data-conversation-markdown="thinking"]')).toHaveLength(1)
  expect(host.querySelector('.thinking-content code')?.textContent).toBe('old thought\n')
  await act(async () => {
    copy?.blur()
    await Promise.resolve()
  })
  expect(host.querySelector('.turn-process .thinking-content code')?.textContent).toBe('final thought\n')
  const moved = host.querySelector('.turn-process .thinking-content')
  const selection = document.getSelection()
  const range = document.createRange()
  range.selectNodeContents(moved ?? host)
  selection?.addRange(range)
  await act(async () =>
    mount.render([user, assistant('answer', 'new pending thought', false)], [turn('completed', true)]),
  )
  await act(async () => mount.dispose())
  document.dispatchEvent(new Event('selectionchange'))
  expect(host.querySelector('[data-node-id="a"]')).toBeNull()
})

it.each(['failed', 'cancelled'] as const)(
  'keeps selected process output visible at %s until interaction release',
  async (status) => {
    const { host, mount } = await setup()
    await act(async () => mount.render([user, assistant('selected process')], [turn()]))
    const body = host.querySelector('[data-node-id="a"] .node-body')
    const selection = document.getSelection()
    const range = document.createRange()
    range.selectNodeContents(body?.querySelector('p') ?? host)
    selection?.addRange(range)
    await act(async () => mount.render([user, assistant('terminal **partial', '', false)], [turn(status)]))
    expect(body?.closest('[hidden]')).toBeNull()
    expect(selection?.toString()).toBe('selected process')
    expect(host.querySelector('.turn-process')?.hasAttribute('open')).toBe(true)
    await act(async () => {
      selection?.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(body?.textContent).toContain('terminal **partial')
    expect(host.querySelector('.turn-process')?.hasAttribute('open')).toBe(false)
  },
)

it('keeps selected thinking visible when a terminal replacement removes that part', async () => {
  const { host, mount } = await setup()
  await act(async () => mount.render([user, assistant('', 'selected thought')], [turn()]))
  const thinking = host.querySelector('[data-node-id="a"] [data-conversation-markdown="thinking"]')
  const selection = document.getSelection()
  const range = document.createRange()
  range.selectNodeContents(thinking?.querySelector('p') ?? host)
  selection?.addRange(range)
  await act(async () => mount.render([user, assistant('answer', '', false)], [turn('completed', true)]))
  expect(thinking?.isConnected).toBe(true)
  expect(thinking?.closest('[hidden]')).toBeNull()
  expect(selection?.toString()).toBe('selected thought')
  await act(async () => {
    selection?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
  })
  expect(host.querySelectorAll('[data-conversation-markdown="thinking"]')).toHaveLength(0)
  expect(host.querySelector('.turn-final .node-body')?.textContent).toContain('answer')
})
