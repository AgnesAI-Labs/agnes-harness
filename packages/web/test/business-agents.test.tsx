/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { PackageCatalogDescriptor } from '@agnes/protocol'
import { homeNavigation, SlotRegistry, SlotsProvider } from '@agnes/web-client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  businessAgentSuggestions,
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
    ...(scope !== '@agnes-example'
      ? { agents: { work: { title: { en: name }, description: { en: name }, preset: 'safe' } } }
      : {}),
    version: '1.0.0',
    ...(metadata ? { metadata: { displayName: name, summary: `${name} summary`, ...metadata } } : {}),
  }) as unknown as PackageCatalogDescriptor

afterEach(() => {
  vi.restoreAllMocks()
  homeNavigation.close()
  document.body.replaceChildren()
})

it('recognises a business agent by its explicit launch declaration', () => {
  expect(isBusinessAgent(agent('crm', {}, '@acme'))).toBe(true)
  expect(isBusinessAgent(agent('crm'))).toBe(true)
  expect(isBusinessAgent(agent('dag-loop', {}, '@agnes-example'))).toBe(false)
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

it('keeps the hero free of cards even when the business-agent catalog is available', async () => {
  vi.spyOn(businessAgentSuggestions, 'refresh').mockResolvedValue()
  const rows = [
    agent('code-review', { samplePrompt: { en: 'Review the sample patch.' } }),
    agent('data-report', {}),
  ]
  const suggestions = createBusinessAgentSuggestions(async () => rows)
  await suggestions.refresh()
  expect(suggestions.getSnapshot().featured).toHaveLength(2)
  vi.spyOn(businessAgentSuggestions, 'getSnapshot').mockReturnValue(suggestions.getSnapshot())
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const registry = (ctx as unknown as { slots: SlotRegistry }).slots
  for (const [name, spec] of Object.entries(EMPTY_STATE_DSH_CHILDREN)) registry.declare(name, spec, 'test')
  try {
    await act(async () =>
      root.render(createElement(SlotsProvider, { registry }, createElement(EmptyStateBuiltin))),
    )
    expect(
      host.querySelectorAll(
        '[data-testid="agent-suggestion"], [data-testid="task-suggestions"], .empty-state-agents-note',
      ),
    ).toHaveLength(0)
    expect(host.querySelector('.empty-state-copy')?.textContent).toBe('app.emptyState.tagline')
  } finally {
    await act(async () => root.unmount())
    await ctx.fiber.dispose()
  }
})
