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
  saved = []
  userSaved = []
})

type Saved = { id: string; text: string; validity: string; reviewAfter?: number; initiator?: string }
let saved: Saved[] = []
/** Task experience promoted to user memory. */
let userSaved: Saved[] = []

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
      const asked = body.saved as { action: string; paragraphId?: string; layer?: 'user' } | undefined
      let list = asked?.layer === 'user' ? userSaved : saved
      if (asked?.action === 'withdraw' || asked?.action === 'convert')
        list = list.filter((entry) => entry.id !== asked.paragraphId)
      if (asked?.action === 'renew')
        list = list.map((entry) =>
          entry.id === asked.paragraphId
            ? { ...entry, validity: 'valid', reviewAfter: Date.UTC(2026, 11, 4) }
            : entry,
        )
      if (asked?.layer === 'user') userSaved = list
      else saved = list
      return Response.json({
        workspaces: [{ path: '/work/WorkLLM', available: true }],
        inspection: inspection(mode),
        ...(file ? { file } : {}),
        ...(asked ? { saved: { paragraphs: list } } : {}),
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
    // The file, then the saved task experience paragraphs beside it, the workspace's and those in user
    // memory (none here: no section is shown).
    expect(memory.slice(-3)).toEqual([
      { cwd: '/work/WorkLLM', file: 'MEMORY.md' },
      { cwd: '/work/WorkLLM', saved: { action: 'list' } },
      { cwd: '/work/WorkLLM', saved: { action: 'list', layer: 'user' } },
    ])
    expect(host.querySelector('[data-testid="memory-saved"]')).toBeNull()
    expect(host.querySelector('[data-testid="memory-user-saved"]')).toBeNull()
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

it('re-reads memory written while settings were closed and keeps an unsaved draft', async () => {
  let stored = ''
  const reads: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (url === '/api/context') return Response.json(context([{ path: '/work/WorkLLM', available: true }]))
      reads.push(body)
      const file =
        typeof body.file === 'string'
          ? {
              path: body.file,
              hash: hash(stored ? 'b' : 'a'),
              bytes: stored.length,
              lines: 1,
              content: stored,
            }
          : undefined
      return Response.json({
        workspaces: [{ path: '/work/WorkLLM', available: true }],
        inspection: {
          ...inspection('auto'),
          lastWriter: stored ? { sessionKey: 'agent', turn: 1 } : undefined,
        },
        ...(file ? { file } : {}),
      })
    }),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const show = (visit: number) =>
    act(async () =>
      root.render(
        createElement(
          SettingsSubpageFrame,
          { header: null },
          createElement(MemoryPanel, { canSave: true, visit }),
        ),
      ),
    )
  const editor = () => host.querySelector<HTMLTextAreaElement>('[data-testid="memory-content"]')
  try {
    await show(1)
    await act(async () => {})
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="memory-open"]')?.click())
    expect(editor()?.value).toBe('')
    // An agent writes the file while the dialog is closed; the next visit shows it.
    stored = 'Prefer concise synthetic summaries.'
    await show(2)
    await act(async () => {})
    expect(reads.at(-1)).toEqual({ cwd: '/work/WorkLLM', file: 'MEMORY.md' })
    expect(editor()?.value).toBe('Prefer concise synthetic summaries.')
    expect(host.querySelector('[data-testid="memory-writer"]')?.textContent).toBe('agent · 1')
    // An unsaved edit is the reader's own: a later visit refreshes the summary, not the editor.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor(), 'Draft')
      editor()?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    stored = 'Changed elsewhere.'
    await show(3)
    await act(async () => {})
    expect(reads.at(-1)).toEqual({ cwd: '/work/WorkLLM' })
    expect(editor()?.value).toBe('Draft')
  } finally {
    await act(async () => root.unmount())
  }
})

it('lists saved task experience with review dates and renews, withdraws or converts a paragraph', async () => {
  saved = [
    {
      id: 'ra000000001',
      text: 'Lint first\nRun pnpm lint before committing.',
      validity: 'valid',
      reviewAfter: Date.UTC(2026, 11, 1),
      initiator: 'auto',
    },
    {
      id: 'rb000000001',
      text: 'Short answers\nKeep answers short.',
      validity: 'expired',
      reviewAfter: Date.UTC(2026, 9, 1),
      initiator: 'model',
    },
    { id: 'rc000000001', text: 'Unconfirmed\nA save whose result is not known.', validity: 'unknown' },
  ]
  const memory = server()
  const { host, unmount } = await render()
  try {
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="memory-open"]')?.click())
    await act(async () => {})
    expect(memory).toContainEqual({ cwd: '/work/WorkLLM', saved: { action: 'list' } })
    const section = host.querySelector<HTMLElement>('[data-testid="memory-saved"]')
    expect(section?.textContent).toContain('30-day review')
    // Memory full: nothing is merged automatically; the person frees space.
    expect(section?.textContent).toMatch(/full.*nothing is merged.*free space/i)
    const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="memory-saved-paragraph"]')]
    expect(rows().map((row) => row.querySelector('[translate="no"]')?.textContent)).toEqual([
      'Lint first',
      'Short answers',
      'Unconfirmed',
    ])
    expect(rows()[0]?.textContent).toMatch(/agent sees it.*review by/i)
    expect(rows()[0]?.textContent).toContain('2026')
    expect(rows()[1]?.textContent).toMatch(/past its review date/i)
    expect(rows()[2]?.textContent).toMatch(/does not see it until you/i)
    // No review date to renew for a paragraph nothing vouches for.
    expect(rows()[2]?.querySelector('[data-testid="memory-saved-renew"]')).toBeNull()
    await act(async () =>
      rows()[1]?.querySelector<HTMLButtonElement>('[data-testid="memory-saved-renew"]')?.click(),
    )
    expect(memory.at(-1)).toEqual({
      cwd: '/work/WorkLLM',
      saved: { action: 'renew', paragraphId: 'rb000000001' },
    })
    expect(rows()[1]?.textContent).toMatch(/agent sees it/i)
    // Withdrawing changes MEMORY.md: the open, unedited file is read again.
    await act(async () =>
      rows()[0]?.querySelector<HTMLButtonElement>('[data-testid="memory-saved-withdraw"]')?.click(),
    )
    expect(memory.slice(-2)).toEqual([
      { cwd: '/work/WorkLLM', saved: { action: 'withdraw', paragraphId: 'ra000000001' } },
      { cwd: '/work/WorkLLM', file: 'MEMORY.md' },
    ])
    expect(rows()).toHaveLength(2)
    await act(async () =>
      rows()[1]?.querySelector<HTMLButtonElement>('[data-testid="memory-saved-convert"]')?.click(),
    )
    expect(memory.at(-2)).toEqual({
      cwd: '/work/WorkLLM',
      saved: { action: 'convert', paragraphId: 'rc000000001' },
    })
    expect(rows().map((row) => row.querySelector('[translate="no"]')?.textContent)).toEqual(['Short answers'])
  } finally {
    await unmount()
  }
})

it('user-layer RSI sections show validity and can be renewed or withdrawn', async () => {
  userSaved = [
    {
      id: 'rd000000001',
      text: 'Answer style\nAnswer in short sentences.',
      validity: 'expired',
      reviewAfter: Date.UTC(2026, 9, 1),
      initiator: 'auto',
    },
    {
      id: 're000000001',
      text: 'Package manager\nPrefer pnpm.',
      validity: 'valid',
      reviewAfter: Date.UTC(2026, 11, 1),
      initiator: 'auto',
    },
  ]
  const memory = server()
  const { host, unmount } = await render()
  try {
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="memory-open"]')?.click())
    await act(async () => {})
    expect(memory).toContainEqual({ cwd: '/work/WorkLLM', saved: { action: 'list', layer: 'user' } })
    const section = host.querySelector<HTMLElement>('[data-testid="memory-user-saved"]')
    expect(section?.textContent).toContain('user memory')
    expect(section?.textContent).toMatch(/every workspace/i)
    // Memory is off in this workspace: it does not read user memory, and the page says so.
    expect(section?.textContent).toMatch(/this workspace does not read user memory/i)
    const rows = () => [...host.querySelectorAll<HTMLElement>('[data-testid="memory-user-saved-paragraph"]')]
    expect(rows().map((row) => row.querySelector('[translate="no"]')?.textContent)).toEqual([
      'Answer style',
      'Package manager',
    ])
    expect(rows()[0]?.textContent).toMatch(/past its review date/i)
    // User memory has no "make ordinary": a person keeps text there by writing it by hand.
    expect(section?.querySelector('[data-testid="memory-saved-convert"]')).toBeNull()
    await act(async () =>
      rows()[0]?.querySelector<HTMLButtonElement>('[data-testid="memory-saved-renew"]')?.click(),
    )
    expect(memory.at(-1)).toEqual({
      cwd: '/work/WorkLLM',
      saved: { action: 'renew', paragraphId: 'rd000000001', layer: 'user' },
    })
    expect(rows()[0]?.textContent).toMatch(/agent sees it/i)
    await act(async () =>
      rows()[1]?.querySelector<HTMLButtonElement>('[data-testid="memory-saved-withdraw"]')?.click(),
    )
    expect(memory.at(-1)).toEqual({
      cwd: '/work/WorkLLM',
      saved: { action: 'withdraw', paragraphId: 're000000001', layer: 'user' },
    })
    expect(rows()).toHaveLength(1)
    // The workspace's own block is not shown when it holds nothing.
    expect(host.querySelector('[data-testid="memory-saved"]')).toBeNull()
  } finally {
    await unmount()
  }
})
