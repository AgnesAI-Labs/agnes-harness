/** @vitest-environment happy-dom */

import { Context } from '@agnes/cordis'
import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { discoverableAgent, exampleDiscovery } from '@agnes/web-admin/agents'
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
      ? {
          agents: [
            {
              ref: 'acme/kit#work',
              launch: { title: { en: name }, description: { en: name }, preset: 'safe' },
            },
          ],
        }
      : {}),
    source: { type: 'file', ref: `file:./bundled-examples/showcase/${name}` },
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
  for (const ref of ['file:./bundled-examples/showcase/industry', 'file:./examples/showcase/industry']) {
    const showcase = { ...agent('arbitrary-name', {}, '@community'), source: { type: 'file' as const, ref } }
    expect(exampleDiscovery(showcase)).toEqual({ family: 'showcase', featured: true })
    expect(featuredBusinessAgents([showcase])).toEqual([showcase])
  }
  for (const ref of ['file:./bundled-examples/fde/data-report', 'file:./examples/loops/dag-loop']) {
    const teaching = { ...agent('not-a-prefix'), source: { type: 'file' as const, ref } }
    expect(discoverableAgent(teaching)).toBe(false)
    expect(discoverableAgent(teaching, [{ id: teaching.id } as PackageInstalledDescriptor])).toBe(true)
    expect(featuredBusinessAgents([teaching])).toEqual([])
  }
  expect(exampleDiscovery({ ...agent('industry'), source: { type: 'npm', ref: 'industry' } }).featured).toBe(
    false,
  )
})

it('reads every catalog page and suggests explicit agents in catalog order', async () => {
  const catalog = vi
    .fn()
    .mockResolvedValueOnce({
      items: [agent('support-triage'), agent('dag-loop', undefined, '@agnes-example'), agent('data-report')],
      nextCursor: 'next',
    })
    .mockResolvedValueOnce({ items: [agent('knowledge-qa'), agent('support-triage')], nextCursor: null })
  const rows = await listBusinessAgents(catalog)
  expect(catalog).toHaveBeenNthCalledWith(2, undefined, 'next')
  expect(rows.map((row) => row.id)).toEqual([
    '@agnes-fde/support-triage',
    '@agnes-fde/data-report',
    '@agnes-fde/knowledge-qa',
    '@agnes-fde/support-triage',
  ])
  expect(featuredBusinessAgents(rows).map((row) => row.id)).toEqual([
    '@agnes-fde/support-triage',
    '@agnes-fde/data-report',
    '@agnes-fde/knowledge-qa',
  ])
  const ready = rows[0]!
  const unavailable = {
    ...ready,
    agents: [{ ...ready.agents![0]!, ref: 'acme/kit#unavailable' }],
  }
  const declared = await listBusinessAgents(async () => ({ items: [ready, unavailable] }))
  expect(declared.map((row) => row.agents?.[0]?.ref)).toEqual([ready.agents![0]!.ref, 'acme/kit#unavailable'])
})

it('keeps the hero free of cards even when the business-agent catalog is available', async () => {
  vi.spyOn(businessAgentSuggestions, 'refresh').mockResolvedValue()
  const rows = [
    agent('knowledge-qa', { samplePrompt: { en: 'Review the sample patch.' } }),
    agent('data-report', {}),
  ]
  const read = vi.fn(async () => rows)
  const suggestions = createBusinessAgentSuggestions(read)
  await Promise.all([suggestions.refresh(), suggestions.refresh()])
  expect(read).toHaveBeenCalledTimes(1)
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

it('projects one card per explicit declaration, including several agents in one plugin and no prefix fallback', async () => {
  const { declaredAgentCards } = await import('../src/pages/agents-model.js')
  const base = agent('support', { displayName: 'Plugin name' }, '@acme')
  const rows = [
    {
      ...base,
      agents: [
        {
          ref: '@acme/support#triage',
          launch: {
            title: { en: 'Triage', 'zh-CN': '分诊' },
            description: { en: 'Sort incoming work' },
            preset: 'safe',
          },
        },
        {
          ref: '@acme/support#reply',
          launch: {
            title: { en: 'Reply' },
            description: { en: 'Prepare a reply' },
            preset: 'review',
            prompt: { mode: 'draft' as const, text: { en: 'Draft a response' } },
          },
        },
      ],
    },
    { ...base, id: '@agnes-fde/legacy', agents: [] },
  ]

  const teaching = {
    ...base,
    source: { type: 'file' as const, ref: 'file:./bundled-examples/fde/support-triage' },
  }
  expect(declaredAgentCards([teaching], 'en')).toEqual([])
  expect(featuredBusinessAgents([teaching])).toEqual([])
  expect(declaredAgentCards([], 'en')).toEqual([])
  const cards = declaredAgentCards(rows, 'zh-CN')
  expect(cards.map((card) => [card.declaration.ref, card.name, card.summary, card.samplePrompt])).toEqual([
    ['@acme/support#triage', '分诊', 'Sort incoming work', undefined],
    ['@acme/support#reply', 'Reply', 'Prepare a reply', 'Draft a response'],
  ])
  expect(new Set(cards.map((card) => card.slug)).size).toBe(2)
  const installed: PackageInstalledDescriptor = {
    id: base.id,
    version: '2.0.0',
    trusted: true,
    desired: 'enabled',
    actual: 'running',
    source: { type: 'file', ref: 'file:./support' },
    integrity: 'sha512-support',
    contributions: [],
    blockers: [],
    agents: cards.filter((card) => card.ref === '@acme/support#reply').map((card) => card.declaration),
  }
  expect(declaredAgentCards([teaching], 'en', [installed]).map((card) => card.ref)).toEqual([
    '@acme/support#reply',
  ])
  const current = declaredAgentCards(rows, 'en', [installed])
  expect(current.map((card) => card.ref)).toEqual(['@acme/support#reply'])
  expect(current[0]?.entry).toBe(installed)
  expect(current[0]?.catalogAgent).toBeUndefined()
  expect(current[0]?.entry).not.toHaveProperty('sourceId')
  expect(current[0]?.entry).not.toHaveProperty('compatibility')
  const disabled = declaredAgentCards(rows, 'en', [{ ...installed, desired: 'installed-disabled' }])
  expect(disabled[0]?.catalogAgent?.ref).toBe('@acme/support#reply')
  expect(disabled[0]?.catalogAgent?.entry.agents?.map((agent) => agent.ref)).toEqual(['@acme/support#reply'])
})
