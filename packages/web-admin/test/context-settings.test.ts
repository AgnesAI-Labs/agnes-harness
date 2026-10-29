/** @vitest-environment happy-dom */

import { SettingsSubpageFrame } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ContextPanel } from '../src/settings/context.js'

it('saves each context change by itself, as presets and chips, and previews a workspace’s rules in a subpage', async () => {
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
  const saved = () => requests.filter((request) => request.config)
  try {
    flushSync(() =>
      root.render(
        createElement(SettingsSubpageFrame, { header: null }, createElement(ContextPanel, { canSave: true })),
      ),
    )
    await vi.waitFor(() => expect(control('context-rules-enabled')).not.toBeNull())
    // Nothing to press: each change saves itself.
    expect(host.querySelector('[data-testid="context-save"]')).toBeNull()
    flushSync(() => control('context-time-enabled').click())
    await vi.waitFor(() => expect(saved().at(-1)?.config).toMatchObject({ timeEnabled: false }))
    flushSync(() => control('context-time-enabled').click())
    await vi.waitFor(() => expect(saved().at(-1)?.config).toMatchObject({ timeEnabled: true }))
    // The refresh is a preset: 10 minutes is stored as 600000 ms.
    const interval = control('context-interval') as unknown as HTMLSelectElement
    expect(interval.value).toBe('600000')
    flushSync(() => {
      interval.value = '0'
      interval.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await vi.waitFor(() => expect(saved().at(-1)?.config).toMatchObject({ refreshIntervalMs: 0 }))
    // Skill folders are chips: a typed path is added with Enter.
    const folder = host.querySelector<HTMLInputElement>('[data-testid="context-skill-roots"] input')!
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        folder,
        '/opt/team-skills',
      )
      folder.dispatchEvent(new Event('input', { bubbles: true }))
    })
    flushSync(() => folder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await vi.waitFor(() =>
      expect(saved().at(-1)?.config).toMatchObject({ customSkillRoots: ['/opt/team-skills'] }),
    )
    // The rules a workspace loads are a subpage; choosing a workspace reads them at once.
    expect(host.querySelector('[data-testid="context-rule-files"]')).toBeNull()
    flushSync(() => control('context-rules-view').click())
    // The subpage moves focus to its title once it has opened.
    await new Promise((resolve) => setTimeout(resolve, 0))
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
    // Each rule file is a row; its text opens in place, in a code block that can be copied.
    const row = host.querySelector<HTMLButtonElement>(
      '[data-testid="context-rule-files"] button.agnes-settings-drill',
    )
    expect(row?.textContent).toContain('AGENTS.md')
    flushSync(() => row?.click())
    await vi.waitFor(() => expect(host.textContent).toContain('Follow project conventions'))
    expect(
      host.querySelector('[data-testid="context-rule-files"] .agnes-settings-code button'),
    ).not.toBeNull()
    // 运行技能 is no longer here; it is on each skill of the plugins page.
    expect(host.querySelector('[data-testid="context-skill-invoke"]')).toBeNull()
    malformed = true
    await vi.waitFor(() =>
      expect((control('context-refresh') as unknown as HTMLButtonElement).disabled).toBe(false),
    )
    flushSync(() => control('context-refresh').click())
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull())
    expect(host.textContent).toContain('Follow project conventions')
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('does not apply an old context save after permission changes', async () => {
  const config = {
    rulesEnabled: true,
    timeEnabled: true,
    timeZone: 'UTC',
    refreshIntervalMs: 600000,
    maxBytes: 32768,
    maxSourceBytes: 1048576,
    instructionFiles: [],
    localInstructionFiles: [],
    customSkillRoots: [],
  }
  let finish!: (response: Response) => void
  let signal: AbortSignal | null | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body))
      if (input.config) {
        signal = init?.signal
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      }
      return Response.json({ config, workspaces: [] })
    }),
  )
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const draw = (canSave: boolean) => flushSync(() => root.render(createElement(ContextPanel, { canSave })))
  try {
    draw(true)
    await vi.waitFor(() => expect(host.querySelector('[data-testid="context-time-enabled"]')).not.toBeNull())
    flushSync(() => host.querySelector<HTMLButtonElement>('[data-testid="context-time-enabled"]')?.click())
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    draw(false)
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    await act(async () =>
      finish(Response.json({ config: { ...config, timeZone: 'Pacific/Honolulu' }, workspaces: [] })),
    )
    await vi.waitFor(() => expect(host.textContent).not.toContain('Honolulu'))
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
