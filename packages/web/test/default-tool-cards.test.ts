/** @vitest-environment happy-dom */
import type { UINode } from '@agnes/protocol'
import type { ClientResourceService, SessionService } from '@agnes/web-client'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DefaultToolCards } from '../src/default-tool-cards.js'

it('submits multiple choices with free text and exposes authorized deliverable open/download links', async () => {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const prompt = vi.fn(async () => {})
  const release = vi.fn()
  const load = vi.fn(async () => ({ url: 'blob:report', release }))
  const node = {
    kind: 'tool',
    slots: [
      {
        slot: 'tool.card.inline',
        payload: {
          question: {
            id: 'q',
            questions: [
              {
                id: 'choice',
                question: 'Pick routes',
                options: ['A', 'B'],
                multiple: true,
                allowFreeText: true,
              },
            ],
          },
        },
      },
      {
        slot: 'tool.card.inline',
        payload: {
          deliverables: [
            {
              name: 'report.txt',
              ref: { sha256: 'a'.repeat(64), size: 6, mime: 'text/plain' },
              lane: 'main',
            },
          ],
        },
      },
    ],
  } as unknown as Extract<UINode, { kind: 'tool' }>
  try {
    flushSync(() =>
      root.render(
        createElement(DefaultToolCards, {
          node,
          session: { commands: { prompt } } as unknown as SessionService,
          resources: { files: { load } } as unknown as ClientResourceService,
          answered: new Set<string>(),
        }),
      ),
    )
    await vi.waitFor(() => expect(el.querySelector('a[download]')?.getAttribute('href')).toBe('blob:report'))
    expect(el.querySelector('a[target="_blank"]')?.getAttribute('rel')).toContain('noopener')
    expect(el.querySelector('a[download]')?.getAttribute('download')).toBe('report.txt')
    flushSync(() => el.querySelector<HTMLInputElement>('input[value="A"]')!.click())
    flushSync(() => el.querySelector<HTMLInputElement>('input[value="B"]')!.click())
    const textarea = el.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'C')
    flushSync(() => textarea.dispatchEvent(new Event('input', { bubbles: true })))
    flushSync(() =>
      el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
    await vi.waitFor(() =>
      expect(prompt).toHaveBeenCalledWith([
        { type: 'text', text: '[question-answer q] {"choice":["A","B","C"]}' },
      ]),
    )
    expect(load).toHaveBeenCalledWith({
      laneId: 'main',
      artifact: { sha256: 'a'.repeat(64), size: 6, mime: 'text/plain' },
    })
  } finally {
    flushSync(() => root.unmount())
    el.remove()
  }
  expect(release).toHaveBeenCalled()
})

it('expands workflow stages and links each member to its child session', () => {
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const node = {
    kind: 'tool',
    name: 'workflow',
    slots: [
      {
        extId: 'agnes/workflow',
        slot: 'tool.card.inline',
        payload: {
          title: 'Research · completed',
          table: {
            columns: ['Stage', 'Member', 'Status', 'Child session'],
            rows: [
              ['Research', 'Analyst', 'completed', 'child:one'],
              ['Write', 'Writer', 'pending', ''],
            ],
          },
        },
      },
    ],
  } as unknown as Extract<UINode, { kind: 'tool' }>
  try {
    flushSync(() => root.render(createElement(DefaultToolCards, { node, answered: new Set<string>() })))
    expect(el.querySelector('[data-testid="workflow-run-card"]')?.getAttribute('aria-label')).toBe(
      'Workflow run',
    )
    const stage = el.querySelector<HTMLDetailsElement>('[data-testid="workflow-stage"]')!
    stage.querySelector('summary')!.click()
    expect(stage.open).toBe(true)
    expect(el.querySelector('[data-testid="workflow-child-session"]')?.getAttribute('href')).toBe(
      '?session=child%3Aone',
    )
    expect(el.querySelectorAll('[data-testid="workflow-member"]')).toHaveLength(2)
  } finally {
    flushSync(() => root.unmount())
    el.remove()
  }
})
