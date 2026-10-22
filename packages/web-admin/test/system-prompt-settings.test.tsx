/** @vitest-environment happy-dom */
import type { SystemPromptSaveParams, SystemPromptSnapshot } from '@agnes/protocol'
import { SettingsSubpageFrame, type UiLocale, UiLocaleProvider } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  CustomInstructions,
  Personalization,
  PromptRows,
  replyStyleChoice,
} from '../src/settings/system-prompt.js'
import { systemPromptApi } from '../src/settings/system-prompt-api.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function fixture(initial: SystemPromptSnapshot['config'] = {}) {
  let revision = 0
  let beforeSave: (() => Promise<void>) | undefined
  let snapshot: SystemPromptSnapshot = {
    config: initial,
    effect: 'new-sessions',
    hash: 'a'.repeat(64),
    revision: '0'.repeat(64),
    preview: 'default-sections',
    sections: [{ id: 'persona', order: 1, source: 'plugin/persona.md', text: 'default' }],
  }
  const writes: SystemPromptSaveParams[] = []
  const fetcher: typeof fetch = async (_url, init) => {
    if (init?.method) {
      const competingSave = beforeSave
      beforeSave = undefined
      await competingSave?.()
      const input = JSON.parse(String(init.body))
      writes.push(input)
      // Match the server's compatibility contract: absent revisions still allow legacy writes.
      if (input.expectedRevision !== undefined && input.expectedRevision !== snapshot.revision)
        return Response.json(
          { error: { data: { code: 'CONFIG_REVISION_CONFLICT', current: snapshot } } },
          { status: 409 },
        )
      snapshot = { ...snapshot, config: input.config, revision: (++revision).toString(16).padStart(64, '0') }
    }
    return Response.json(snapshot)
  }
  const api = systemPromptApi(fetcher)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const field = (name: string) =>
    host.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-testid="system-prompt-${name}"]`)
  const input = async (name: string, text: string) =>
    act(async () => {
      const node = field(name)!
      const proto =
        node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(node, text)
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const button = (name: string) =>
    host.querySelector<HTMLButtonElement>(`[data-testid="system-prompt-${name}"]`)
  const click = async (name: string) => act(async () => button(name)!.click())
  return {
    api,
    host,
    root,
    writes,
    field,
    input,
    button,
    click,
    otherWindow: systemPromptApi(fetcher),
    saved: () => snapshot,
    beforeSave: (run: () => Promise<void>) => {
      beforeSave = run
    },
  }
}

it('saves the General page instructions by themselves, maps the reply styles, and locks them under a full replacement', async () => {
  const { api, host, root, writes, field, input } = fixture()
  let opened = 0
  const blur = async (name: string) =>
    act(async () => field(name)!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  const choose = async (value: string) =>
    act(async () =>
      host
        .querySelector<HTMLInputElement>(
          `[data-testid="system-prompt-replyStyle-choice"] input[value="${value}"]`,
        )!
        .click(),
    )
  try {
    await act(async () =>
      root.render(
        createElement(
          SettingsSubpageFrame,
          { header: null },
          createElement(CustomInstructions, {
            api,
            eager: true,
            permission: async () => true,
            onRunConfiguration: () => opened++,
          }),
        ),
      ),
    )
    expect(field('personaPrefix')?.getAttribute('placeholder')).toContain('What should Agnes Harness do?')
    // Nothing to press: there is no save button and no 「saved」 line.
    expect(host.querySelector('[data-testid="system-prompt-save"]')).toBeNull()
    await input('personaPrefix', 'lead with the conclusion')
    await blur('personaPrefix')
    expect(writes.at(-1)).toEqual({
      config: { personaPrefix: 'lead with the conclusion' },
      confirmFullOverride: false,
      expectedRevision: '0'.repeat(64),
    })
    await choose('concise')
    expect(writes.at(-1)?.config).toEqual({
      personaPrefix: 'lead with the conclusion',
      replyStyle: 'Concise: lead with the answer and keep it short.',
    })
    // 自定义 opens one field; what is typed there is the reply style.
    expect(field('replyStyle')).toBeNull()
    await choose('custom')
    await input('replyStyle', 'brief, plain words')
    await blur('replyStyle')
    expect(writes.at(-1)?.config.replyStyle).toBe('brief, plain words')
    await choose('default')
    expect(writes.at(-1)?.config).toEqual({ personaPrefix: 'lead with the conclusion' })
    // The closing instruction opens in place.
    expect(field('personaSuffix')).toBeNull()
    const closing = host.querySelector<HTMLButtonElement>(
      '[data-testid="custom-instructions-closing-toggle"]',
    )
    expect(closing?.textContent).toContain('Not set')
    await act(async () => closing?.click())
    expect(field('personaSuffix')).not.toBeNull()
    await input('personaSuffix', 'list the next steps')
    await blur('personaSuffix')
    expect(writes.at(-1)?.config).toEqual({
      personaPrefix: 'lead with the conclusion',
      personaSuffix: 'list the next steps',
    })
    expect(host.textContent).not.toMatch(/Saved/)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
  const replaced = fixture({ fullOverride: 'whole prompt', personaSuffix: 'sign off' })
  try {
    await act(async () =>
      replaced.root.render(
        createElement(
          SettingsSubpageFrame,
          { header: null },
          createElement(CustomInstructions, {
            api: replaced.api,
            eager: true,
            permission: async () => true,
            onRunConfiguration: () => opened++,
          }),
        ),
      ),
    )
    expect(replaced.field('personaPrefix')?.disabled).toBe(true)
    // A closing instruction saved earlier is shown on its row.
    expect(replaced.host.querySelector('[data-testid="custom-instructions-closing"]')?.textContent).toContain(
      'sign off',
    )
    expect(replaced.host.textContent).toContain('full replacement prompt is in use')
    await act(async () =>
      replaced.host
        .querySelector<HTMLButtonElement>('[data-testid="custom-instructions-run-config"]')
        ?.click(),
    )
    expect(opened).toBe(1)
  } finally {
    await act(async () => replaced.root.unmount())
    replaced.host.remove()
  }
})

it('reads a saved reply style back as its choice', () => {
  expect(replyStyleChoice(undefined)).toBe('default')
  expect(replyStyleChoice('简洁：先给结论，少铺垫。')).toBe('concise')
  expect(replyStyleChoice('Detailed: explain the reasoning and evidence, step by step.')).toBe('detailed')
  expect(replyStyleChoice('pirate voice')).toBe('custom')
})

it('reads nothing while the General page is not on screen', async () => {
  let reads = 0
  const api = systemPromptApi(async () => {
    reads++
    return Response.json({})
  })
  // The pane is hidden, as it is until the reader opens the General page.
  const pane = document.createElement('section')
  pane.hidden = true
  const host = pane.appendChild(document.createElement('div'))
  document.body.append(pane)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(createElement(CustomInstructions, { api, permission: async () => true })),
    )
    expect(reads).toBe(0)
    await act(async () => {
      pane.hidden = false
      await Promise.resolve()
    })
    expect(reads).toBe(1)
  } finally {
    await act(async () => root.unmount())
    pane.remove()
  }
})

it('groups the instructions and memory as 个性化, reading memory only once the General page is shown', async () => {
  const contextReads = vi.fn(async () => Response.json({ workspaces: [] }))
  vi.stubGlobal('fetch', contextReads)
  const api = systemPromptApi(async () =>
    Response.json({
      config: {},
      effect: 'new-sessions',
      hash: 'a'.repeat(64),
      preview: 'default-sections',
      sections: [],
    }),
  )
  const pane = document.createElement('section')
  pane.hidden = true
  const host = pane.appendChild(document.createElement('div'))
  document.body.append(pane)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(Personalization, { api, permission: async () => true })))
    const group = host.querySelector('[data-testid="settings-personalization"]')
    expect(group?.id).toBe('settings-subsection-personalization')
    expect(group?.querySelector('h3')?.textContent).toBe('Personalization')
    expect(group?.querySelector('[data-testid="custom-instructions"] textarea')).not.toBeNull()
    // Both links into the group have a target: the instructions and the memory beneath them.
    expect(
      group?.querySelector('#settings-subsection-custom-instructions [data-testid="custom-instructions"]'),
    ).not.toBeNull()
    expect(
      group?.querySelector('#settings-subsection-memory[data-testid="personalization-memory"]'),
    ).not.toBeNull()
    expect(host.querySelector('[data-testid="memory-panel"]')).toBeNull()
    expect(contextReads).not.toHaveBeenCalled()
    await act(async () => {
      pane.hidden = false
      await Promise.resolve()
    })
    expect(host.querySelector('[data-testid="memory-panel"]')).not.toBeNull()
    expect(contextReads).toHaveBeenCalledWith('/api/context', expect.objectContaining({ method: 'POST' }))
  } finally {
    await act(async () => root.unmount())
    pane.remove()
    vi.unstubAllGlobals()
  }
})

const inFrame = (element: ReturnType<typeof createElement>) =>
  createElement(SettingsSubpageFrame, { header: null }, element)

it('replaces the default prompt only after 「我已理解」 and 「应用替换」, keeps other instructions, and can go back', async () => {
  const { api, host, root, writes, input, button, click } = fixture({ replyStyle: 'brief' })
  const open = async (target: HTMLElement) => {
    await act(async () =>
      target.querySelector<HTMLButtonElement>('[data-testid="settings-drill-system-prompt"]')?.click(),
    )
    await act(async () =>
      target.querySelector<HTMLButtonElement>('[data-testid="system-prompt-override-on"]')?.click(),
    )
  }
  try {
    await act(async () => root.render(inFrame(createElement(PromptRows, { canSave: true, api }))))
    expect(host.querySelector('[data-testid="settings-drill-system-prompt"]')?.textContent).toContain(
      'Not used',
    )
    await open(host)
    expect(button('override-save')?.disabled).toBe(true)
    expect(button('override-reset')).toBeNull()
    await input('fullOverride', 'override')
    // Custom instructions are set: they would not be sent, and the banner offers to clear them.
    expect(host.textContent).toContain('not sent while a replacement is used')
    expect(host.querySelector('[data-testid="system-prompt-clear-instructions"]')).not.toBeNull()
    await click('confirm')
    expect(button('override-save')?.disabled).toBe(true)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
  const clean = fixture()
  try {
    await act(async () =>
      clean.root.render(inFrame(createElement(PromptRows, { canSave: true, api: clean.api }))),
    )
    await open(clean.host)
    await clean.input('fullOverride', 'override')
    expect(clean.button('override-save')?.disabled).toBe(true)
    await clean.click('confirm')
    await clean.click('override-save')
    expect(clean.writes.at(-1)).toEqual({
      config: { fullOverride: 'override' },
      confirmFullOverride: true,
      expectedRevision: '0'.repeat(64),
    })
    expect(clean.host.querySelector('[data-testid="settings-drill-system-prompt"]')?.textContent).toContain(
      'In use',
    )
    await clean.click('override-reset')
    expect(clean.writes.at(-1)).toEqual({
      config: {},
      confirmFullOverride: false,
      expectedRevision: '1'.padStart(64, '0'),
    })
    expect(clean.button('override-reset')).toBeNull()
  } finally {
    await act(async () => clean.root.unmount())
    clean.host.remove()
  }
  expect(writes).toHaveLength(0)
})

it('previews each prompt section as a row that expands in place, with copy for one section or all', async () => {
  const { api, host, root } = fixture()
  try {
    await act(async () => root.render(inFrame(createElement(PromptRows, { canSave: true, api }))))
    const drill = host.querySelector<HTMLButtonElement>('[data-testid="settings-drill-prompt-preview"]')
    expect(drill?.textContent).toContain('1 sections')
    await act(async () => drill?.click())
    const source = host.querySelector('[data-testid="system-prompt-source"]')
    expect(source?.getAttribute('title')).toContain('plugin/persona.md')
    expect(host.querySelector('[data-testid="system-prompt-copy-all"]')).not.toBeNull()
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="system-prompt-section-toggle"]')?.click(),
    )
    expect(host.querySelector('.system-prompt-section')?.textContent).toBe('default')
    expect(host.querySelector('.agnes-settings-code button')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

it('shares one prompt configuration: a replacement saved in run configuration locks the instructions, and a stale edit never erases it', async () => {
  let stored: SystemPromptSnapshot['config'] = {}
  const posts: { config: SystemPromptSnapshot['config']; confirmFullOverride: boolean }[] = []
  const snapshot = () => ({
    config: stored,
    effect: 'new-sessions' as const,
    hash: 'a'.repeat(64),
    revision: 'b'.repeat(64),
    preview: 'default-sections' as const,
    sections: [],
  })
  const api = systemPromptApi(async (_url, init) => {
    if (init?.method) {
      const input = JSON.parse(String(init.body))
      posts.push(input)
      stored = input.config
    }
    return Response.json(snapshot())
  })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const field = (name: string) =>
    host.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-testid="system-prompt-${name}"]`)
  try {
    await act(async () =>
      root.render(
        createElement(
          SettingsSubpageFrame,
          { header: null },
          createElement(CustomInstructions, { api, eager: true, permission: async () => true }),
          createElement(PromptRows, { canSave: true, api }),
        ),
      ),
    )
    expect(field('personaPrefix')?.disabled).toBe(false)
    // Replace the prompt in the run configuration.
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="settings-drill-system-prompt"]')?.click(),
    )
    await act(async () =>
      host.querySelector<HTMLElement>('[data-testid="system-prompt-override-on"]')?.click(),
    )
    await act(async () => {
      const node = field('fullOverride') as HTMLTextAreaElement
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(node, 'whole prompt')
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      host.querySelector<HTMLInputElement>('[data-testid="system-prompt-confirm"]')?.click(),
    )
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="system-prompt-override-save"]')?.click(),
    )
    expect(stored).toEqual({ fullOverride: 'whole prompt' })
    // The General page's group sees it at once: read-only, with the way to the run configuration.
    expect(field('personaPrefix')?.disabled).toBe(true)
    expect(host.textContent).toContain('full replacement prompt is in use')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }

  // Another window saved a replacement after this page read the configuration.
  stored = { replyStyle: 'brief' }
  const stale = document.body.appendChild(document.createElement('div'))
  const staleRoot = createRoot(stale)
  const staleApi = systemPromptApi(async (_url, init) => {
    if (init?.method) {
      const input = JSON.parse(String(init.body))
      posts.push(input)
      stored = input.config
    }
    return Response.json(snapshot())
  })
  try {
    await act(async () =>
      staleRoot.render(
        createElement(
          SettingsSubpageFrame,
          { header: null },
          createElement(CustomInstructions, { api: staleApi, eager: true, permission: async () => true }),
        ),
      ),
    )
    stored = { fullOverride: 'from another window' }
    const before = posts.length
    const prefix = stale.querySelector<HTMLTextAreaElement>('[data-testid="system-prompt-personaPrefix"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        prefix,
        'lead with it',
      )
      prefix.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => prefix.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await act(async () => {})
    // The save read the latest configuration first and refused: nothing was written, the
    // replacement stands, the draft is kept and the failure is told.
    expect(posts.length).toBe(before)
    expect(stored).toEqual({ fullOverride: 'from another window' })
    expect(prefix.value).toBe('lead with it')
    expect(stale.querySelector('[data-testid="settings-save-failed"]')).not.toBeNull()
    expect(stale.textContent).toContain('full replacement prompt is in use')
  } finally {
    await act(async () => staleRoot.unmount())
    stale.remove()
  }
})

it.each([
  ['en', 'instructions'],
  ['zh-CN', 'instructions'],
  ['en', 'replacement'],
  ['zh-CN', 'replacement'],
] as const)(
  'keeps the %s %s draft and exposes a GET/POST conflict until reload and resubmit',
  async (locale: UiLocale, editor) => {
    const f = fixture()
    const source = {
      getSnapshot: () => locale,
      getVersion: () => 0,
      subscribe: () => () => {},
      t: (key: string) => key,
      bind: () => (key: string) => key,
    }
    const instructions = editor === 'instructions'
    const name = instructions ? 'personaPrefix' : 'fullOverride'
    const draft = instructions ? 'window A instructions' : 'window A replacement'
    try {
      await act(async () =>
        f.root.render(
          createElement(
            UiLocaleProvider,
            { source },
            inFrame(
              instructions
                ? createElement(CustomInstructions, { api: f.api, eager: true, permission: async () => true })
                : createElement(PromptRows, { api: f.api, canSave: true }),
            ),
          ),
        ),
      )
      if (!instructions) {
        await act(async () =>
          f.host.querySelector<HTMLButtonElement>('[data-testid="settings-drill-system-prompt"]')?.click(),
        )
        await f.click('override-on')
      }
      await f.input(name, draft)
      // Window B commits after A's save-flow GET, immediately before A's POST reaches the store.
      f.beforeSave(async () => {
        const latest = await f.otherWindow.get()
        if (!latest.revision) throw new Error('Missing fixture revision')
        await f.otherWindow.save({
          config: { fullOverride: 'window B replacement' },
          confirmFullOverride: true,
          expectedRevision: latest.revision,
        })
      })
      if (instructions) {
        await act(async () => f.field(name)?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
      } else {
        await f.click('confirm')
        await f.click('override-save')
      }
      await act(async () => {})
      expect(f.writes.at(-1)?.expectedRevision).toBe('0'.repeat(64))
      expect(f.saved().config).toEqual({ fullOverride: 'window B replacement' })
      expect(f.field(name)?.value).toBe(draft)
      const notice = f.host.querySelector('[data-testid="system-prompt-conflict"]')
      expect(notice?.textContent).toContain(locale === 'en' ? 'Changed in another window' : '另一窗口已修改')
      expect(f.host.querySelector('[data-testid="system-prompt-conflict-saved"]')?.textContent).toContain(
        'window B replacement',
      )
      expect(notice?.getAttribute('role')).toBe('alert')
      if (instructions) {
        expect(f.field(name)?.disabled).toBe(true)
        // Instructions cannot clear a replacement. B must explicitly restore the default first.
        const latest = await f.otherWindow.get()
        if (!latest.revision) throw new Error('Missing fixture revision')
        await f.otherWindow.save({ config: {}, expectedRevision: latest.revision })
      }
      const revision = f.saved().revision
      await f.click('conflict-reload')
      expect(f.field(name)?.value).toBe(draft)
      if (instructions) {
        expect(f.field(name)?.disabled).toBe(false)
        await act(async () =>
          f.host.querySelector<HTMLButtonElement>('[data-testid="settings-save-retry"]')?.click(),
        )
      } else {
        await f.click('confirm')
        await f.click('override-save')
      }
      expect(f.writes.at(-1)?.expectedRevision).toBe(revision)
      expect(f.saved().config).toEqual(instructions ? { personaPrefix: draft } : { fullOverride: draft })
      expect(f.host.querySelector('[data-testid="system-prompt-conflict"]')).toBeNull()
      expect(f.host.querySelector('[data-testid="settings-save-failed"]')).toBeNull()
      expect(f.host.textContent).not.toMatch(/Saved successfully|保存成功/)
    } finally {
      await act(async () => f.root.unmount())
      f.host.remove()
    }
  },
)

it.each([true, false])(
  'keeps newer prompt reads and refuses an unconditional save (revision=%s)',
  async (hasRevision) => {
    const { usePromptSnapshot } = await import('../src/settings/prompt-config.js')
    let release!: (value: SystemPromptSnapshot) => void
    const old: SystemPromptSnapshot = {
      config: { replyStyle: 'old' },
      effect: 'new-sessions',
      hash: 'a'.repeat(64),
      ...(hasRevision ? { revision: 'b'.repeat(64) } : {}),
      preview: 'default-sections',
      sections: [],
    }
    let reads = 0
    const api: ReturnType<typeof systemPromptApi> = {
      session: async () => old,
      get: async () =>
        ++reads === 1
          ? new Promise<SystemPromptSnapshot>((resolve) => {
              release = resolve
            })
          : old,
      save: vi.fn(async ({ config }: SystemPromptSaveParams) => ({ ...old, config })),
    }
    let save!: ReturnType<typeof usePromptSnapshot>['save']
    function Reader() {
      const state = usePromptSnapshot(api)
      save = state.save
      return createElement('output', null, state.snapshot?.config.replyStyle)
    }
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    try {
      await act(async () => root.render(createElement(Reader)))
      await act(async () => {
        const saving = save((latest) => ({ ...latest, replyStyle: 'saved' }))
        if (hasRevision) await saving
        else await expect(saving).rejects.toThrow('Prompt revision unavailable')
      })
      expect(host.textContent).toBe(hasRevision ? 'saved' : 'old')
      if (!hasRevision) expect(api.save).not.toHaveBeenCalled()
      await act(async () => release(old))
      expect(host.textContent).toBe(hasRevision ? 'saved' : 'old')
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  },
)
