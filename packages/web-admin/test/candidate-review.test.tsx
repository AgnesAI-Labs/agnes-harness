/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AuthoringCandidate, PackagePreview } from '@agnes/protocol'
import { setDisclosureOpen } from '@agnes/web-ui'
import { act, type ReactNode, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { PluginAdminApi } from '../src/admin/plugins/api.js'
import { candidateDiff } from '../src/admin/plugins/candidate-diff.js'
import {
  CandidateListFacts,
  candidateIdentity,
  candidateSkillText,
} from '../src/admin/plugins/candidate-list.js'
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
  const css = readFileSync(
    resolve(import.meta.dirname, '../../web/public/styles/23-plugin-review.css'),
    'utf8',
  )
  const header = css.match(/\.plugin-candidates \.candidate-file \.agh-disclosure-summary \{([^}]*)\}/)?.[1]
  expect(header).toContain('position: sticky')
  expect(header).toContain('top: 0')
  expect(header).toContain('background: var(--agnes-bg-surface)')
  const html = renderToStaticMarkup(
    <CandidateFileDiff file={{ path: 'skill.test.mjs', before, after }} t={t} />,
  )
  expect(html).toContain('<code title="skill.test.mjs">skill.test.mjs</code>')
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
      preview: {
        ...preview,
        presentation: { includes: { provides: ['tool'] as ['tool'], counts: { tools: 1 } }, rows: [] },
        version: '0.1.0',
      },
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
        {
          path: 'package.json',
          content: JSON.stringify({
            version: '1.0.0',
            agnes: {
              contributions: [{ kind: 'skill', id: 'reviewed/main', path: './skills/method/SKILL.md' }],
            },
          }),
        },
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
    expect(
      candidateIdentity({
        ...skill,
        preview: {
          ...preview,
          presentation: { includes: { provides: ['skills'], counts: { skills: 1 } }, rows: [] },
        },
      }).type,
    ).toBe('skill')
    // Code-registered Skills (including feedback drafts) declare their kind before inspection.
    expect(
      candidateIdentity({
        ...skill,
        sourceFiles: [
          {
            path: 'package.json',
            content: JSON.stringify({
              version: '1.0.0',
              agnes: {
                provides: ['skills'],
                plugins: [
                  { id: 'ext:reviewed/main', export: 'main', apiRange: '^5.0.0', inject: ['skills'] },
                ],
              },
            }),
          },
        ],
      }).type,
    ).toBe('skill')
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

it.each([false, true])(
  'hides empty inboxes, serializes review navigation and exposes list failures (review surface %s)',
  async (surface) => {
    vi.useFakeTimers()
    const scope = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    scope.IS_REACT_ACT_ENVIRONMENT = true
    const list = vi.fn().mockResolvedValue({ candidates: [] })
    const show = vi.fn().mockResolvedValue(candidate)
    const api = { candidatesList: list, candidatesShow: show } as unknown as PluginAdminApi
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const style = document.createElement('style')
    // Apply the production layout rule without its cascade layer (unsupported in happy-dom).
    style.textContent =
      readFileSync(resolve(__dirname, '../../web/public/styles/23-plugin-review.css'), 'utf8').match(
        /\.plugin-candidates \.candidate-summary-facts \{[^}]+\}/,
      )?.[0] ?? ''
    document.head.append(style)
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
            {...(surface
              ? {
                  reviewSurface: (content: ReactNode) =>
                    createPortal(<div data-testid="review-surface">{content}</div>, host),
                }
              : {})}
          />,
        ),
      )
      expect(host.querySelector('[data-testid="plugin-candidates"]')).toBeNull()
      list.mockResolvedValue({ candidates: [candidate] })
      await act(async () => vi.advanceTimersByTimeAsync(120_000))
      expect(list).toHaveBeenCalledTimes(1)
      await act(async () => window.dispatchEvent(new Event('agnes:plugins-invalidated')))
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
      expect(getComputedStyle(host.querySelector('.candidate-summary-facts')!).display).toBe('flex')
      list.mockRejectedValueOnce(new Error('offline'))
      await act(async () => button('candidate-refresh').click())
      expect(button('candidate-refresh').disabled).toBe(false)
      expect(host.querySelector('[data-testid="candidate-review"]')).not.toBeNull()
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(t('candidates.unavailable'))
      if (surface) {
        expect(host.querySelector('[data-testid="review-surface"] [role="alert"]')?.textContent).toBe(
          t('candidates.unavailable'),
        )
        expect(button('candidate-back').closest('[data-testid="review-surface"]')).not.toBeNull()
      }
      await act(async () => button('candidate-back').click())
      list.mockResolvedValue({ candidates: [] })
      const settledReads = list.mock.calls.length
      await act(async () => vi.advanceTimersByTimeAsync(120_000))
      expect(list).toHaveBeenCalledTimes(settledReads)
      await act(async () => window.dispatchEvent(new Event('agnes:plugins-invalidated')))
      expect(host.querySelector('[data-testid="plugin-candidates"]')).toBeNull()
      list.mockRejectedValue(new Error('offline'))
      const failedReads = list.mock.calls.length
      await act(async () => vi.advanceTimersByTimeAsync(120_000))
      expect(list).toHaveBeenCalledTimes(failedReads)
      await act(async () => window.dispatchEvent(new Event('agnes:plugins-invalidated')))
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(t('candidates.unavailable'))
      list.mockResolvedValue({ candidates: [] })
      const recoveredReads = list.mock.calls.length
      await act(async () => vi.advanceTimersByTimeAsync(120_000))
      expect(list).toHaveBeenCalledTimes(recoveredReads)
      await act(async () => window.dispatchEvent(new Event('agnes:plugins-invalidated')))
      expect(host.querySelector('[data-testid="plugin-candidates"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      style.remove()
      host.remove()
      vi.useRealTimers()
      scope.IS_REACT_ACT_ENVIRONMENT = false
    }
  },
)

it.each([
  [
    'name: "Weekly report"\ndescription: "Use when reporting observed evidence."',
    'Weekly report',
    'Use when reporting observed evidence.',
  ],
  [
    "name: '<img src=x onerror=alert(1)>'\ndescription: '&literal description'",
    '<img src=x onerror=alert(1)>',
    '&literal description',
  ],
  ['name: *alias\ndescription: |', '@example/weekly-report', undefined],
  ['name:\ndescription: "Only description"', '@example/weekly-report', 'Only description'],
])(
  'shows inspected Skill text and recovers reads without enabling a forbidden decision (%s)',
  async (header, name, summary) => {
    const { metadata: _metadata, ...plainPreview } = preview
    const skill = {
      ...candidate,
      candidateId: 'skill-review',
      packageId: '@example/weekly-report',
      state: 'review' as const,
      preview: {
        ...plainPreview,
        presentation: { includes: { provides: ['skills'] as ['skills'], counts: { skills: 1 } }, rows: [] },
      },
      sourceFiles: [
        ...candidate.sourceFiles,
        { path: 'SKILL.md', content: `---\n${header}\n---\nInert body.\n` },
      ],
    }
    const plugin = {
      ...candidate,
      candidateId: 'plugin-review',
      state: 'review' as const,
      preview: {
        ...preview,
        presentation: { includes: { provides: ['tool'] as ['tool'], counts: { tools: 1 } }, rows: [] },
      },
    }
    let listedSkill: AuthoringCandidate = skill
    let unavailable = false
    const api = {
      candidatesList: async () => ({ candidates: [listedSkill, plugin] }),
      candidatesShow: async (id: string) => {
        if (unavailable) throw new Error('temporary read failure')
        return id === skill.candidateId ? listedSkill : plugin
      },
    } as unknown as PluginAdminApi
    const count = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <CandidateInbox
            api={api}
            canReview={false}
            canTest={false}
            t={t}
            confirm={() => undefined}
            onPublished={async () => undefined}
            scope="skill"
            onPendingCount={count}
          />,
        ),
      )
      const rows = host.querySelectorAll('[data-testid="candidate-open"]')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.closest('li')?.textContent).toContain(name)
      if (summary) expect(rows[0]?.closest('li')?.textContent).toContain(summary)
      expect(host.querySelector('img')).toBeNull()
      expect(count).toHaveBeenLastCalledWith(1)
      await act(async () => (rows[0] as HTMLButtonElement).click())
      expect(host.querySelector<HTMLButtonElement>('[data-testid="candidate-approve"]')?.disabled).toBe(true)
      expect(host.querySelector<HTMLButtonElement>('[data-testid="candidate-reject"]')?.disabled).toBe(true)
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="candidate-back"]')?.click())
      listedSkill = { ...skill, state: 'draft' }
      unavailable = true
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="candidate-refresh"]')?.click(),
      )
      expect(host.querySelector('[data-testid="candidate-error"]')?.textContent).toBe(
        t('candidates.metadataUnavailable'),
      )
      unavailable = false
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="candidate-refresh"]')?.click(),
      )
      expect(host.querySelector('[data-testid="candidate-error"]')).toBeNull()
      expect(host.querySelectorAll('[data-testid="candidate-open"]')).toHaveLength(1)
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  },
)

it.each([false, true])(
  'closes a published review, links to the skill, and keeps terminal history without dead decisions (%s)',
  async (merged) => {
    const scope = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    scope.IS_REACT_ACT_ENVIRONMENT = true
    const reviewed = {
      ...candidate,
      state: 'review' as const,
      reviewHash: 'review-hash',
      preview: {
        ...preview,
        presentation: { includes: { provides: ['skills'] as ['skills'], counts: { skills: 1 } }, rows: [] },
      },
      sourceFiles: [
        ...candidate.sourceFiles,
        { path: 'SKILL.md', content: '---\nname: published-skill\ndescription: Synthetic skill\n---\nBody' },
      ],
    }
    const published = { ...reviewed, state: 'published' as const }
    const rejected = { ...candidate, candidateId: 'history', state: 'rejected' as const }
    let items = [reviewed, rejected] as AuthoringCandidate[]
    let run: (() => Promise<void>) | undefined
    const api = {
      candidatesList: async () => ({ candidates: items }),
      candidatesShow: async (id: string) => items.find((value) => value.candidateId === id),
      candidatesDecide: vi.fn(async () => {
        items = [published, rejected]
        return published
      }),
    } as unknown as PluginAdminApi
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <CandidateInbox
            api={api}
            merged={merged}
            canReview
            canTest
            t={t}
            confirm={(value) => {
              run = value.run
            }}
            onPublished={async () => undefined}
            reviewSurface={(content) => <div data-testid="review-dialog">{content}</div>}
          />,
        ),
      )
      expect(host.querySelector('[data-testid="candidate-list"]')?.querySelectorAll('li')).toHaveLength(1)
      expect(host.querySelector<HTMLElement>('[data-testid="candidate-history"]')?.dataset.open).toBe('false')
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>('[data-testid="candidate-list"] [data-testid="candidate-open"]')
          ?.click(),
      )
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="candidate-approve"]')?.click(),
      )
      expect(api.candidatesDecide).not.toHaveBeenCalled()
      expect(run).toBeDefined()
      await act(async () => run?.())
      expect(api.candidatesDecide).toHaveBeenCalledOnce()
      expect(host.querySelector('[data-testid="review-dialog"]')).toBeNull()
      expect(host.querySelector('[data-testid="candidate-published"]')?.textContent).toContain('发布')
      expect(
        host.querySelector<HTMLAnchorElement>('[data-testid="candidate-published-link"]')?.href,
      ).toContain(merged ? 'page=plugins&tab=skills' : 'settings=skills')
      const history = host.querySelector<HTMLElement>('[data-testid="candidate-history"]')
      expect(history?.dataset.open).toBe('false')
      await act(async () => {
        if (history) setDisclosureOpen(history, true)
        host
          .querySelector<HTMLButtonElement>('[data-candidate-id="history"] [data-testid="candidate-open"]')
          ?.click()
      })
      if (merged)
        expect(
          history?.querySelector(
            `[data-candidate-id="${published.candidateId}"] .agh-list-row-copy > .agh-meta`,
          )?.textContent,
        ).toContain(`${t('candidates.untitledSession')} · ${t('candidates.state.published')}`)
      expect(host.querySelector('[data-testid="candidate-approve"]')).toBeNull()
      expect(host.querySelector('[data-testid="candidate-reject"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  },
)

it('keeps an addressed candidate open while its review loads, then reports a deliberate close', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  let resolveReview!: (value: AuthoringCandidate) => void
  const shown = new Promise<AuthoringCandidate>((resolve) => {
    resolveReview = resolve
  })
  const changed = vi.fn()
  const api = {
    candidatesList: async () => ({ candidates: [candidate] }),
    candidatesShow: () => shown,
  } as unknown as PluginAdminApi
  function Addressed() {
    const [id, setId] = useState<string | undefined>(candidate.candidateId)
    return (
      <CandidateInbox
        api={api}
        canReview
        canTest
        t={t}
        confirm={() => undefined}
        onPublished={async () => undefined}
        openId={id}
        onSelectedChange={(next) => {
          changed(next)
          setId(next)
        }}
        reviewSurface={(content) => <div>{content}</div>}
      />
    )
  }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Addressed />))
    expect(changed).not.toHaveBeenCalled()
    await act(async () => resolveReview(candidate))
    expect(host.querySelector('[data-testid="candidate-review"]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="candidate-back"]')?.click())
    expect(changed).toHaveBeenLastCalledWith(undefined)
    expect(host.querySelector('[data-testid="candidate-review"]')).toBeNull()
    expect(host.querySelector<HTMLButtonElement>('[data-testid="candidate-open"]')?.disabled).toBe(false)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
