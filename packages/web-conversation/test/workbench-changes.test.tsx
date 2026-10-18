/** @vitest-environment happy-dom */
import type { Session } from '@agnes/sdk/browser'
import { createCatalogTranslator, renderRegion, unmountRegion } from '@agnes/web-ui'
import { flushSync } from 'react-dom'
import { expect, it, vi } from 'vitest'
import { ChangesPanel } from '../src/workbench/changes-panel.js'
import { diffSide, foldDiff, parseDiff } from '../src/workbench/diff-lines.js'
import { workbenchLocaleCatalog } from '../src/workbench/locales.js'
import { changesCount } from '../src/workbench/tab-counts.js'

const hash = (c: string) => c.repeat(64)
const effect = {
  callSeq: 41,
  resultSeq: 42,
  receiptSeq: 43,
  toolUseId: 'use-write',
  laneId: 'main',
  tool: 'write',
  turn: 3,
  observedAt: '2026-10-14T09:02:11Z',
  decisionId: 'decision',
  enforcement: 'full',
}
const change = (patch: Record<string, unknown>) => ({
  path: 'boot-portal.html',
  kind: 'added',
  basis: 'session',
  added: 412,
  removed: 0,
  diffStatus: 'available',
  freshness: 'current',
  afterRevision: hash('a'),
  currentRevision: hash('a'),
  effects: [effect],
  ...patch,
})
const unchanged = Array.from({ length: 12 }, (_, i) => ` same ${i + 1}`).join('\n')
const themeDiff = `--- a/styles/theme.css\n+++ b/styles/theme.css\n@@ -10,15 +10,15 @@\n-old line\n+new line\n${unchanged}\n-old tail\n+new tail\n`

it('numbers diff lines from hunk headers, folds long unchanged runs and shows one side', () => {
  const rows = parseDiff(themeDiff)
  expect(rows[0]).toEqual({ kind: 'hunk', text: '@@ -10,15 +10,15 @@' })
  expect(rows[1]).toEqual({ kind: 'del', text: 'old line', old: 10 })
  expect(rows[2]).toEqual({ kind: 'add', text: 'new line', new: 10 })
  expect(rows[3]).toEqual({ kind: 'ctx', text: 'same 1', old: 11, new: 11 })
  const folded = foldDiff(rows, new Set())
  const fold = folded.find((row) => row.kind === 'fold')
  expect(fold?.kind === 'fold' && fold.hidden).toHaveLength(6)
  expect(folded).toHaveLength(rows.length - 6 + 1)
  expect(fold?.kind === 'fold' && foldDiff(rows, new Set([fold.id]))).toHaveLength(rows.length)
  // A whole new file has no hunk header and counts from 1.
  expect(parseDiff('+<a>\n+<b>\n')).toEqual([
    { kind: 'add', text: '<a>', new: 1 },
    { kind: 'add', text: '<b>', new: 2 },
  ])
  const long = parseDiff(Array.from({ length: 450 }, (_, i) => `+line ${i}`).join('\n'))
  const tail = foldDiff(long, new Set()).at(-1)
  expect(tail).toMatchObject({ kind: 'fold', id: 'tail' })
  expect(tail?.kind === 'fold' && tail.hidden).toHaveLength(50)
  expect(diffSide(rows, 'before').map((row) => row.kind)).not.toContain('add')
})

it('lists changed files in one row each and opens a numbered diff with versions and a record link', async () => {
  const theme = change({
    path: 'styles/theme.css',
    kind: 'modified',
    added: 34,
    removed: 18,
    freshness: 'changed',
  })
  const scene = change({ path: 'scene.svg', added: undefined, removed: undefined, diffStatus: 'binary' })
  const files = [change({}), theme, scene]
  const workspaceChanges = vi.fn(async (input: { scope: string; path?: string }) => ({
    scope: input.scope,
    revision: hash('r'),
    observedAt: '2026-10-14T09:03:00Z',
    fromSeq: 1,
    toSeq: 60,
    turn: 3,
    truncated: false,
    unrecorded: true,
    files: input.scope === 'turn' ? [theme] : files,
    ...(input.path === 'styles/theme.css'
      ? { selected: { ...theme, beforeRevision: hash('b'), diff: themeDiff } }
      : input.path === 'boot-portal.html'
        ? { selected: { ...change({}), beforeRevision: hash('b'), diff: '+<!DOCTYPE html>\n' } }
        : input.path === 'scene.svg'
          ? { selected: { ...scene, beforeRevision: hash('b') } }
          : {}),
  }))
  const workspaceRead = vi.fn(async () => ({ text: 'now 1\nnow 2\n', binary: false, truncated: false }))
  const session = { id: 's', workspaceChanges, workspaceRead } as unknown as Session
  const host = document.createElement('div')
  document.body.append(host)
  const context = {
    t: createCatalogTranslator(workbenchLocaleCatalog, 'zh-CN'),
    data: { session, disabled: false, mention: vi.fn(), command: vi.fn() },
  }
  try {
    renderRegion(host, <ChangesPanel context={context} />)
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid=changed-file]')).toHaveLength(3))
    expect(host.querySelector('[data-testid=changes-summary]')?.textContent).toBe('3 个文件 · +446 −18')
    // The open panel shares what it read with its tab count.
    expect(changesCount.read({ t: (key) => key, data: { session: { id: 's' } } })).toBe(3)
    const [first, second, third] = [...host.querySelectorAll<HTMLElement>('[data-testid=changed-file]')]
    expect(first?.querySelector('.workbench-file-type')?.textContent).toBe('HTML')
    expect(first?.querySelector('.workbench-tag')?.textContent).toBe('新建')
    expect(first?.querySelector('.workbench-diff-count')?.textContent).toBe('+412 −0')
    expect(second?.querySelector('.workbench-changes-dir')?.textContent).toBe('styles/')
    expect(second?.querySelector('.workbench-changes-path strong')?.textContent).toBe('theme.css')
    expect(second?.querySelector('.workbench-tag')?.textContent).toBe('修改')
    const unavailable = third?.querySelector('[data-testid=changed-file-unavailable]')
    expect(unavailable?.textContent).toBe('二进制，无文本差异')
    expect(unavailable?.getAttribute('title')).toBe('此更改包含二进制数据，无法显示文本差异。')
    expect(host.querySelector('.workbench-tab-footer')?.textContent).toContain(
      '有成功操作缺少审阅证据，未显示在这里',
    )
    expect(host.querySelector('.workbench-tab-footer .agh-disclosure-summary')?.textContent).toBe(
      '审阅范围说明',
    )

    flushSync(() => second?.click())
    await vi.waitFor(() => expect(host.querySelector('[data-testid=changes-diff]')).not.toBeNull())
    expect(second?.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('.workbench-change-head')?.textContent).toContain('第 3 轮 · write')
    // Freshness notices sit in a strip under the diff header.
    expect(host.querySelector('.workbench-change-head + .workbench-strip')?.textContent).toBe(
      '此文件在智能体更改记录之后又发生了变化。差异显示已记录的更改。',
    )
    const lines = () => [...host.querySelectorAll<HTMLElement>('.workbench-diff-line')]
    expect(lines()[1]?.dataset.kind).toBe('del')
    const cells = (line: HTMLElement | undefined) =>
      [...(line?.children ?? [])].map((cell) => cell.textContent)
    expect(cells(lines()[1])).toEqual(['10', '', '-', 'old line'])
    expect(cells(lines()[2])).toEqual(['', '10', '+', 'new line'])
    expect(lines()[2]?.dataset.kind).toBe('add')
    expect(host.querySelector('[data-testid=changes-diff-fold]')?.textContent).toBe('展开 6 行未改动内容')
    flushSync(() => (host.querySelector('[data-testid=changes-diff-fold]') as HTMLButtonElement).click())
    expect(host.querySelector('[data-testid=changes-diff-fold]')).toBeNull()
    flushSync(() => (host.querySelector('[data-testid=changes-version-before]') as HTMLInputElement).click())
    expect(lines().map((line) => line.dataset.kind)).not.toContain('add')
    flushSync(() => (host.querySelector('[data-testid=changes-version-current]') as HTMLInputElement).click())
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid=changes-diff]')?.textContent).toContain('now 2'),
    )
    expect(workspaceRead).toHaveBeenCalledWith('styles/theme.css')

    // A new file has no "before" version.
    flushSync(() => first?.click())
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid=changes-diff]')?.textContent).toContain('DOCTYPE'),
    )
    expect((host.querySelector('[data-testid=changes-version-before]') as HTMLInputElement).disabled).toBe(
      true,
    )
    expect((host.querySelector('[data-testid=changes-version-after]') as HTMLInputElement).checked).toBe(true)

    // A binary change says why there is no diff, but its current version can still be read.
    flushSync(() => third?.click())
    await vi.waitFor(() =>
      expect(host.querySelector('.workbench-change-preview')?.textContent).toContain(
        '此更改包含二进制数据，无法显示文本差异。',
      ),
    )
    expect((host.querySelector('[data-testid=changes-version-after]') as HTMLInputElement).disabled).toBe(
      true,
    )
    expect((host.querySelector('[data-testid=changes-version-current]') as HTMLInputElement).disabled).toBe(
      false,
    )

    flushSync(() => (host.querySelector('[data-testid=changes-scope-turn]') as HTMLInputElement).click())
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid=changed-file]')).toHaveLength(1))
    expect(workspaceChanges).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'turn' }))
    // The latest-turn scope never replaces the session's tab count.
    expect(changesCount.read({ t: (key) => key, data: { session: { id: 's' } } })).toBe(3)
  } finally {
    unmountRegion(host)
    host.remove()
  }
})

it.each([false, true])(
  'pauses changes polling and catches up once (read in flight: %s)',
  async (inFlight) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let hidden = false
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => (hidden ? 'hidden' : 'visible'))
    let finish: (() => void) | undefined
    const workspaceChanges = vi.fn(async () => {
      if (inFlight && !finish)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      return { scope: 'session', files: [], revision: 'r', observedAt: '2026-10-18T00:00:00Z' }
    })
    const session = { id: 'synthetic', workspaceChanges } as unknown as Session
    const host = document.body.appendChild(document.createElement('div'))
    try {
      renderRegion(host, <ChangesPanel context={{ t: (key) => key, data: { session, mention: vi.fn() } }} />)
      await vi.advanceTimersByTimeAsync(0)
      expect(workspaceChanges).toHaveBeenCalledTimes(1)
      hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(9000)
      expect(workspaceChanges).toHaveBeenCalledTimes(1)
      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(0)
      if (inFlight) {
        expect(workspaceChanges).toHaveBeenCalledTimes(1)
        finish?.()
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(workspaceChanges).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(3000)
      expect(workspaceChanges).toHaveBeenCalledTimes(3)
      unmountRegion(host)
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(9000)
      expect(workspaceChanges).toHaveBeenCalledTimes(3)
    } finally {
      unmountRegion(host)
      host.remove()
      visibility.mockRestore()
      vi.useRealTimers()
    }
  },
)
