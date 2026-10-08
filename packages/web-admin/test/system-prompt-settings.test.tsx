/** @vitest-environment happy-dom */
import type { SystemPromptSnapshot } from '@agnes/protocol'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { SystemPromptPanel } from '../src/settings/system-prompt.js'
import { systemPromptApi } from '../src/settings/system-prompt-api.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('renders source labels, saves bounded instructions, requires override confirmation and resets defaults', async () => {
  let snapshot: SystemPromptSnapshot = {
    config: {},
    effect: 'new-sessions',
    hash: 'a'.repeat(64),
    preview: 'default-sections',
    sections: [{ id: 'persona', order: 1, source: 'plugin/persona.md', text: 'default' }],
  }
  const writes: unknown[] = []
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
  const input = async (name: string, text: string) =>
    act(async () => {
      const field = host.querySelector<HTMLTextAreaElement>(`[data-testid="system-prompt-${name}"]`)!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, text)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  const click = async (name: string) =>
    act(async () => host.querySelector<HTMLButtonElement>(`[data-testid="system-prompt-${name}"]`)!.click())
  try {
    await act(async () => root.render(createElement(SystemPromptPanel, { canSave: true, api })))
    expect(host.textContent).toContain('plugin/persona.md')
    expect(host.textContent).toContain('Existing sessions keep')
    await input('personaPrefix', 'new persona')
    await click('save')
    expect(writes.at(-1)).toMatchObject({ config: { personaPrefix: 'new persona' } })
    await input('fullOverride', 'override')
    expect(host.querySelector<HTMLButtonElement>('[data-testid="system-prompt-save"]')!.disabled).toBe(true)
    await click('confirm')
    expect(host.querySelector<HTMLButtonElement>('[data-testid="system-prompt-save"]')!.disabled).toBe(true)
    expect(host.textContent).toContain('conflicts with opening')
    await input('personaPrefix', '')
    await click('save')
    expect(writes.at(-1)).toMatchObject({ config: { fullOverride: 'override' }, confirmFullOverride: true })
    await click('reset')
    expect(writes.at(-1)).toMatchObject({ config: {} })
    expect(
      host.querySelector<HTMLTextAreaElement>('[data-testid="system-prompt-personaPrefix"]')!.value,
    ).toBe('')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
