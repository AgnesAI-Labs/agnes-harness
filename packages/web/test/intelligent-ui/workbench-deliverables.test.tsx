/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import { type ClientResourceService, factChainLinks, workbenchNavigation } from '@agnes/web-client'
import { workbenchLocaleCatalog } from '@agnes/web-conversation/workbench'
import { createCatalogTranslator, createDocumentLocaleSource } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { IntelligentUiClient } from '../../src/intelligent-ui/client.js'
import type { UiPlacementBinding } from '../../src/intelligent-ui/placements.js'
import { attachTurnDeliverables, TurnDeliverables } from '../../src/intelligent-ui/turn-deliverables.js'
import {
  deliverableGroups,
  deliverableSource,
  deliverablesCount,
  sessionDeliverables,
  WorkbenchDeliverables,
} from '../../src/intelligent-ui/workbench-deliverables.js'

const sha = (n: number) => String(n).repeat(64).slice(0, 64)
const fileList = (
  id: string,
  createdSeq: number,
  files: { name: string; description: string; sha: string; mime?: string }[],
  placement = { inline: true, workbench: true, preferred: 'inline' },
) =>
  ({
    surface: {
      id,
      revision: 1,
      title: 'Deliverables',
      titleKey: 'ui.deliverables',
      placement,
      components: files.map((_, i) => ({ id: `file-${i}`, kind: 'artifact-file', dataKey: `file-${i}` })),
      data: Object.fromEntries(
        files.map((file, i) => [
          `file-${i}`,
          {
            name: file.name,
            description: file.description,
            artifact: { sha256: file.sha, size: 25_190, mime: file.mime ?? 'text/markdown' },
          },
        ]),
      ),
      actions: [],
    },
    status: 'open',
    createdSeq,
    updatedSeq: createdSeq,
    owner: 'deliverables',
    lane: 'main',
    taskId: 'task',
  }) as unknown as UiSurfaceRecord

const surfaces = [
  fileList('draft', 12, [{ name: 'report.md', description: 'crm-assistant: review draft', sha: sha(2) }]),
  fileList('final', 18, [
    { name: 'report.md', description: 'crm-assistant: final', sha: sha(3) },
    { name: 'portal.html', description: 'crm-assistant: final', sha: sha(4), mime: 'text/html' },
  ]),
  fileList('trip', 20, [{ name: 'trip.md', description: 'travel: review draft', sha: sha(5) }]),
  fileList('notes', 22, [{ name: 'notes.txt', description: 'meeting notes', sha: sha(6) }], {
    inline: true,
    workbench: false,
    preferred: 'inline',
  }),
  // A view with a table is not a deliverable and never appears in this tab.
  {
    ...fileList('view', 24, []),
    surface: {
      ...fileList('view', 24, []).surface,
      components: [{ id: 'table', kind: 'table', dataKey: 'rows', columns: [] }],
    },
  } as unknown as UiSurfaceRecord,
]

function binding(records: UiSurfaceRecord[], resources?: ClientResourceService): UiPlacementBinding {
  const listeners = new Set<() => void>()
  const client = {
    sessionId: 's',
    getSnapshot: () => ({ surfaces: records }),
    knownRecord: (id: string) => records.find((record) => record.surface.id === id),
    lookup: async () => {},
  } as unknown as IntelligentUiClient
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => client,
    getVersion: () => 0,
    locale: createDocumentLocaleSource({}).source,
    target: () => undefined,
    expand: vi.fn(),
    approval: vi.fn(),
    ...(resources ? { resources } : {}),
  }
}

it('groups the newest version of each file by final and review draft, and folds every earlier one', () => {
  const entries = sessionDeliverables(surfaces)
  expect(entries.map((entry) => entry.file.name)).toEqual([
    'report.md',
    'report.md',
    'portal.html',
    'trip.md',
    'notes.txt',
  ])
  const { groups, earlier } = deliverableGroups(entries)
  expect(groups.map((group) => [group.group, group.entries.map((entry) => entry.file.name)])).toEqual([
    ['final', ['report.md', 'portal.html']],
    ['review', ['trip.md']],
    ['other', ['notes.txt']],
  ])
  expect(earlier.map((entry) => entry.file.artifact.sha256)).toEqual([sha(2)])
  const count = deliverablesCount(binding(surfaces))
  // A newer version replaces its file: four files, not five entries.
  expect(count.read({ t: (key) => key, data: { session: { id: 's' } } })).toBe(4)
  expect(count.read({ t: (key) => key, data: { session: { id: 'other' } } })).toBeUndefined()
})

it('shows conversation-style cards under group headings and previews the opened card right under it', async () => {
  const release = vi.fn()
  const load = vi.fn(async () => ({ kind: 'markdown', content: '# Report', release }))
  const resources = { documents: { load }, files: { load: vi.fn() } } as unknown as ClientResourceService
  const sessionBinding = binding(surfaces, resources)
  const opened = vi.fn(() => true)
  const stopLinks = factChainLinks.register(opened)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const t = createCatalogTranslator(workbenchLocaleCatalog, 'zh-CN')
  const timeline = {
    nodes: [
      {
        kind: 'artifact',
        id: 'a',
        seq: 31,
        name: 'report.md',
        ref: { sha256: sha(3), size: 1, mime: 'text/markdown' },
      },
    ],
  }
  await act(async () =>
    root.render(
      createElement(WorkbenchDeliverables, {
        binding: sessionBinding,
        context: { t, data: { session: { id: 's' }, timeline } },
      }),
    ),
  )
  try {
    const panel = host.querySelector('[data-testid="workbench-deliverables"]') as HTMLElement
    expect(
      [...panel.querySelectorAll('.workbench-deliverables-group > h4')].map((h) => h.textContent),
    ).toEqual(['最终版', '审阅稿', '文件'])
    const cards = [
      ...panel.querySelectorAll('.workbench-deliverables-group [data-testid="deliverable-file"]'),
    ]
    expect(cards.map((card) => card.querySelector('.deliverable-name')?.textContent)).toEqual([
      'report.md',
      'portal.html',
      'trip.md',
      'notes.txt',
    ])
    // The same card as in the answer: type tile, name, version · size, 打开 | ⌄.
    expect(cards[1]?.querySelector('.deliverable-tile')?.getAttribute('data-type')).toBe('html')
    expect(cards[0]?.querySelector('.deliverable-meta')?.textContent).toBe('Final · 24.6 KiB')
    expect(cards[0]?.querySelector('[data-testid="deliverable-open-with"]')).not.toBeNull()
    const earlier = panel.querySelector('[data-testid="workbench-deliverables-earlier"]') as HTMLElement
    expect(earlier.dataset.open).toBe('false')
    expect(earlier.querySelector('.agh-disclosure-summary')?.textContent).toBe('早期版本 · 1')
    expect(panel.textContent).not.toContain('crm-assistant')
    await act(async () =>
      cards[0]?.querySelector<HTMLButtonElement>('[data-testid="deliverable-open"]')?.click(),
    )
    await vi.waitFor(() =>
      expect(cards[0]?.querySelector('[data-testid="deliverable-preview"]')).not.toBeNull(),
    )
    expect(cards[0]?.querySelector('[data-testid="deliverable-preview-close"]')).not.toBeNull()
    expect(cards[0]?.closest('li')?.getAttribute('data-chosen')).toBe('true')
    expect(panel.querySelector('.workbench-tab-footer')?.textContent).toContain(
      '每个交付物都能追到产生它的工具调用',
    )
    await act(async () =>
      panel.querySelector<HTMLButtonElement>('[data-testid="deliverables-source"]')?.click(),
    )
    expect(opened).toHaveBeenCalledWith({
      sessionId: 's',
      laneId: 'main',
      anchor: { kind: 'artifact', seq: 31, ref: { sha256: sha(3), size: 1, mime: 'text/markdown' } },
    })
    // A file without a recorded artifact has no source link rather than a guessed one.
    await act(async () => cards[2]?.querySelector<HTMLElement>('.deliverable-name')?.click())
    expect(panel.querySelector('[data-testid="deliverables-source"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    stopLinks()
    host.remove()
  }
  expect(release).toHaveBeenCalledOnce()
})

it('says when a session has no deliverables, and opens this tab from a conversation card', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const empty = binding([])
  const t = createCatalogTranslator(workbenchLocaleCatalog, 'en')
  await act(async () =>
    root.render(
      createElement(WorkbenchDeliverables, {
        binding: empty,
        context: { t, data: { session: { id: 's' } } },
      }),
    ),
  )
  expect(host.textContent).toBe('No deliverables in this session yet.')
  const sessionBinding = binding(surfaces, {} as ClientResourceService)
  const detach = attachTurnDeliverables(sessionBinding)
  const navigate = vi.fn(() => true)
  const stop = workbenchNavigation.register(navigate)
  await act(async () =>
    root.render(createElement(TurnDeliverables, { turn: { startSeq: 15, endSeq: 19 } as never })),
  )
  try {
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="deliverable-open"]')?.click())
    expect(navigate).toHaveBeenCalledWith('deliverables')
    expect(sessionBinding.expand).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    stop()
    detach()
    host.remove()
  }
})

it('the tab shows no earlier version for an identical repeat, and labels a changed one by time and size', async () => {
  const at = Date.parse('2026-10-14T08:16:00.000Z')
  const time = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(new Date(at))
  const presented = (id: string, seq: number, digest: string, size: number, when: number) => {
    const record = fileList(id, seq, [
      { name: 'index.html', description: '咖啡豆门户站', sha: digest, mime: 'text/html' },
    ])
    const file = record.surface.data['file-0'] as { artifact: { size: number } }
    file.artifact.size = size
    record.surface.data.presentedAt = when
    return record
  }
  const t = createCatalogTranslator(workbenchLocaleCatalog, 'zh-CN')
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const show = (records: UiSurfaceRecord[]) =>
    act(async () =>
      root.render(
        createElement(WorkbenchDeliverables, {
          binding: binding(records),
          context: { t, data: { session: { id: 's' } } },
        }),
      ),
    )
  try {
    // Presented twice with the same bytes: one file, no «早期版本».
    await show([presented('a', 10, sha(7), 15_155, at), presented('b', 11, sha(7), 15_155, at + 60_000)])
    expect(host.querySelectorAll('[data-testid="deliverable-file"]')).toHaveLength(1)
    expect(host.querySelector('[data-testid="workbench-deliverables-earlier"]')).toBeNull()
    // Changed bytes: the older one is an earlier version that says when and how it differs.
    await show([presented('a', 10, sha(7), 14_000, at), presented('c', 12, sha(8), 15_229, at + 120_000)])
    const earlier = host.querySelector(
      '[data-testid="workbench-deliverables-earlier"] [data-testid="deliverable-file"]',
    )
    expect(earlier?.getAttribute('data-version')).toBe('earlier')
    expect(earlier?.querySelector('.deliverable-meta')?.textContent).toBe(
      `Version from ${time} · 1.2 KiB smaller than the latest`,
    )
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('links a file to its artifact record, else to the tool call its file list was created in', () => {
  const [entry] = sessionDeliverables([surfaces[1] as UiSurfaceRecord])
  if (!entry) throw new Error('missing entry')
  const client = { knownRecord: (id: string) => surfaces.find((record) => record.surface.id === id) }
  const tool = (toolUseId: string, seq: number, resultSeq?: number) => ({
    kind: 'tool',
    id: toolUseId,
    seq,
    toolUseId,
    name: 'present',
    status: 'completed',
    summary: 'present',
    ...(resultSeq ? { resultSeq } : {}),
  })
  // The file list «final» was created at seq 18, inside «present» (16–19) and the helper call it ran.
  const timeline = {
    nodes: [tool('before', 10, 12), tool('present', 16, 19), tool('ui_render', 17, 18), tool('after', 20)],
  } as never
  expect(deliverableSource(timeline, entry, client, 's')).toEqual({
    sessionId: 's',
    laneId: 'main',
    anchor: { kind: 'tool', toolUseId: 'present' },
  })
  expect(deliverableSource({ nodes: [tool('before', 10, 12)] } as never, entry, client, 's')).toBeUndefined()
  expect(deliverableSource(undefined, entry, client, 's')).toBeUndefined()
})
