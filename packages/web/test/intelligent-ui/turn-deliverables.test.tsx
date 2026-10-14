/** @vitest-environment happy-dom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true })

import type { UITurn } from '@agnes/protocol'
import type { UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import { createDocumentLocaleSource } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ArtifactFile } from '../../src/intelligent-ui/artifact-file.js'
import type { IntelligentUiClient } from '../../src/intelligent-ui/client.js'
import {
  deliverableKey,
  deliverableType,
  deliverableVersion,
  deliverableVersions,
  groupDeliverables,
} from '../../src/intelligent-ui/deliverable-labels.js'
import type { UiPlacementBinding } from '../../src/intelligent-ui/placements.js'
import {
  attachTurnDeliverables,
  TurnDeliverables,
  turnDeliverables,
} from '../../src/intelligent-ui/turn-deliverables.js'

const sha = (n: number) => String(n).repeat(64).slice(0, 64)
const fileList = (
  id: string,
  createdSeq: number,
  files: { name: string; description: string; sha: string; size?: number }[],
  presentedAt?: number,
) =>
  ({
    surface: {
      id,
      revision: 1,
      title: 'Deliverables',
      titleKey: 'ui.deliverables',
      placement: { inline: true, workbench: true, preferred: 'inline' },
      components: files.map((_, i) => ({ id: `file-${i}`, kind: 'artifact-file', dataKey: `file-${i}` })),
      data: Object.fromEntries([
        ...files.map((file, i) => [
          `file-${i}`,
          {
            name: file.name,
            description: file.description,
            artifact: { sha256: file.sha, size: file.size ?? 1757, mime: 'text/markdown' },
          },
        ]),
        ...(presentedAt === undefined ? [] : [['presentedAt', presentedAt]]),
      ]),
      actions: [],
    },
    status: 'open',
    createdSeq,
    updatedSeq: createdSeq,
    owner: 'deliverables',
    lane: 'main',
    taskId: 'task',
  }) as unknown as UiSurfaceRecord

it('names the type and the version in plain words', () => {
  expect(deliverableType('report.md', 'text/markdown')).toBe('markdown')
  expect(deliverableType('cities.html', 'application/octet-stream')).toBe('html')
  expect(deliverableType('ledger.xlsx', 'application/octet-stream')).toBe('sheet')
  expect(deliverableType('scan', 'image/png')).toBe('image')
  expect(deliverableVersion('crm-assistant: final')).toEqual({ key: 'ui.file.final' })
  expect(deliverableVersion('crm-assistant: review draft')).toEqual({ key: 'ui.file.reviewDraft' })
  expect(deliverableVersion('finance-reconcile: ledger summary')).toEqual({ text: 'ledger summary' })
  expect(deliverableVersion('A short note: with a colon')).toEqual({ text: 'A short note: with a colon' })
  expect(deliverableVersion('')).toBeUndefined()
})

it('takes the files a turn produced, and keeps the newest version of each name in front', () => {
  const surfaces = [
    fileList('earlier-turn', 3, [{ name: 'notes.md', description: 'x: final', sha: sha(1) }]),
    fileList('draft', 12, [{ name: 'report.md', description: 'crm-assistant: review draft', sha: sha(2) }]),
    fileList('final', 18, [
      { name: 'report.md', description: 'crm-assistant: final', sha: sha(3) },
      { name: 'report.html', description: 'crm-assistant: final', sha: sha(4) },
    ]),
  ]
  const entries = turnDeliverables(surfaces, { startSeq: 10, endSeq: 20 })
  expect(entries.map((entry) => entry.file.artifact.sha256)).toEqual([sha(2), sha(3), sha(4)])
  const groups = groupDeliverables(entries)
  expect(groups.map((group) => group.latest.file.artifact.sha256)).toEqual([sha(3), sha(4)])
  expect(groups[0]?.earlier.map((entry) => entry.file.artifact.sha256)).toEqual([sha(2)])
  // A running turn has no end yet: everything from its start belongs to it.
  expect(turnDeliverables(surfaces, { startSeq: 15 }).map((entry) => entry.surfaceId)).toEqual([
    'final',
    'final',
  ])
})

it('shows one compact group with the earlier version folded, and no artifact references', async () => {
  const surfaces = [
    fileList('draft', 12, [{ name: 'report.md', description: 'crm-assistant: review draft', sha: sha(2) }]),
    fileList('final', 18, [
      { name: 'report.md', description: 'crm-assistant: final', sha: sha(3) },
      { name: 'report.html', description: 'crm-assistant: final', sha: sha(4) },
    ]),
  ]
  const client = {
    getSnapshot: () => ({ surfaces }),
    knownRecord: (id: string) => surfaces.find((record) => record.surface.id === id),
    lookup: async () => {},
  } as unknown as IntelligentUiClient
  const locale = createDocumentLocaleSource({})
  const expand = vi.fn()
  const binding: UiPlacementBinding = {
    subscribe: () => () => {},
    getSnapshot: () => client,
    getVersion: () => 0,
    locale: locale.source,
    target: () => undefined,
    expand,
    approval: vi.fn(),
    resources: {} as never,
  }
  const detach = attachTurnDeliverables(binding)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  await act(async () =>
    root.render(createElement(TurnDeliverables, { turn: { startSeq: 10, endSeq: 20 } as UITurn })),
  )
  try {
    const group = host.querySelector('[data-testid="turn-deliverables"]')
    expect(group?.querySelector('.turn-deliverables-head')?.textContent).toBe('Deliverables · 2')
    const cards = [...(group?.querySelectorAll(':scope > ul > li > [data-testid="deliverable-file"]') ?? [])]
    expect(cards.map((card) => card.querySelector('.deliverable-name')?.textContent)).toEqual([
      'report.md',
      'report.html',
    ])
    expect(cards[0]?.querySelector('.deliverable-meta')?.textContent).toBe('Final · 1.7 KiB')
    const earlier = group?.querySelector('[data-testid="turn-deliverable-earlier"]')
    expect(earlier?.getAttribute('data-open')).toBe('false')
    expect(earlier?.querySelector('.agh-disclosure-summary')?.textContent).toBe('Earlier versions · 1')
    expect(earlier?.textContent).toContain('Review draft')
    expect(host.textContent).not.toContain(sha(3))
    expect(host.textContent).not.toContain('crm-assistant')
    // Opening a conversation card hands the preview to the workbench copy of the same surface.
    await act(async () =>
      cards[0]?.querySelector<HTMLButtonElement>('[data-testid="deliverable-open"]')?.click(),
    )
    expect(expand).toHaveBeenCalledWith('final', 1)
  } finally {
    await act(async () => root.unmount())
    detach()
    locale.dispose()
    host.remove()
  }
})

it('treats the same file presented again with the same bytes as one version', () => {
  const surfaces = [
    fileList('first', 12, [{ name: 'index.html', description: '咖啡豆门户站', sha: sha(5) }], 1000),
    fileList('again', 14, [{ name: 'index.html', description: '咖啡豆门户站', sha: sha(5) }], 2000),
  ]
  const entries = turnDeliverables(surfaces, { startSeq: 10, endSeq: 20 })
  const groups = groupDeliverables(entries)
  expect(groups).toHaveLength(1)
  expect(groups[0]?.latest.surfaceId).toBe('again')
  expect(groups[0]?.earlier).toEqual([])
  // The workbench leaves the older repeat out and labels nothing as earlier.
  const versions = deliverableVersions(entries)
  expect(versions.get(deliverableKey(entries[0]!))).toBe('hidden')
  expect(versions.has(deliverableKey(entries[1]!))).toBe(false)
})

it('names an earlier version by its time and its size against the latest', () => {
  const at = Date.parse('2026-10-14T08:16:00.000Z')
  const surfaces = [
    fileList('v1', 11, [{ name: 'index.html', description: '咖啡豆门户站', sha: sha(6), size: 14_000 }], at),
    fileList(
      'v1-again',
      12,
      [{ name: 'index.html', description: '咖啡豆门户站', sha: sha(6), size: 14_000 }],
      at + 60_000,
    ),
    fileList(
      'v2',
      13,
      [{ name: 'index.html', description: '咖啡豆门户站', sha: sha(7), size: 15_200 }],
      at + 120_000,
    ),
  ]
  const groups = groupDeliverables(turnDeliverables(surfaces, { startSeq: 10, endSeq: 20 }))
  expect(groups[0]?.latest.surfaceId).toBe('v2')
  expect(groups[0]?.earlier.map((entry) => [entry.surfaceId, entry.version])).toEqual([
    ['v1-again', { presentedAt: at + 60_000, ordinal: 1, sizeDelta: -1200, sameDescription: true }],
  ])
})

it('shows an earlier card with its time and size difference, and opens its own snapshot', async () => {
  const at = Date.parse('2026-10-14T08:16:00.000Z')
  const time = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(new Date(at))
  const load = vi.fn(async () => ({ kind: 'text' as const, text: 'old', release: () => {} }))
  const locale = createDocumentLocaleSource({})
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const file = {
    name: 'index.html',
    description: '咖啡豆门户站',
    artifact: { sha256: sha(8), size: 14_000, mime: 'text/plain' },
  }
  try {
    await act(async () =>
      root.render(
        createElement(ArtifactFile, {
          file,
          laneId: 'main',
          resources: { documents: { load } } as never,
          placement: 'workbench',
          earlier: { presentedAt: at, ordinal: 1, sizeDelta: -1229, sameDescription: true },
        }),
      ),
    )
    const card = host.querySelector('[data-testid="deliverable-file"]')
    expect(card?.getAttribute('data-version')).toBe('earlier')
    // The shared description is not repeated; time and size tell the versions apart.
    expect(card?.querySelector('.deliverable-meta')?.textContent).toBe(
      `Version from ${time} · 1.2 KiB smaller than the latest`,
    )
    await act(async () => host.querySelector<HTMLElement>('[data-testid="deliverable-open"]')?.click())
    // The snapshot of this version, never the workspace file of that name.
    expect(load).toHaveBeenCalledWith({ laneId: 'main', artifact: file.artifact, kind: 'text' })
    expect(host.querySelector('[data-testid="deliverable-preview-version"]')?.textContent).toBe(
      `Earlier version · ${time}`,
    )
  } finally {
    await act(async () => root.unmount())
    locale.dispose()
    host.remove()
  }
})
