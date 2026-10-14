/** @vitest-environment happy-dom */
import type { SystemPromptSnapshot } from '@agnes/protocol'
import { SettingsSubpageFrame } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  CustomInstructions,
  Personalization,
  replyStyleChoice,
  SystemPromptPanel,
} from '../src/settings/system-prompt.js'
import { systemPromptApi } from '../src/settings/system-prompt-api.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function fixture(initial: SystemPromptSnapshot['config'] = {}) {
  let snapshot: SystemPromptSnapshot = {
    config: initial,
    effect: 'new-sessions',
    hash: 'a'.repeat(64),
    preview: 'default-sections',
    sections: [{ id: 'persona', order: 1, source: 'plugin/persona.md', text: 'default' }],
  }
  const writes: { config: SystemPromptSnapshot['config']; confirmFullOverride: boolean }[] = []
  const api = systemPromptApi(async (_url, init) => {
    if (init?.method) {
      const input = JSON.parse(String(init.body))
      writes.push(input)
      snapshot = { ...snapshot, config: input.config }
    }
    return Response.json(snapshot)
  })
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
  return { api, host, root, writes, field, input, button, click }
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
    // The closing instruction is a subpage of its own.
    expect(field('personaSuffix')).toBeNull()
    const closing = host.querySelector<HTMLButtonElement>('[data-testid="custom-instructions-closing"]')
    expect(closing?.textContent).toContain('Not set')
    await act(async () => closing?.click())
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

it('replaces the default prompt only after confirmation, keeps other instructions, and can go back', async () => {
  const { api, host, root, writes, input, button, click } = fixture({ replyStyle: 'brief' })
  try {
    await act(async () =>
      root.render(createElement(SystemPromptPanel, { canSave: true, api, part: 'override' })),
    )
    expect(button('override-save')?.disabled).toBe(true)
    expect(button('override-reset')).toBeNull()
    await input('fullOverride', 'override')
    // Custom instructions are set, so a full replacement conflicts until they are cleared.
    expect(host.textContent).toContain('Clear them before using a full replacement')
    await click('confirm')
    expect(button('override-save')?.disabled).toBe(true)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
  const clean = fixture()
  try {
    await act(async () =>
      clean.root.render(
        createElement(SystemPromptPanel, { canSave: true, api: clean.api, part: 'override' }),
      ),
    )
    await clean.input('fullOverride', 'override')
    expect(clean.button('override-save')?.disabled).toBe(true)
    await clean.click('confirm')
    await clean.click('override-save')
    expect(clean.writes.at(-1)).toEqual({ config: { fullOverride: 'override' }, confirmFullOverride: true })
    expect(clean.host.querySelector('[data-testid="system-prompt-override-saved"]')).not.toBeNull()
    await clean.click('override-reset')
    expect(clean.writes.at(-1)).toEqual({ config: {}, confirmFullOverride: false })
    expect(clean.button('override-reset')).toBeNull()
  } finally {
    await act(async () => clean.root.unmount())
    clean.host.remove()
  }
  expect(writes).toHaveLength(0)
})

it('previews each prompt section as a row whose text can be copied', async () => {
  const { api, host, root } = fixture()
  try {
    await act(async () =>
      root.render(createElement(SystemPromptPanel, { canSave: true, api, part: 'preview' })),
    )
    const source = host.querySelector('[data-testid="system-prompt-source"]')
    expect(source?.getAttribute('title')).toContain('plugin/persona.md')
    await act(async () => host.querySelector<HTMLElement>('.agh-disclosure-summary')?.click())
    expect(host.querySelector('.system-prompt-section')?.textContent).toBe('default')
    expect(host.querySelector('.agnes-settings-code button')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
