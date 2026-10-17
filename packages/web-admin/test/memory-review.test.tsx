/** @vitest-environment happy-dom */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type ClientContext, type UiExtensionContext, workbenchPanels } from '@agnes/web-client'
import { act, type ComponentType, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'

const { MemoryReviewPanel, loadReview, catalog, apply } = (await import(
  pathToFileURL(resolve('packages/package-manager/bundled-plugins/memory-review/src/client.js')).href
)) as {
  MemoryReviewPanel: ComponentType<{ context: UiExtensionContext }>
  loadReview(session: unknown, timeline: unknown, signal: AbortSignal): Promise<unknown>
  catalog: Record<string, Record<string, string>>
  apply(ctx: ClientContext): void
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => document.body.replaceChildren())
const completeDiff = `--- current\n+++ proposed\n-${'a'.repeat(6000)}\n+complete-end-marker`
const review = {
  version: 1,
  revision: 'revision-a',
  groups: [
    {
      kind: 'conflict',
      reason: 'Task and authoritative project rules require pnpm.',
      sources: [{ path: 'MEMORY.md', hash: 'base' }],
    },
  ],
  edits: [
    {
      path: 'MEMORY.md',
      baseHash: 'base',
      newHash: 'new',
      diff: completeDiff,
      reason: 'Preserve the confirmed convention.',
      sources: [{ path: 'MEMORY.md', hash: 'base' }],
    },
  ],
}
const timeline = {
  sessionId: 'one',
  upto: 5,
  nodes: [
    { kind: 'tool', name: 'memory_review_preview', status: 'completed', seq: 2, resultSeq: 3 },
    { kind: 'tool', name: 'memory_review_apply', status: 'completed', seq: 4, resultSeq: 5 },
  ],
}

it.each(['en', 'zh-CN'])(
  'shows complete SDK diffs, source hashes and partial failure in %s with keyboard view controls',
  async (locale) => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const context = {
      t: (key: string) => catalog[locale]?.[key] ?? key,
      data: {
        timeline,
        session: {
          readToolDetail: async (seq: number) => ({
            result: {
              structured:
                seq === 2
                  ? review
                  : {
                      status: 'partial',
                      committed: [{ path: 'topic.md' }],
                      failed: 'MEMORY.md',
                      code: 'MEMORY_CONFLICT',
                    },
            },
          }),
        },
      },
    }
    await act(async () => root.render(createElement(MemoryReviewPanel, { context })))
    expect(host.textContent).toContain(catalog[locale]?.['memoryReview.partial'])
    expect(host.textContent).toContain('revision-a')
    expect(host.textContent).toContain('MEMORY.md')
    const radios = host.querySelectorAll<HTMLElement>('input[type="radio"]')
    expect(radios).toHaveLength(2)
    await act(async () =>
      radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    )
    expect(host.textContent).toContain('complete-end-marker')
    expect(host.textContent).toContain('base')
    expect(host.querySelector('[data-tone="error"]')).not.toBeNull()
    await act(async () => root.unmount())
  },
)

it('refuses older incompatible detail records and releases locale and panel registrations on uninstall', async () => {
  expect(Object.keys(catalog.en ?? {}).sort()).toEqual(Object.keys(catalog['zh-CN'] ?? {}).sort())
  await expect(loadReview({}, timeline, new AbortController().signal)).resolves.toEqual({ unavailable: true })
  await expect(
    loadReview(
      {
        readToolDetail: async () => {
          throw new Error('Do not read an earlier candidate')
        },
      },
      {
        ...timeline,
        nodes: [...timeline.nodes, { kind: 'tool', name: 'memory_review_scan', seq: 6, status: 'failed' }],
      },
      new AbortController().signal,
    ),
  ).resolves.toEqual({ incomplete: true })
  await expect(
    loadReview(
      { readToolDetail: async () => ({ result: { structured: { version: 2 } } }) },
      timeline,
      new AbortController().signal,
    ),
  ).rejects.toThrow('MEMORY_REVIEW_INVALID_RECORD')
  const disposers: (() => void)[] = []
  let localePresent = false
  apply({
    locale: {
      register: () => {
        localePresent = true
        return () => {
          localePresent = false
        }
      },
    },
    effect: (factory: () => () => void) => disposers.push(factory()),
  } as unknown as ClientContext)
  expect(workbenchPanels.get('memory-review')).toBeDefined()
  for (const dispose of disposers.reverse()) dispose()
  expect(workbenchPanels.get('memory-review')).toBeUndefined()
  expect(localePresent).toBe(false)
})

it('discards a late private read after switching the selected session and displays a recoverable read failure', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let resolveOld: (value: unknown) => void = () => {}
  const pending = new Promise((resolve) => {
    resolveOld = resolve
  })
  const t = (key: string) => catalog.en?.[key] ?? key
  await act(async () =>
    root.render(
      createElement(MemoryReviewPanel, {
        context: { t, data: { timeline, session: { readToolDetail: () => pending } } },
      }),
    ),
  )
  await act(async () =>
    root.render(
      createElement(MemoryReviewPanel, {
        context: {
          t,
          data: {
            timeline: { ...timeline, sessionId: 'two' },
            session: {
              readToolDetail: async () => {
                throw new Error('Not authorized')
              },
            },
          },
        },
      }),
    ),
  )
  await act(async () => resolveOld({ result: { structured: review } }))
  expect(host.textContent).not.toContain('revision-a')
  expect(host.textContent).toContain(catalog.en?.['memoryReview.error'])
  expect(host.textContent).toContain(catalog.en?.['memoryReview.refresh'])
  await act(async () => root.unmount())
})
