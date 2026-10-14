/** @vitest-environment happy-dom */
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ContextPanel } from '../src/settings/context.js'

it('loads and saves installation context, previews workspace rules and composes a slash Skill request', async () => {
  const config = {
    rulesEnabled: true,
    timeEnabled: true,
    timeZone: 'UTC',
    refreshIntervalMs: 600000,
    maxBytes: 32768,
    maxSourceBytes: 1048576,
    instructionFiles: ['AGENTS.md'],
    localInstructionFiles: [],
    customSkillRoots: [],
  }
  const requests: Record<string, unknown>[] = []
  let malformed = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const input = JSON.parse(init.body)
      requests.push(input)
      if (malformed) return Response.json({ configured: false })
      return Response.json({
        config: input.config ?? config,
        workspaces: [{ path: '/synthetic/project', available: true }],
        ...(input.cwd
          ? {
              rules: {
                files: [
                  {
                    path: 'AGENTS.md',
                    scope: '.',
                    content: 'Follow project conventions',
                    trust: 'repository',
                  },
                ],
                skipped: [],
              },
            }
          : {}),
      })
    }),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const control = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLInputElement
  try {
    flushSync(() => root.render(createElement(ContextPanel, { canSave: true })))
    await vi.waitFor(() => expect(control('context-zone')?.value).toBe('UTC'))
    // Nothing is edited yet, so there is nothing to save.
    expect((control('context-save') as unknown as HTMLButtonElement).disabled).toBe(true)
    expect(host.querySelector('[data-testid="context-rule-files"]')).toBeNull()
    // Choosing a workspace reads its rules at once.
    flushSync(() =>
      host.querySelector('#context-workspace')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    )
    const workspace = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find(
      (entry) => entry.textContent === '/synthetic/project',
    )
    expect(workspace).toBeDefined()
    flushSync(() => workspace?.click())
    await vi.waitFor(() => expect(host.querySelector('[data-testid="context-rule-files"]')).not.toBeNull())
    expect(requests.at(-1)).toEqual({ cwd: '/synthetic/project' })
    // Each rule file is a row; its text opens inside a code block that can be copied.
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="context-rule-files"] .agh-disclosure-summary')).not.toBeNull(),
    )
    flushSync(() =>
      host.querySelector<HTMLElement>('[data-testid="context-rule-files"] .agh-disclosure-summary')?.click(),
    )
    await vi.waitFor(() => expect(host.textContent).toContain('Follow project conventions'))
    expect(
      host.querySelector('[data-testid="context-rule-files"] .agnes-settings-code button'),
    ).not.toBeNull()
    flushSync(() => {
      const input = control('context-skill-roots')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        input,
        '/opt/team-skills',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    flushSync(() => control('context-save').click())
    await vi.waitFor(() =>
      expect(
        requests.some(
          (r) => (r.config as typeof config | undefined)?.customSkillRoots[0] === '/opt/team-skills',
        ),
      ).toBe(true),
    )
    flushSync(() => {
      const input = control('context-skill-name')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'review')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(control('context-skill-invoke').getAttribute('href')).toContain('prompt=%2Fskill+invoke+review')
    await vi.waitFor(() => expect(control('context-panel').getAttribute('aria-busy')).toBe('false'))
    malformed = true
    flushSync(() => control('context-refresh').click())
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull())
    expect(host.textContent).toContain('Follow project conventions')
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
