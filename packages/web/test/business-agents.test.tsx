/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { PackageCatalogDescriptor } from '@agnes/protocol'
import { homeNavigation, SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createBusinessAgentSuggestions,
  featuredBusinessAgents,
  isBusinessAgent,
  listBusinessAgents,
} from '../src/pages/business-agents.js'
import { EMPTY_STATE_DSH_CHILDREN } from '../src/regions/contracts.js'
import { EmptyStateBuiltin } from '../src/regions/empty-state.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const agent = (name: string, metadata?: Record<string, unknown>, scope = '@agnes-fde') =>
  ({
    id: `${scope}/${name}`,
    version: '1.0.0',
    ...(metadata ? { metadata: { displayName: name, summary: `${name} summary`, ...metadata } } : {}),
  }) as unknown as PackageCatalogDescriptor

afterEach(() => {
  homeNavigation.close()
  document.body.replaceChildren()
})

it('recognises a business agent by its category, or by the package scope older catalogs use', () => {
  expect(isBusinessAgent(agent('crm', { category: 'business-agent' }, '@acme'))).toBe(true)
  expect(isBusinessAgent(agent('crm'))).toBe(true)
  expect(isBusinessAgent(agent('dag-loop', { category: 'developer' }, '@agnes-example'))).toBe(false)
})

it('reads every catalog page and suggests three different kinds of work first', async () => {
  const catalog = vi
    .fn()
    .mockResolvedValueOnce({
      items: [
        agent('compliance-audit'),
        agent('dag-loop', undefined, '@agnes-example'),
        agent('data-report'),
      ],
      nextCursor: 'next',
    })
    .mockResolvedValueOnce({ items: [agent('code-review'), agent('crm-assistant')], nextCursor: null })
  const rows = await listBusinessAgents(catalog)
  expect(catalog).toHaveBeenNthCalledWith(2, undefined, 'next')
  expect(rows.map((row) => row.id)).toEqual([
    '@agnes-fde/compliance-audit',
    '@agnes-fde/data-report',
    '@agnes-fde/code-review',
    '@agnes-fde/crm-assistant',
  ])
  expect(featuredBusinessAgents(rows).map((row) => row.id)).toEqual([
    '@agnes-fde/code-review',
    '@agnes-fde/data-report',
    '@agnes-fde/compliance-audit',
  ])
})

it('suggests business agents with their sample prompt, and plain tasks when there are none', async () => {
  const rows = [
    agent('code-review', { samplePrompt: { en: 'Review the sample patch.' } }),
    agent('data-report', {}),
  ]
  const read = vi.fn().mockRejectedValueOnce(new Error('no admin access')).mockResolvedValue(rows)
  const suggestions = createBusinessAgentSuggestions(read)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const registry = (ctx as unknown as { slots: SlotRegistry }).slots
  for (const [name, spec] of Object.entries(EMPTY_STATE_DSH_CHILDREN)) registry.declare(name, spec, 'test')
  try {
    await act(async () =>
      root.render(
        createElement(SlotsProvider, { registry }, createElement(EmptyStateBuiltin, { suggestions })),
      ),
    )
    // The first read failed: the plain suggestions stay and no card is shown.
    expect(host.querySelectorAll('[data-testid="agent-suggestion"]')).toHaveLength(0)
    expect(host.querySelectorAll('[data-testid="task-suggestions"] button')).toHaveLength(3)
    await act(async () => suggestions.refresh())
    const cards = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="agent-suggestion"]')]
    expect(cards.map((card) => card.dataset.package)).toEqual([
      '@agnes-fde/code-review',
      '@agnes-fde/data-report',
    ])
    expect(cards[0]?.textContent).toContain('Review the sample patch.')
    // Without a sample prompt the card says what the agent is for.
    expect(cards[1]?.textContent).toContain('data-report summary')
    expect(host.querySelector('[data-testid="task-suggestions"]')).toBeNull()
    await act(async () => cards[1]?.click())
    expect(homeNavigation.getSnapshot()).toEqual({
      id: 'agents',
      selection: { focus: '@agnes-fde/data-report' },
    })
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="agent-suggestions-all"]')?.click(),
    )
    expect(homeNavigation.getSnapshot()).toEqual({ id: 'agents' })
  } finally {
    await act(async () => root.unmount())
    await ctx.fiber.dispose()
  }
})
