/** @vitest-environment happy-dom */
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  formatTokens,
  joinList,
  minutePresets,
  parseTokens,
  presetChoice,
  SettingsBlock,
  SettingsChips,
  SettingsChipToggle,
  SettingsDrill,
  SettingsExpand,
  SettingsItem,
  SettingsPage,
  SettingsPresetSelect,
  secondPresets,
  splitList,
  useAutosave,
} from '../src/index.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await act(async () => cleanup())
  document.body.replaceChildren()
  history.replaceState(null, '', '/')
  vi.useRealTimers()
})
async function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(element))
  cleanups.push(() => root.unmount())
  return host
}
const $ = <T extends Element = HTMLElement>(host: ParentNode, selector: string) => {
  const node = host.querySelector<T & Element>(selector)
  if (!node) throw new Error(`missing ${selector}`)
  return node as unknown as T
}

it('drills into a subpage, nested subpages, and returns with 返回 and the browser back button', async () => {
  const host = await render(
    createElement(
      SettingsPage,
      { title: 'Diagnostics', description: 'Checks' },
      createElement(SettingsItem, { label: 'Main row', 'data-testid': 'main-row' }),
      createElement(
        SettingsDrill,
        { id: 'otlp', label: 'OTLP export', value: 'Off', description: 'Send traces', actions: 'Save' },
        createElement('p', { 'data-testid': 'otlp-body' }, 'OTLP body'),
        createElement(
          SettingsDrill,
          { id: 'otlp-limits', label: 'Limits' },
          createElement('p', { 'data-testid': 'limits-body' }, 'Limits body'),
        ),
      ),
    ),
  )
  const drill = $<HTMLButtonElement>(host, '[data-testid="settings-drill-otlp"]')
  expect(drill.id).toBe('settings-subsection-otlp')
  expect(drill.textContent).toContain('Off')
  expect(host.querySelector('[data-testid="otlp-body"]')).toBeNull()
  await act(async () => drill.click())
  // The subpage takes the header and the body; the page body stays mounted, hidden.
  const header = $(host, '[data-testid="settings-subpage-header"]')
  expect(header.querySelector('h2')?.textContent).toBe('OTLP export')
  expect(header.textContent).toContain('Send traces')
  expect(header.textContent).toContain('Save')
  expect($(host, '[data-testid="otlp-body"]').closest('[hidden]')).toBeNull()
  expect($(host, '[data-testid="main-row"]').closest('[hidden]')).not.toBeNull()
  expect(history.state).toMatchObject({ agnesSettingsSubpage: 1 })
  await act(async () => $<HTMLButtonElement>(host, '[data-testid="settings-drill-otlp-limits"]').click())
  expect($(host, '[data-testid="settings-subpage-header"] h2').textContent).toBe('Limits')
  expect($(host, '[data-testid="otlp-body"]').closest('[hidden]')).not.toBeNull()
  expect(history.state).toMatchObject({ agnesSettingsSubpage: 2 })
  // The browser's back button returns one level.
  await act(async () => {
    history.replaceState({ agnesSettingsSubpage: 1 }, '')
    window.dispatchEvent(new PopStateEvent('popstate', { state: { agnesSettingsSubpage: 1 } }))
  })
  expect($(host, '[data-testid="settings-subpage-header"] h2').textContent).toBe('OTLP export')
  // 返回 goes back through history when the entry is ours.
  const back = vi
    .spyOn(history, 'back')
    .mockImplementation(() =>
      window.dispatchEvent(new PopStateEvent('popstate', { state: { agnesSettingsSubpage: 0 } })),
    )
  await act(async () => $<HTMLButtonElement>(host, '[data-testid="settings-subpage-back"]').click())
  expect(back).toHaveBeenCalledOnce()
  expect(host.querySelector('[data-testid="settings-subpage-header"]')?.closest('[hidden]')).not.toBeNull()
  expect($(host, '[data-testid="main-row"]').closest('[hidden]')).toBeNull()
  expect(host.querySelector('[data-testid="otlp-body"]')).toBeNull()
})

it('opens a subpage from its deep-link anchor and expands rows in place', async () => {
  const host = await render(
    createElement(
      SettingsPage,
      { title: 'Security' },
      createElement(
        SettingsDrill,
        { id: 'review', label: 'Review rules' },
        createElement('p', null, 'Rules'),
      ),
      createElement(
        SettingsExpand,
        { label: 'Denied', value: 'E_POLICY', 'data-testid': 'error-1' },
        createElement('p', { 'data-testid': 'error-1-body' }, 'Details'),
      ),
    ),
  )
  // web-units' revealSettingsAnchor clicks a drill row it is pointed at.
  const anchor = document.getElementById('settings-subsection-review')
  expect(anchor?.dataset.settingsDrill).toBe('review')
  await act(async () => anchor?.click())
  expect($(host, '[data-testid="settings-subpage-header"] h2').textContent).toBe('Review rules')
  expect(host.querySelector('[data-testid="error-1-body"]')).toBeNull()
  await act(async () => $<HTMLButtonElement>(host, '[data-testid="error-1-toggle"]').click())
  expect($(host, '[data-testid="error-1-body"]').textContent).toBe('Details')
  expect($(host, '[data-testid="error-1-toggle"]').getAttribute('aria-expanded')).toBe('true')
})

function AutosaveField({ save, stored }: { save(value: string): Promise<unknown>; stored: string }) {
  const field = useAutosave({ stored, save })
  return createElement(
    SettingsBlock,
    { label: 'Personalization', failed: field.failed, onRetry: field.retry },
    createElement('textarea', {
      'data-testid': 'text',
      value: field.value ?? '',
      onChange: (event: { currentTarget: HTMLTextAreaElement }) =>
        field.set(event.currentTarget.value, 'idle'),
      onBlur: field.flush,
    }),
  )
}
function AutosaveSwitch({ save }: { save(value: boolean): Promise<unknown> }) {
  const [stored, setStored] = useState(false)
  const field = useAutosave({
    stored,
    save: async (value: boolean) => {
      await save(value)
      setStored(value)
    },
  })
  return createElement(
    SettingsBlock,
    { label: 'Rules', failed: field.failed, onRetry: field.retry },
    createElement('input', {
      type: 'checkbox',
      'data-testid': 'switch',
      checked: field.value ?? false,
      onChange: (event: { currentTarget: HTMLInputElement }) => field.set(event.currentTarget.checked),
    }),
  )
}
const type = (node: HTMLTextAreaElement, text: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(node, text)
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

it('saves text after a second of quiet or on blur, and shows only a failure with retry at the label', async () => {
  vi.useFakeTimers()
  const save = vi.fn(async (_value: string) => undefined)
  const host = await render(createElement(AutosaveField, { save, stored: '' }))
  const text = $<HTMLTextAreaElement>(host, '[data-testid="text"]')
  await act(async () => type(text, 'lead with'))
  await act(async () => type(text, 'lead with the conclusion'))
  expect(save).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTime(1000))
  expect(save).toHaveBeenCalledOnce()
  expect(save).toHaveBeenLastCalledWith('lead with the conclusion')
  // Nothing tells a successful save.
  expect(host.textContent).not.toMatch(/saved|已保存/i)
  save.mockRejectedValueOnce(new Error('offline'))
  await act(async () => type(text, 'brief'))
  await act(async () => text.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(save).toHaveBeenLastCalledWith('brief')
  expect($(host, '[data-testid="settings-save-failed"]').textContent).toMatch(/Couldn’t save|保存失败/)
  expect(text.value).toBe('brief')
  await act(async () => $<HTMLButtonElement>(host, '[data-testid="settings-save-retry"]').click())
  expect(save).toHaveBeenCalledTimes(3)
  expect(host.querySelector('[data-testid="settings-save-failed"]')).toBeNull()
})

it('saves a switch at once and ⌘Z outside a text field undoes the last saved change', async () => {
  const save = vi.fn(async (_value: boolean) => undefined)
  const host = await render(
    createElement(SettingsPage, { title: 'Security' }, createElement(AutosaveSwitch, { save })),
  )
  const toggle = $<HTMLInputElement>(host, '[data-testid="switch"]')
  await act(async () => toggle.click())
  expect(save).toHaveBeenLastCalledWith(true)
  expect(toggle.checked).toBe(true)
  await act(async () =>
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })),
  )
  expect(save).toHaveBeenLastCalledWith(false)
  expect(toggle.checked).toBe(false)
  // An undo is not itself undone by the next ⌘Z.
  await act(async () =>
    toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })),
  )
  expect(save).toHaveBeenCalledTimes(2)
})

it('shows a failed read as one line with retry and keeps what is shown', async () => {
  const reload = vi.fn()
  const host = await render(
    createElement(
      SettingsBlock,
      { label: 'Accounts', state: 'error', onReload: reload },
      createElement(SettingsItem, { label: 'Agnes AI', info: 'The account new sessions use' }),
    ),
  )
  expect($(host, '[data-testid="settings-read-failed"]').textContent).toMatch(/Couldn’t load|读取失败/)
  expect(host.textContent).toContain('Agnes AI')
  expect($(host, '.agnes-settings-info').getAttribute('title')).toBe('The account new sessions use')
  await act(async () => $<HTMLButtonElement>(host, '[data-testid="settings-read-failed"] button').click())
  expect(reload).toHaveBeenCalledOnce()
})

it('converts milliseconds to presets, lists to chips and token budgets to K and M', async () => {
  const seconds = secondPresets([5, 10, 30], (count) => `${count} s`)
  expect(seconds.map((preset) => preset.value)).toEqual([5000, 10_000, 30_000])
  expect(minutePresets([1, 10], (count) => `${count} min`).map((preset) => preset.value)).toEqual([
    60_000, 600_000,
  ])
  expect(presetChoice(undefined, seconds)).toBe('default')
  expect(presetChoice(10_000, seconds)).toBe('10000')
  expect(presetChoice(12_345, seconds)).toBe('custom')
  expect(splitList('shell, write,\nshell ，read')).toEqual(['shell', 'write', 'read'])
  expect(joinList(['shell', 'write'])).toBe('shell, write')
  expect(formatTokens(128_000)).toBe('128K')
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(parseTokens('100K')).toBe(100_000)
  expect(parseTokens('1.5m')).toBe(1_500_000)
  expect(parseTokens('200,000')).toBe(200_000)
  expect(parseTokens('lots')).toBeUndefined()

  const changes: (number | undefined)[] = []
  const host = await render(
    createElement(SettingsPresetSelect, {
      label: 'Timeout',
      value: 12_345,
      presets: seconds,
      unit: 's',
      scale: 1000,
      onChange: (next: number | undefined) => changes.push(next),
      'data-testid': 'timeout',
    }),
  )
  const select = $<HTMLSelectElement>(host, '[data-testid="timeout"]')
  // A value no preset names keeps its raw number under 自定义.
  expect(select.value).toBe('custom')
  expect($<HTMLInputElement>(host, '[data-testid="timeout-custom"]').value).toBe('12.345')
  await act(async () => {
    select.value = '30000'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {
    select.value = 'default'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(changes).toEqual([30_000, undefined])
})

it('edits a list as chips and toggles a fixed set', async () => {
  const lists: string[][] = []
  const kinds: string[][] = []
  const host = await render(
    createElement(
      'div',
      null,
      createElement(SettingsChips, {
        label: 'Tools',
        values: ['shell'],
        onChange: (next: string[]) => lists.push(next),
        'data-testid': 'tools',
      }),
      createElement(SettingsChipToggle, {
        label: 'Kinds',
        options: [
          { value: 'read', label: 'Read' },
          { value: 'write', label: 'Write' },
          { value: 'external', label: 'External' },
        ],
        values: ['write'],
        onChange: (next: string[]) => kinds.push(next),
        'data-testid': 'kinds',
      }),
    ),
  )
  const input = $<HTMLInputElement>(host, '[data-testid="tools"] input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'write')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await act(async () =>
    $<HTMLButtonElement>(host, '[data-testid="tools"] .agnes-settings-chip button').click(),
  )
  expect(lists).toEqual([['shell', 'write'], []])
  const [read] = host.querySelectorAll<HTMLButtonElement>('[data-testid="kinds"] button')
  await act(async () => read?.click())
  expect(kinds).toEqual([['read', 'write']])
})

it('lists accounts as rows: logo, default model and count, state tags, fix, and a menu that guards the default', async () => {
  const { SettingsAccounts } = await import('../src/index.js')
  const account = (accountId: string, label: string, extra: Record<string, unknown> = {}) => ({
    accountId,
    label,
    providerId: accountId,
    route: accountId,
    baseUrl: 'https://example.invalid',
    model: 'flash',
    models: [{ id: 'flash', name: 'Flash' }, { id: 'pro' }],
    enabled: true,
    credentialConfigured: true,
    ...extra,
  })
  const actions: string[] = []
  const edits: string[] = []
  const host = await render(
    createElement(SettingsAccounts, {
      accounts: [
        account('agnes', 'Agnes AI'),
        account('openai', 'OpenAI', { enabled: false }),
        account('kimi', 'Kimi', { credentialConfigured: false }),
      ] as never,
      defaultAccountId: 'agnes',
      disabled: false,
      onEdit: (id: string) => edits.push(id),
      onAction: (row: { accountId: string }, action: string) => actions.push(`${action}:${row.accountId}`),
      onCancelRemove: () => {},
    }),
  )
  const rows = [...host.querySelectorAll<HTMLElement>('.config-account')]
  expect(rows.map((row) => row.querySelector('.agnes-settings-logo')?.textContent)).toEqual(['A', 'O', 'K'])
  expect(rows[0]?.querySelector('.config-account-meta')?.textContent).toBe('Flash · 2 models')
  expect(rows[0]?.textContent).toContain('Default')
  expect(rows[1]?.dataset.enabled).toBe('false')
  expect(rows[1]?.textContent).toContain('Disabled')
  expect(rows[2]?.textContent).toContain('Credential missing')
  await act(async () =>
    [...(rows[2]?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Fix')?.click(),
  )
  expect(edits).toEqual(['kimi'])
  // The default account offers neither disable nor remove while another account could take over.
  await act(async () =>
    rows[0]?.querySelector<HTMLButtonElement>('button[aria-label="Actions for Agnes AI"]')?.click(),
  )
  const labels = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
  expect(labels()).toEqual(['Edit'])
})
