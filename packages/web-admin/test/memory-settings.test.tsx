/** @vitest-environment happy-dom */
import { createDocumentLocaleSource, SettingsSubpageFrame, UiLocaleProvider } from '@agnes/web-ui'
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
const inspection = (mode: 'off' | 'ask' | 'auto', userEnabled = true) => ({
  root: '/data/agh/memory/WorkLLM',
  settings: {
    mode,
    indexMaxBytes: 16_384,
    indexMaxLines: 200,
    topicMaxBytes: 16_384,
    totalMaxBytes: 65_536,
    tokenBudget: 2048,
    userTokenBudget: 1024,
    userEnabled,
  },
  files: [{ path: 'MEMORY.md', hash: hash('a'), bytes: 1024, lines: 3 }],
  bytes: 1024,
  lastWriter: { sessionKey: 'shoe-portal', turn: 4 },
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
  saved = []
  userSaved = []
})

type Saved = {
  id: string
  text: string
  validity: string
  reviewAfter?: number
  initiator?: string
  renewable?: boolean
  hidden?: true
}
let saved: Saved[] = []
/** Task experience promoted to user memory. */
let userSaved: Saved[] = []

function server(
  fail: (body: Record<string, unknown>) => boolean | string = () => false,
  userEnabled = true,
  topic?: string,
) {
  const memory: Record<string, unknown>[] = []
  let mode: 'off' | 'ask' | 'auto' = 'off'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      if (url === '/api/context') return Response.json(context([{ path: '/work/WorkLLM', available: true }]))
      memory.push(body)
      const refusal = fail(body)
      if (refusal)
        return Response.json(
          { error: { code: typeof refusal === 'string' ? refusal : 'E_TEST' } },
          { status: 409 },
        )
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
      if (body.deleteFile) topic = undefined
      const state = inspection(mode, userEnabled)
      if (topic) state.files.push({ path: topic, hash: hash('c'), bytes: 10, lines: 1 })
      return Response.json({
        workspaces: [{ path: '/work/WorkLLM', available: true }],
        inspection: state,
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
  const locale = createDocumentLocaleSource({})
  await act(async () =>
    root.render(
      <UiLocaleProvider source={locale.source}>
        <SettingsSubpageFrame header={null}>
          <MemoryPanel canSave />
        </SettingsSubpageFrame>
      </UiLocaleProvider>,
    ),
  )
  await act(async () => {})
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount())
      locale.dispose()
    },
  }
}
const radio = (host: HTMLElement, value: string) =>
  host.querySelector<HTMLInputElement>(`[data-testid="memory-mode-${value}"]`)

async function editContent(host: HTMLElement, text: string) {
  const editor = host.querySelector<HTMLTextAreaElement>('[data-testid="memory-content"]')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor, text)
    editor?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const visibilityCases = [
  ['en', 'off', true],
  ['en', 'auto', true],
  ['zh-CN', 'off', true],
  ['zh-CN', 'auto', true],
  ['en', 'auto', false],
] as const

it.each(visibilityCases)(
  'explains saved visibility in %s with memory %s and user memory %s',
  async (locale, mode, userEnabled) => {
    server(undefined, userEnabled)
    const valid = { id: 'ra000000001', text: 'Valid', validity: 'valid', reviewAfter: Date.UTC(2027, 0, 1) }
    saved = [valid, { ...valid, id: 'rb000000001', text: 'Expired', validity: 'expired' }]
    const hidden = { ...valid, hidden: true as const, id: 'rc000000001', text: 'Hidden' }
    saved.push(hidden)
    userSaved = [valid, hidden]
    document.documentElement.lang = locale
    const { host, unmount } = await render()
    const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent
    const zh = locale === 'zh-CN'
    const visible = zh ? '智能体能看到它' : 'The agent sees it'
    const nextTurn = zh ? '下一轮' : 'next turn'
    try {
      if (mode === 'auto') await act(async () => radio(host, mode)?.click())
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="memory-open"]')?.click())
      if (mode === 'off') {
        expect(text('memory-saved-off')).toContain(nextTurn)
        expect(text('memory-saved-paragraph')).toContain(zh ? '工作区记忆已关闭' : 'Workspace memory is off')
        expect(text('memory-saved-paragraph')).not.toContain(visible)
      } else {
        expect(text('memory-saved-off')).toBeUndefined()
        expect(text('memory-saved-paragraph')).toContain(visible)
      }
      if (mode === 'off' || !userEnabled) {
        expect(text('memory-user-saved-paragraph')).toContain(zh ? '其他工作区' : 'other workspaces')
        expect(text('memory-user-saved-paragraph')).not.toContain(visible)
      } else expect(text('memory-user-saved-paragraph')).toContain(visible)
      for (const [id, visibleLayer] of [
        ['memory-saved-paragraph', mode !== 'off'],
        ['memory-user-saved-paragraph', mode !== 'off' && userEnabled],
      ] as const) {
        const row = [...host.querySelectorAll(`[data-testid="${id}"]`)].at(-1)?.textContent
        const reason = zh ? '关联的主题已更改或删除' : 'outdated or missing topic'
        if (visibleLayer) {
          expect(row).toContain(reason)
          expect(row).toContain(
            new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(valid.reviewAfter),
          )
        } else expect(row).not.toContain(reason)
      }
      for (const id of ['memory-saved', 'memory-user-saved']) {
        expect(host.querySelector(`[data-testid="${id}"] p`)?.textContent).toContain(nextTurn)
      }
      expect(host.querySelectorAll('[data-testid="memory-saved-paragraph"]')[1]?.textContent).toContain(
        nextTurn,
      )
    } finally {
      await unmount()
    }
  },
)

it.each([
  ['en', 'off'],
  ['zh-CN', 'auto'],
] as const)('previews expiry in the %s editor with memory %s', async (locale, mode) => {
  server()
  document.documentElement.lang = locale
  const { host, unmount } = await render()
  const status = () =>
    host.querySelector('[data-testid="memory-actions"] [data-testid="memory-expiry-status"]')?.textContent
  const zh = locale === 'zh-CN'
  try {
    if (mode === 'auto') await act(async () => radio(host, mode)?.click())
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="memory-open"]')?.click())
    expect(status()).toBeUndefined()
    vi.useFakeTimers({ now: Date.UTC(2027, 0, 1), toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await editContent(
      host,
      [
        '<!-- expires_at: 2027-01-01T01:00+0100 -->\nAt the cutoff.\nSame paragraph.',
        '<!-- expires_at: tomorrow -->\nImmediately hidden.',
        ' <!-- expires_at: 2027-02-30 --> \nImpossible date.',
        '<!-- expires_at: 2029-01-01 -->\nLater.',
        'Inline <!-- expires_at: tomorrow -->',
        '<!-- expires_at: tomorrow --> trailing text',
        '<!-- expires_at: bad --> <!-- another comment -->',
        '<!-- expires_at: 2027-01-01T00:00:01 -->\nNext to expire.',
      ]
        .join('\n\n')
        .replaceAll('\n', '\r\n'),
    )
    expect(status()).toContain(zh ? '已过期的段落有 1 段' : 'Paragraphs past expiry (1)')
    expect(status()).toContain(zh ? '日期无效的段落有 2 段' : 'expiry date is invalid (2)')
    expect(status()).toContain(zh ? '尚未到期的标注有 2 处' : 'Upcoming expiries (2)')
    const firstDate = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      Date.now() + 1000,
    )
    expect(status()).toContain(firstDate)
    expect(status()).not.toContain('2029')
    expect(status()).toContain('memory_recall')
    expect(status()).toContain('expires_at')
    expect(status()).toContain(zh ? '下一轮' : 'next turn')
    expect(status()?.includes(zh ? '工作区记忆已关闭' : 'Workspace memory is off')).toBe(mode === 'off')
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(status()).toContain(zh ? '已过期的段落有 2 段' : 'Paragraphs past expiry (2)')
    expect(status()).toContain(zh ? '尚未到期的标注有 1 处' : 'Upcoming expiries (1)')
    await editContent(host, 'No expiry.')
    expect(status()).toBeUndefined()
  } finally {
    vi.useRealTimers()
    await unmount()
  }
})

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
    await act(async () => radio(host, 'auto')?.click())
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
    const annotated =
      '<!-- expires_at: 2020-01-01 -->\n<!-- refinement:ra000000001 -->\nPrefer lists\n<!-- /refinement:ra000000001 -->'
    await editContent(host, annotated)
    saved = [{ id: 'ra000000001', text: 'Prefer lists', validity: 'valid', hidden: true }]
    await act(async () => save?.click())
    expect(memory).toContainEqual({
      cwd: '/work/WorkLLM',
      file: 'MEMORY.md',
      content: annotated,
      baseHash: hash('a'),
    })
    expect(host.querySelector('[data-testid="memory-saved-paragraph"]')?.textContent).toMatch(
      /Prefer lists.*expiry annotation.*hides this paragraph/i,
    )
    expect(host.querySelector('[data-testid="memory-root"]')?.textContent).toBe('/data/agh/memory/WorkLLM')
    expect(host.querySelector('[data-testid="memory-writer"]')?.textContent).toBe('shoe-portal · 4')
    expect(host.querySelector('[data-testid="memory-size"]')?.textContent).toContain('200')
    // The injection limit is bytes, shown in KB.
    expect(host.querySelector('[data-testid="memory-inject-limit"]')?.textContent).toBe('2.0 KB')
  } finally {
    await unmount()
  }
})

it('edits expiry with the saved hash, retains the draft on conflict, and updates the entry at its deadline', async () => {
  const now = Date.UTC(2027, 2, 1, 1, 2, 3)
  vi.useFakeTimers({ now, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  let refusal = 'MEMORY_CONFLICT'
  const requests = server((body) => typeof body.content === 'string' && refusal)
  const { host, unmount } = await render()
  const section = () => host.querySelector<HTMLElement>('[data-testid="memory-entries"]')
  const button = (label: string) =>
    [...section()!.querySelectorAll('button')].find((b) => b.textContent === label)!
  const editor = () => host.querySelector<HTMLTextAreaElement>('[data-testid="memory-content"]')!
  try {
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="memory-open"]')?.click())
    expect(section()?.textContent).toContain('Workspace memory is off')
    await editContent(host, 'Draft')
    expect(button('Set expiry').disabled).toBe(true)
    expect(button('Delete entry').disabled).toBe(true)
    await editContent(host, '- prefers tables')
    await act(async () => button('Set expiry').click())
    const input = section()!.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
    const local = '2028-03-01T01:02:03'
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, local)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Save').click())
    expect(requests.at(-1)).toMatchObject({
      content: `<!-- expires_at: ${new Date(local).toISOString().replace('.000Z', 'Z')} -->\n- prefers tables`,
      baseHash: hash('a'),
    })
    const error = () => host.querySelector('[data-testid="memory-error"]')?.textContent
    expect(error()).toContain('Reload')
    for (const [code, hint] of [
      ['MEMORY_MISSING_TOPIC', 'missing memory topic'],
      ['MEMORY_SECRET_LIKE_CONTENT', 'Remove credentials'],
    ] as const) {
      refusal = code
      expect(section()?.querySelector('input')).toBeNull()
      await act(async () => button('Set expiry').click())
      await act(async () => button('+30d').click())
      expect(error()).toContain(hint)
    }
    expect(editor().value).toBe('- prefers tables')
    expect(section()?.querySelector('input')).toBeNull()
    await act(async () => button('Set expiry').click())
    refusal = ''
    await act(async () => button('+7d').click())
    expect(editor().value).toBe('<!-- expires_at: 2027-03-08T01:02:03Z -->\n- prefers tables')
    expect(section()?.textContent).toContain('Expiry: expires')
    await act(async () => {
      vi.advanceTimersByTime(7 * 86_400_000)
    })
    expect(section()?.textContent).toContain('Expiry: expired')
    await act(async () => button('Clear expiry').click())
    expect(requests.filter((req) => typeof req.content === 'string').at(-1)).toMatchObject({
      content: '- prefers tables',
      baseHash: hash('b'),
    })
    expect(section()?.textContent).toContain('Expiry: valid')
    await act(async () => button('Delete entry').click())
    expect(editor().value).toBe('')
    expect(section()).toBeNull()
  } finally {
    vi.useRealTimers()
    await unmount()
  }
})

it.each(['reviewAfter', 'paragraph annotation', 'index annotation', 'provider expiry'])(
  'refreshes a saved row at its %s deadline',
  async (source) => {
    const now = Date.UTC(2027, 0, 1)
    const deadline = now + 30_000
    const annotation = `<!-- expires_at: ${new Date(deadline).toISOString()} -->`
    const item = {
      id: 'ra000000001',
      text: source === 'paragraph annotation' ? `Remember\n${annotation}\nDetails` : 'Remember',
      validity: 'valid',
      ...(source === 'provider expiry' ? { nextExpiry: deadline } : {}),
      reviewAfter: source === 'reviewAfter' ? deadline : now + 86_400_000,
    }
    saved = [item]
    if (source === 'provider expiry') userSaved = [item]
    vi.useFakeTimers({ now, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    server()
    const { host, unmount } = await render()
    const row = () => host.querySelector('[data-testid="memory-saved-paragraph"]')?.textContent
    try {
      await act(async () => radio(host, 'auto')?.click())
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="memory-open"]')?.click())
      if (source === 'index annotation') {
        await editContent(
          host,
          `${annotation}\n<!-- refinement:${item.id} -->\nRemember\n<!-- /refinement:${item.id} -->`,
        )
        await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="memory-save"]')?.click())
      }
      expect(row()).toContain('The agent sees it.')
      saved = source === 'reviewAfter' ? [{ ...item, validity: 'expired' }] : [{ ...item, hidden: true }]
      if (source === 'provider expiry') userSaved = [{ ...item, hidden: true }]
      await act(async () => vi.advanceTimersByTimeAsync(29_999))
      expect(row()).toContain('The agent sees it.')
      await act(async () => vi.advanceTimersByTimeAsync(1))
      if (source === 'provider expiry')
        expect(host.querySelector('[data-testid="memory-user-saved-paragraph"]')?.textContent).toMatch(
          /expiry annotation/i,
        )
      expect(row()).toMatch(
        source === 'reviewAfter' ? /past its review date/i : /expiry annotation.*hides this paragraph/i,
      )
    } finally {
      await unmount()
      vi.useRealTimers()
    }
  },
)

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

const isolationCases = ['failed inspection', 'late withdraw', 'topic draft'] as const
it.each(isolationCases)('isolates memory edits on %s', async (scenario) => {
  const topic = 'topic.md'
  const first = '/work/WorkLLM'
  const second = '/work/second'
  const workspaces = [first, second].map((path) => ({ path, available: true }))
  saved = [{ id: 'ra000000001', text: 'Remember', validity: 'valid' }]
  const requests = server(undefined, true, topic)
  const respond = fetch
  let finish!: () => void
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === '/api/context') return Response.json(context(workspaces))
    const body = JSON.parse(String(init.body))
    const response = await respond(url, init)
    if (body.saved?.action === 'withdraw')
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    if (body.cwd === first) return response
    if (scenario === 'failed inspection') return Response.json({}, { status: 500 })
    const result = await response.json()
    result.inspection.root = second
    if (result.file) result.file.content = 'Second workspace'
    return Response.json(result)
  })
  const { host, unmount } = await render()
  const button = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="memory-${id}"]`)
  try {
    await act(async () => button('open')!.click())
    expect(button('files')?.textContent).toContain(topic)
    await act(async () =>
      button(scenario === 'failed inspection' ? 'delete-file' : 'saved-withdraw')!.click(),
    )
    if (scenario === 'topic draft') {
      await act(async () => button('open-file')!.click())
      await editContent(host, 'Unsaved topic draft')
      const before = requests.length
      await act(async () => finish())
      expect(button('actions')?.textContent).toContain(topic)
      expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Unsaved topic draft')
      expect(requests.slice(before)).toEqual([])
      return
    }
    const workspace = host.querySelector<HTMLSelectElement>('[data-testid="memory-workspace"]')!
    await act(async () => {
      workspace.value = second
      workspace.dispatchEvent(new Event('change', { bubbles: true }))
    })
    if (scenario === 'failed inspection') {
      expect(requests.at(-1)).toEqual({ cwd: second })
      expect(button('open')).toBeNull()
      expect(button('files')).toBeNull()
      expect(button('delete-file')).toBeNull()
      expect(button('delete-confirm')).toBeNull()
    } else {
      await act(async () => button('open-index')!.click())
      const afterSwitch = requests.length
      await act(async () => finish())
      expect(requests.slice(afterSwitch)).toEqual([])
      expect(button('root')?.textContent).toBe(second)
      expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Second workspace')
    }
  } finally {
    await unmount()
  }
})

it('preserves the later expiry in a fall-back overlap and requires a choice for a new wall time', async () => {
  const later = '2027-11-07T06:30:00Z'
  const transition = Date.parse('2027-11-07T06:00:00Z')
  const offset = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockImplementation(function (this: Date) {
    return this.getTime() < transition ? 240 : 300
  })
  const requests = server()
  const { host, unmount } = await render()
  const section = () => host.querySelector<HTMLElement>('[data-testid="memory-entries"]')!
  const button = (label: string) =>
    [...section().querySelectorAll('button')].find((b) => b.textContent === label)!
  try {
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="memory-open"]')!.click())
    const original = `<!-- expires_at: ${later} -->\nRemember`
    await editContent(host, original)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="memory-save"]')!.click())
    await act(async () => button('Edit expiry').click())
    await act(async () => button('Save').click())
    expect(requests.filter((req) => req.content).map((req) => req.content)).toEqual([original, original])
    await act(async () => button('Edit expiry').click())
    const input = section().querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '2027-11-07T01:45',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button('Save').disabled).toBe(true)
    expect(button('2027-11-07T05:45:00Z')).toBeDefined()
    await act(async () => button('2027-11-07T06:45:00Z').click())
    await act(async () => button('Save').click())
    expect(requests.filter((req) => req.content).at(-1)?.content).toBe(original.replace('06:30', '06:45'))
  } finally {
    offset.mockRestore()
    await unmount()
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
    const closed = reads.length
    await show(2)
    await act(async () => {})
    expect(reads.slice(closed)).toEqual(
      expect.arrayContaining([
        { cwd: '/work/WorkLLM', file: 'MEMORY.md' },
        { cwd: '/work/WorkLLM', saved: { action: 'list' } },
        { cwd: '/work/WorkLLM', saved: { action: 'list', layer: 'user' } },
      ]),
    )
    expect(editor()?.value).toBe('Prefer concise synthetic summaries.')
    expect(host.querySelector('[data-testid="memory-writer"]')?.textContent).toBe('agent · 1')
    // An unsaved edit is the reader's own: a later visit refreshes the summary, not the editor.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor(), 'Draft')
      editor()?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    stored = 'Changed elsewhere.'
    const draft = reads.length
    await show(3)
    await act(async () => {})
    expect(reads.slice(draft)).toContainEqual({ cwd: '/work/WorkLLM' })
    expect(reads.slice(draft).some((read) => read.file !== undefined)).toBe(false)
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
      hidden: true,
      renewable: false,
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
    expect(rows()[0]?.textContent).toMatch(/hidden.*review by/i)
    expect(rows()[0]?.textContent).toContain('2026')
    expect(rows()[1]?.textContent).toMatch(/past its review date.*next turn/i)
    expect(rows()[2]?.textContent).toMatch(/does not see it until you/i)
    expect(rows()[0]?.querySelector('[data-testid="memory-saved-renew"]')).toBeNull()
    // No review date to renew for a paragraph nothing vouches for.
    expect(rows()[2]?.querySelector('[data-testid="memory-saved-renew"]')).toBeNull()
    await act(async () =>
      rows()[1]?.querySelector<HTMLButtonElement>('[data-testid="memory-saved-renew"]')?.click(),
    )
    expect(memory.at(-1)).toEqual({
      cwd: '/work/WorkLLM',
      saved: { action: 'renew', paragraphId: 'rb000000001' },
    })
    expect(rows()[1]?.textContent).toMatch(/hidden.*review by/i)
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
    expect(rows()[0]?.textContent).toMatch(/other workspaces.*review by/i)
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

it('confirms deletion of a topic by its listed revision while memory is off', async () => {
  const path = 'prefs.md'
  let referenced = true
  const requests = server((body) => !!body.deleteFile && referenced && 'MEMORY_TOPIC_REFERENCED', true, path)
  const { host, unmount } = await render()
  const button = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="memory-${id}"]`)
  const click = (id: string) => act(async () => button(id)!.click())
  try {
    expect(radio(host, 'off')?.checked).toBe(true)
    await click('open')
    expect(host.querySelectorAll('[data-testid="memory-delete-file"]')).toHaveLength(1)
    await click('open-file')
    await editContent(host, 'Unsaved draft')
    expect(button('delete-file')?.disabled).toBe(true)
    await editContent(host, '- prefers tables')
    await click('delete-file')
    await click('delete-cancel')
    expect(requests.some((request) => request.deleteFile)).toBe(false)
    await click('delete-file')
    await click('delete-confirm')
    expect(requests.at(-1)).toEqual({ cwd: '/work/WorkLLM', deleteFile: { path, baseHash: hash('c') } })
    expect(button('error')?.textContent).toContain('MEMORY.md still links to this topic')
    expect(button('actions')?.textContent).toContain(path)
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('- prefers tables')
    referenced = false
    await click('delete-file')
    await click('delete-confirm')
    expect(button('files')?.textContent).not.toContain(path)
    expect(button('open-index')).not.toBeNull()
    expect(button('delete-file')).toBeNull()
    expect(button('delete-confirm')).toBeNull()
    expect(button('content')).toBeNull()
    expect(button('error')).toBeNull()
  } finally {
    await unmount()
  }
})
