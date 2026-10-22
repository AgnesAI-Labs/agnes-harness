/** @vitest-environment happy-dom */
import { SettingsSubpageFrame } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryPanel } from '../src/settings/memory.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const hash = (char: string) => char.repeat(64)
const context = (workspaces: { path: string; available: boolean }[]) => ({
  config: {
    rulesEnabled: true,
    timeEnabled: true,
    timeZone: 'Asia/Shanghai',
    refreshIntervalMs: 600_000,
    maxBytes: 65_536,
    maxSourceBytes: 32_768,
    customSkillRoots: [],
    instructionFiles: [],
    localInstructionFiles: [],
  },
  workspaces,
})
const inspection = (mode: 'off' | 'ask' | 'auto') => ({
  root: '/data/agh/memory/WorkLLM',
  settings: {
    mode,
    indexMaxBytes: 16_384,
    indexMaxLines: 200,
    topicMaxBytes: 16_384,
    totalMaxBytes: 65_536,
    tokenBudget: 2048,
    userTokenBudget: 1024,
    userEnabled: true,
  },
  files: [{ path: 'MEMORY.md', hash: hash('a'), bytes: 1024, lines: 3 }],
  bytes: 1024,
  lastWriter: { sessionKey: 'shoe-portal', turn: 4 },
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function server(fail: (body: Record<string, unknown>) => boolean = () => false) {
  const memory: Record<string, unknown>[] = []
  let mode: 'off' | 'ask' | 'auto' = 'off'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (url === '/api/context') return Response.json(context([{ path: '/work/WorkLLM', available: true }]))
      memory.push(body)
      if (fail(body)) return Response.json({ error: { code: 'E_TEST', message: 'nope' } }, { status: 500 })
      const settings = body.settings as { mode?: typeof mode } | undefined
      if (settings?.mode) mode = settings.mode
      const file =
        typeof body.file === 'string'
          ? {
              path: body.file,
              hash: hash(body.content === undefined ? 'a' : 'b'),
              bytes: 10,
              lines: 1,
              content: typeof body.content === 'string' ? body.content : '- prefers tables',
            }
          : undefined
      return Response.json({
        workspaces: [{ path: '/work/WorkLLM', available: true }],
        inspection: inspection(mode),
        ...(file ? { file } : {}),
      })
    }),
  )
  return memory
}

async function render() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(SettingsSubpageFrame, { header: null }, createElement(MemoryPanel, { canSave: true })),
    ),
  )
  await act(async () => {})
  return { host, unmount: () => act(async () => root.unmount()) }
}
const radio = (host: HTMLElement, value: string) =>
  host.querySelector<HTMLInputElement>(`[data-testid="memory-mode-${value}"]`)

it('picks the workspace, changes the mode with one click, and reports a failed change at the label', async () => {
  let failing = false
  const memory = server((body) => failing && !!body.settings)
  const { host, unmount } = await render()
  try {
    expect(host.querySelector<HTMLSelectElement>('[data-testid="memory-workspace"]')?.value).toBe(
      '/work/WorkLLM',
    )
    expect(radio(host, 'off')?.checked).toBe(true)
    await act(async () => radio(host, 'ask')?.click())
    expect(memory.at(-1)).toEqual({ cwd: '/work/WorkLLM', settings: { mode: 'ask' } })
    expect(radio(host, 'ask')?.checked).toBe(true)
    failing = true
    await act(async () => radio(host, 'auto')?.click())
    expect(host.querySelector('[data-testid="settings-save-failed"]')).not.toBeNull()
    // The failed choice stays on screen until it is retried.
    expect(radio(host, 'auto')?.checked).toBe(true)
    failing = false
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="settings-save-retry"]')?.click(),
    )
    expect(memory.at(-1)).toEqual({ cwd: '/work/WorkLLM', settings: { mode: 'auto' } })
    expect(host.querySelector('[data-testid="settings-save-failed"]')).toBeNull()
  } finally {
    await unmount()
  }
})

it('opens the memory files subpage with MEMORY.md, saves with the version it read, and shows where it is kept', async () => {
  const memory = server()
  const { host, unmount } = await render()
  try {
    const drill = host.querySelector<HTMLButtonElement>('[data-testid="memory-open"]')
    expect(drill?.textContent).toContain('1')
    await act(async () => drill?.click())
    expect(memory.at(-1)).toEqual({ cwd: '/work/WorkLLM', file: 'MEMORY.md' })
    const editor = host.querySelector<HTMLTextAreaElement>('[data-testid="memory-content"]')
    expect(editor?.value).toBe('- prefers tables')
    const save = host.querySelector<HTMLButtonElement>('[data-testid="memory-save"]')
    expect(save?.disabled).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        editor,
        '- prefers lists',
      )
      editor?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => save?.click())
    expect(memory.at(-1)).toEqual({
      cwd: '/work/WorkLLM',
      file: 'MEMORY.md',
      content: '- prefers lists',
      baseHash: hash('a'),
    })
    expect(host.querySelector('[data-testid="memory-root"]')?.textContent).toBe('/data/agh/memory/WorkLLM')
    expect(host.querySelector('[data-testid="memory-writer"]')?.textContent).toBe('shoe-portal · 4')
    expect(host.querySelector('[data-testid="memory-size"]')?.textContent).toContain('200')
  } finally {
    await unmount()
  }
})

it('asks for a workspace when none is open', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(context([]))),
  )
  const { host, unmount } = await render()
  try {
    expect(host.querySelector('[data-testid="memory-no-workspace"]')?.textContent).toBe(
      'Open a workspace first',
    )
    expect(host.querySelector('[data-testid="memory-mode"]')).toBeNull()
  } finally {
    await unmount()
  }
})

it.each(['saved', 'failed', 'read'] as const)(
  'retires an old memory %s when permission changes',
  async (outcome) => {
    let finish!: (response: Response) => void
    let oldSignal: AbortSignal | null | undefined
    let delayed = false
    const value = (mode: 'off' | 'ask') => ({
      workspaces: [{ path: '/work/WorkLLM', available: true }],
      inspection: inspection(mode),
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/context')
          return Response.json(context([{ path: '/work/WorkLLM', available: true }]))
        if (delayed) {
          delayed = false
          oldSignal = init?.signal
          return new Promise<Response>((resolve) => {
            finish = resolve
          })
        }
        return Response.json(value('off'))
      }),
    )
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const draw = (canSave: boolean) => act(async () => root.render(createElement(MemoryPanel, { canSave })))
    try {
      if (outcome === 'read') delayed = true
      await draw(true)
      if (outcome !== 'read') {
        delayed = true
        await act(async () => radio(host, 'ask')?.click())
      }
      expect(finish).toBeTypeOf('function')
      await draw(false)
      expect(oldSignal?.aborted).toBe(true)
      await act(async () =>
        finish(outcome === 'failed' ? Response.json({}, { status: 500 }) : Response.json(value('ask'))),
      )
      expect(radio(host, 'off')?.checked).toBe(true)
      expect(host.querySelector('[data-testid="settings-save-failed"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  },
)

it('keeps the selected workspace when save permission arrives after the first read', async () => {
  const workspaces = [
    { path: '/work/default', available: true },
    { path: '/work/selected', available: true },
  ]
  const changes: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/context') return Response.json(context(workspaces))
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (body.settings) changes.push(body)
      return Response.json({ workspaces, inspection: inspection(body.settings?.mode ?? 'off') })
    }),
  )
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const draw = (canSave: boolean) => act(async () => root.render(createElement(MemoryPanel, { canSave })))
  try {
    await draw(false)
    const workspace = host.querySelector<HTMLSelectElement>('[data-testid="memory-workspace"]')!
    await act(async () => {
      workspace.value = '/work/selected'
      workspace.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(workspace.value).toBe('/work/selected')
    await draw(true)
    expect(workspace.value).toBe('/work/selected')
    await act(async () => radio(host, 'auto')?.click())
    expect(changes).toEqual([{ cwd: '/work/selected', settings: { mode: 'auto' } }])
  } finally {
    await act(async () => root.unmount())
  }
})
