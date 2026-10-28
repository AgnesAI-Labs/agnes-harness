/** @vitest-environment happy-dom */

import { resolve } from 'node:path'
import type { PageSessionMeta, WorkspaceEntry } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
import { resetCollapsedGroups } from '../src/navigation.js'
import { sessionInventory } from '../src/session-inventory.js'
import { sidebarGrouping } from '../src/sidebar-grouping.js'
import { sidebarOrder } from '../src/sidebar-order.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

const css = readWebStyleSource(resolve(__dirname, '../public/style.css')).replace(/\/\*[\s\S]*?\*\//g, '')

/** Every innermost style rule, with its at-rule headers dropped from the selector. */
function rules(): { selectors: string[]; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, head = '', body = '']) => ({
    selectors: (head.split(/[;{}]/).pop() ?? '')
      .split(/,(?![^(]*\))/)
      .map((selector) => selector.trim().replace(/\s+/g, ' ')),
    body,
  }))
}

/** All declarations written for one selector, in source order. */
const bodies = (selector: string) =>
  rules()
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => rule.body)
    .join('\n')

const PROJECT_ACTIONS = '.workspace-heading-row.is-nested .workspace-row-actions'
const SECTION_TOOLS = '.sidebar-section > .workspace-heading-row > :not(.workspace-heading)'
const LIST_TOOLS = '.sidebar-section-heading > :not(.section-label)'

const session = (id: string, cwd: string): PageSessionMeta['items'][number] =>
  ({
    sessionId: id,
    title: `会话 ${id}`,
    cwd,
    archived: false,
    createdAt: '',
    lastSeq: 1,
    generation: 1,
    preset: 'code',
  }) as PageSessionMeta['items'][number]

const workspace = (path: string, name: string): WorkspaceEntry => ({
  path,
  name,
  lastUsedAt: null,
  sessionCount: 1,
  available: true,
})

describe('sidebar row actions', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
    resetCollapsedGroups()
    sidebarOrder.reset()
    sessionInventory.reset()
    sidebarGrouping.reset()
    vi.unstubAllGlobals()
  })

  it('puts a project row’s actions after its heading, in flow, never over the name', async () => {
    const chats: WorkspaceEntry = { ...workspace('/chats', 'chats'), kind: 'chats' }
    runtime = await mountRenderedIndex({
      sidebar: {
        state: {
          sessions: [
            { ...session('pinned', '/long'), pinnedAt: '2026-10-20T08:00:00.000Z' },
            session('chat', '/chats'),
            session('one', '/long'),
          ],
          workspaces: [workspace('/long', 'agnes-harness-runtime-pluginization'), chats],
          labels: new Map(),
          sessionPending: false,
          newDisabled: false,
        },
      },
    })
    const row = document.querySelector<HTMLElement>('.workspace-group.is-nested .workspace-heading-row')
    if (!row) throw new Error('missing project row')
    const [heading, actions] = [...row.children]
    // The name and the count live in the heading button; the actions are the row's next child.
    expect(heading?.classList.contains('workspace-heading')).toBe(true)
    expect(heading?.querySelector('.workspace-name')?.textContent).toBe('agnes-harness-runtime-pluginization')
    expect(heading?.querySelector('.workspace-count')).not.toBeNull()
    expect(actions?.classList.contains('workspace-row-actions')).toBe(true)
    expect(actions?.querySelector('.workspace-new-session')).not.toBeNull()
    expect(actions?.querySelector('.workspace-menu-trigger')).not.toBeNull()
    // Every id in the sidebar is unique: a section body and its rows used to share one.
    const ids = [...document.querySelectorAll('aside.sidebar [id]')].map((node) => node.id)
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
    const pinnedBody = document.querySelector('#sidebar-section-pinned')
    expect(pinnedBody?.classList.contains('sidebar-section-body')).toBe(true)
    expect(
      document.querySelector('[data-section="pinned"] .workspace-heading')?.getAttribute('aria-controls'),
    ).toBe('sidebar-section-pinned')
  })

  it('lays the project name out as a shrinking ellipsis and the actions in flow', () => {
    expect(bodies('.workspace-heading .workspace-name')).toMatch(/flex: 1;[\s\S]*min-width: 0;/)
    expect(bodies('.workspace-heading .workspace-name')).toMatch(/text-overflow: ellipsis;/)
    expect(bodies('.workspace-heading .workspace-name')).toMatch(/text-align: start;/)
    expect(bodies('.workspace-heading')).toMatch(/min-width: 0;/)
    // No absolutely positioned row actions anywhere in the sidebar rows.
    for (const rule of rules()) {
      if (rule.selectors.some((selector) => /workspace-row-actions|session-menu/.test(selector)))
        expect(rule.body).not.toMatch(/position: absolute/)
    }
    // At rest the project's actions take no width; hover or focus gives them their room and
    // takes the count away.
    expect(bodies(PROJECT_ACTIONS)).toMatch(/flex: none;[\s\S]*width: 0;/)
    expect(
      bodies('.workspace-heading-row.is-nested:is(:hover, :focus-within) .workspace-row-actions'),
    ).toMatch(/width: auto;/)
    expect(bodies('.workspace-heading-row.is-nested:is(:hover, :focus-within) .workspace-count')).toMatch(
      /display: none;/,
    )
    // Session rows follow the same pattern: the menu has no width at rest, the time gives way.
    expect(bodies('.session-menu')).toMatch(/width: 0;/)
    expect(bodies('.session-row:is(:hover, :focus-within, [data-menu-open="true"]) .session-time')).toMatch(
      /display: none;/,
    )
  })

  it('hides heading tools at rest and shows them on hover, focus or an open menu', () => {
    for (const tools of [SECTION_TOOLS, LIST_TOOLS]) {
      const rest = rules().find((rule) => rule.selectors.includes(tools) && /opacity: 0;/.test(rule.body))
      // Opacity only, so the heading keeps its size and the buttons stay in the tab order.
      expect(rest?.body).toMatch(/pointer-events: none;/)
      expect(rest?.body).not.toMatch(/display: none|visibility: hidden|width: 0/)
    }
    const shown = rules().find((rule) =>
      rule.selectors.includes(
        '.sidebar-section > .workspace-heading-row:is(:hover, :focus-within) > :not(.workspace-heading)',
      ),
    )
    expect(shown?.body).toMatch(/opacity: 1;/)
    expect(shown?.selectors).toEqual(
      expect.arrayContaining([
        '.sidebar-section-heading:is(:hover, :focus-within) > :not(.section-label)',
        '.sidebar-section > .workspace-heading-row > :not(.workspace-heading):has([aria-expanded="true"])',
      ]),
    )
    // The fold chevron belongs to the heading button, which none of these rules touch.
    expect(bodies('.workspace-chevron')).not.toMatch(/opacity/)
  })

  it('keeps row actions and heading tools visible on devices without hover', () => {
    const media = css.indexOf('@media (max-width: 720px), (hover: none) {')
    expect(media).toBeGreaterThan(-1)
    const block = css.slice(media, css.indexOf('}', css.indexOf('}', media) + 1))
    for (const selector of ['.workspace-heading-row .workspace-row-actions', SECTION_TOOLS, LIST_TOOLS])
      expect(block).toContain(selector)
    expect(block).toMatch(/opacity: 1;/)
    expect(css).toMatch(/@media \(max-width: 720px\), \(hover: none\) \{\s*\.session-menu \{/)
  })
})
