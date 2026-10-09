/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import type { AuthoringCandidate, PackagePreview } from '@agnes/protocol'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { PluginAdminApi } from '../src/admin/plugins/api.js'
import { candidateDiff } from '../src/admin/plugins/candidate-diff.js'
import { CandidateListFacts, candidateIdentity } from '../src/admin/plugins/candidate-list.js'
import {
  addedPermissions,
  CandidateDelta,
  CandidateFileDiff,
  capabilityLabel,
} from '../src/admin/plugins/candidate-review.js'
import { CandidateInbox } from '../src/admin/plugins/candidates.js'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'

it.each([
  [null, 'new\nfile\n'],
  ['deleted\nfile', null],
  ['start\nold\nkeep\nend', 'start\nnew\nkeep\nend'],
  ['same\nsame\nold', 'same\nnew\nsame'],
  ['text', 'text\n'],
  ['old\n'.repeat(1000), 'new\n'.repeat(1000)],
])('preserves both complete file versions in the line diff', (before, after) => {
  const html = renderToStaticMarkup(
    <CandidateFileDiff file={{ path: 'skill.test.mjs', before, after }} t={t} />,
  )
  expect(html).toContain('<code>skill.test.mjs</code>')
  const lines = candidateDiff(before, after)
  expect(
    lines
      .filter((line) => line.kind !== 'added')
      .map((line) => line.text)
      .join('\n'),
  ).toBe(before ?? '')
  expect(
    lines
      .filter((line) => line.kind !== 'removed')
      .map((line) => line.text)
      .join('\n'),
  ).toBe(after ?? '')
})

const fixtures = readFileSync('packages/protocol/fixtures/package-admin/package-admin.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const candidate: AuthoringCandidate = fixtures.find(
  (row) => row.name === 'AuthoringCandidate' && row.kind === 'valid',
).payload
const preview: PackagePreview = fixtures.find(
  (row) => row.name === 'PackagePreview' && row.kind === 'valid',
).payload
const t = (key: string) => pluginAdminLocaleCatalog['zh-CN'][key] ?? key

it('keeps permission changes distinct from tool registration and exposes service grants without hash jargon', () => {
  const value = {
    ...candidate,
    preview: {
      ...preview,
      capabilityDiff: {
        ...preview.capabilityDiff,
        added: ['tools:sha256-' + 'a'.repeat(64), 'filesystem.write:/workspace', 'network:api.example.com'],
        serviceGrantsAdded: [{ extension: 'sample/service', name: 'records.write', range: '^1.0.0' }],
      },
    },
  }
  expect(addedPermissions(value)).toBe(3)
  expect(addedPermissions({ ...value, preview: null })).toBeUndefined()
  expect(capabilityLabel('tools:sha256-' + 'a'.repeat(64), t)).toBe('提供工具')
  const html = renderToStaticMarkup(<CandidateDelta value={value} t={t} />)
  expect(html).toContain('写入文件 · /workspace')
  expect(html).toContain('api.example.com')
  expect(html).toContain('records.write')
  expect(html).not.toContain('sha256-')
  expect(html).not.toContain('Host')
  const onlyTools = {
    ...value,
    preview: {
      ...value.preview,
      capabilityDiff: { ...preview.capabilityDiff, added: ['tools:sha256-' + 'a'.repeat(64)] },
    },
  }
  expect(addedPermissions(onlyTools)).toBe(0)
  expect(renderToStaticMarkup(<CandidateDelta value={onlyTools} t={t} />)).toContain('新增权限：无')
})

it('distinguishes same-name candidate versions, skills and source-turn time in both languages', () => {
  const startedAt = '2026-10-09T00:00:00Z',
    now = Date.parse(startedAt) + 120_000
  for (const locale of ['en', 'zh-CN'] as const) {
    const text = (key: string, params?: Record<string, string | number>) =>
      (pluginAdminLocaleCatalog[locale][key] ?? key).replace(/\{(\w+)\}/g, (_, name) =>
        String(params?.[name] ?? name),
      )
    const newPlugin = {
      ...candidate,
      baseHash: null,
      preview: { ...preview, kinds: ['tool'] as ['tool'], version: '0.1.0' },
    }
    const update = {
      ...newPlugin,
      baseHash: 'sha256-' + 'a'.repeat(64),
      preview: { ...newPlugin.preview, version: '0.2.0' },
    }
    const skill = {
      ...newPlugin,
      preview: null,
      sourceFiles: [
        { path: 'package.json', content: JSON.stringify({ version: '1.0.0', agnes: { kinds: ['skills'] } }) },
      ],
    }
    const html = (value: AuthoringCandidate) =>
      renderToStaticMarkup(
        <CandidateListFacts identity={candidateIdentity(value)} startedAt={startedAt} now={now} t={text} />,
      )
    expect(html(newPlugin)).toContain(text('candidates.new.plugin'))
    expect(html(newPlugin)).toContain('0.1.0')
    expect(html(update)).toContain(text('candidates.update'))
    expect(html(update)).toContain('0.2.0')
    expect(html(skill)).toContain(text('candidates.type.skill'))
    expect(html(skill)).toContain(text('candidates.new.skill'))
    expect(html(skill)).toContain(text('candidates.minutesAgo', { count: 2 }))
    expect(html(skill)).toContain('dateTime="' + startedAt + '"')
    expect(html(skill)).not.toContain('candidateHash')
    expect(
      renderToStaticMarkup(<CandidateListFacts identity={candidateIdentity(skill)} now={now} t={text} />),
    ).toContain(text('candidates.timeUnavailable'))
  }
})

it('hides empty inboxes, serializes review navigation and exposes list failures', async () => {
  vi.useFakeTimers()
  const scope = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  scope.IS_REACT_ACT_ENVIRONMENT = true
  const list = vi.fn().mockResolvedValue({ candidates: [] })
  const show = vi.fn().mockResolvedValue(candidate)
  const api = { candidatesList: list, candidatesShow: show } as unknown as PluginAdminApi
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <CandidateInbox
          api={api}
          canReview
          canTest
          t={t}
          confirm={() => undefined}
          onPublished={async () => undefined}
        />,
      ),
    )
    expect(host.querySelector('[data-testid="plugin-candidates"]')).toBeNull()
    list.mockResolvedValue({ candidates: [candidate] })
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(host.querySelector('[data-testid="candidate-open"]')?.textContent).toContain(candidate.packageId)
    const button = (id: string) => {
      const element = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
      if (!element) throw new Error(`Missing ${id}`)
      return element
    }
    let finishRefresh!: (value: { candidates: AuthoringCandidate[] }) => void
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve
        }),
    )
    await act(async () => button('candidate-refresh').click())
    expect(button('candidate-refresh').disabled).toBe(true)
    expect(button('candidate-open').disabled).toBe(true)
    await act(async () => button('candidate-open').click())
    expect(host.querySelector('[data-testid="candidate-review"]')).toBeNull()
    await act(async () => finishRefresh({ candidates: [candidate] }))
    expect(button('candidate-open').disabled).toBe(false)
    let finishShow!: (value: AuthoringCandidate) => void
    show.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishShow = resolve
        }),
    )
    await act(async () => button('candidate-open').click())
    expect(button('candidate-refresh').disabled).toBe(true)
    await act(async () => button('candidate-refresh').click())
    await act(async () => finishShow({ ...candidate, state: 'review' }))
    expect(host.querySelector('[data-testid="candidate-summary"]')?.textContent).toContain(
      candidate.packageId,
    )
    expect(button('candidate-approve').disabled).toBe(false)
    list.mockRejectedValueOnce(new Error('offline'))
    await act(async () => button('candidate-refresh').click())
    expect(button('candidate-refresh').disabled).toBe(false)
    expect(host.querySelector('[data-testid="candidate-review"]')).not.toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t('candidates.unavailable'))
    await act(async () => button('candidate-back').click())
    list.mockResolvedValue({ candidates: [] })
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(host.querySelector('[data-testid="plugin-candidates"]')).toBeNull()
    list.mockRejectedValue(new Error('offline'))
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t('candidates.unavailable'))
    list.mockResolvedValue({ candidates: [] })
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(host.querySelector('[data-testid="plugin-candidates"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.useRealTimers()
    scope.IS_REACT_ACT_ENVIRONMENT = false
  }
})
