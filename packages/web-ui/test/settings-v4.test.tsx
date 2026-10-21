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
  SUBPAGE_CLOSE_EVENT,
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
    history.replaceState({ ...history.state, agnesSettingsSubpage: 1 }, '')
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
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
  expect($(host, '[data-testid="loadable-error"]').textContent).toMatch(/Couldn’t load|读取失败/)
  expect(host.textContent).toContain('Agnes AI')
  expect($(host, '.agnes-settings-info').getAttribute('aria-label')).toBe('The account new sessions use')
  expect($(host, '.agh-tooltip-anchor .agnes-settings-info')).toBeTruthy()
  expect($(host, '.agnes-settings-info').classList.contains('agh-touch-target')).toBe(true)
  await act(async () => $<HTMLButtonElement>(host, '[data-testid="loadable-retry"]').click())
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
  expect(rows[2]?.textContent).toContain('API key required')
  await act(async () =>
    [...(rows[2]?.querySelectorAll('button') ?? [])]
      .find((b) => b.textContent === 'Re-enter API key')
      ?.click(),
  )
  expect(edits).toEqual(['kimi'])
  // The default account offers neither disable nor remove while another account could take over.
  await act(async () =>
    rows[0]?.querySelector<HTMLButtonElement>('button[aria-label="Actions for Agnes AI"]')?.click(),
  )
  const labels = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
  expect(labels()).toEqual(['Edit'])
})

/** A whole-object setting whose saves settle only when the test says so. */
function deferredSaves() {
  const calls: { value: string; resolve(): void; reject(): void }[] = []
  const save = (value: string) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ value, resolve, reject: () => reject(new Error('offline')) })
    })
  return { calls, save }
}
function AutosaveChoice({
  save,
  resourceKey,
}: {
  save(value: string): Promise<void>
  resourceKey?: string | undefined
}) {
  const [stored, setStored] = useState('off')
  const field = useAutosave({
    resourceKey,
    stored,
    save: async (value: string) => {
      await save(value)
      // Like the real settings: the server's answer becomes the stored value.
      setStored(value)
    },
  })
  return createElement(
    SettingsBlock,
    { label: 'Review', failed: field.failed, onRetry: field.retry },
    createElement('output', { 'data-testid': 'shown' }, field.value),
    createElement('output', { 'data-testid': 'stored' }, stored),
    ...['on', 'off', 'strict'].map((option) =>
      createElement('button', {
        key: option,
        type: 'button',
        'data-testid': `pick-${option}`,
        onClick: () => field.set(option),
      }),
    ),
  )
}

it.each([undefined, 'settings:coalescing'])(
  'sends one save at a time and then only the newest edit, so an older save never lands last (%s)',
  async (resourceKey) => {
    const { calls, save } = deferredSaves()
    const host = await render(createElement(AutosaveChoice, { save, resourceKey }))
    const pick = (option: string) =>
      act(async () => $<HTMLButtonElement>(host, `[data-testid="pick-${option}"]`).click())
    const shown = () => $(host, '[data-testid="shown"]').textContent
    await pick('on')
    await pick('strict')
    for (let edit = 0; edit < 17; edit++) await pick(edit % 2 === 0 ? 'on' : 'strict')
    await pick('off')
    // The second and third edits wait for the first save; nothing else is in flight.
    expect(calls.map((call) => call.value)).toEqual(['on'])
    expect(shown()).toBe('off')
    await act(async () => calls[0]!.resolve())
    // The first save's answer is stored, but the newest edit stays on screen and is sent next.
    expect($(host, '[data-testid="stored"]').textContent).toBe('on')
    expect(shown()).toBe('off')
    expect(calls.map((call) => call.value)).toEqual(['on', 'off'])
    await act(async () => calls[1]!.resolve())
    expect($(host, '[data-testid="stored"]').textContent).toBe('off')
    expect(shown()).toBe('off')
    expect(calls).toHaveLength(2)
    expect(host.querySelector('[data-testid="settings-save-failed"]')).toBeNull()
  },
)

it.each([undefined, 'settings:coalescing-failure'])(
  'lets a newer edit supersede an older failed save and keeps the newest failed edit for retry (%s)',
  async (resourceKey) => {
    const { calls, save } = deferredSaves()
    const host = await render(createElement(AutosaveChoice, { save, resourceKey }))
    const pick = (option: string) =>
      act(async () => $<HTMLButtonElement>(host, `[data-testid="pick-${option}"]`).click())
    const shown = () => $(host, '[data-testid="shown"]').textContent
    const failed = () => host.querySelector('[data-testid="settings-save-failed"]')
    await pick('on')
    for (let edit = 0; edit < 18; edit++) await pick(edit % 2 === 0 ? 'off' : 'on')
    await pick('strict')
    // The older save fails while a newer edit waits: the newer one is sent, no failure is shown.
    await act(async () => calls[0]!.reject())
    expect(failed()).toBeNull()
    expect(calls.map((call) => call.value)).toEqual(['on', 'strict'])
    // The newest save fails with nothing behind it: its edit stays shown and retry sends it again.
    await act(async () => calls[1]!.reject())
    expect(failed()).not.toBeNull()
    expect(shown()).toBe('strict')
    expect($(host, '[data-testid="stored"]').textContent).toBe('off')
    await act(async () => $<HTMLButtonElement>(host, '[data-testid="settings-save-retry"]').click())
    expect(calls.map((call) => call.value)).toEqual(['on', 'strict', 'strict'])
    await act(async () => calls[2]!.resolve())
    expect(failed()).toBeNull()
    expect($(host, '[data-testid="stored"]').textContent).toBe('strict')
  },
)

it('does not let an older success clear the failure of the newest edit', async () => {
  const { calls, save } = deferredSaves()
  const host = await render(createElement(AutosaveChoice, { save }))
  const pick = (option: string) =>
    act(async () => $<HTMLButtonElement>(host, `[data-testid="pick-${option}"]`).click())
  await pick('on')
  await act(async () => calls[0]!.reject())
  expect(host.querySelector('[data-testid="settings-save-failed"]')).not.toBeNull()
  await pick('strict')
  await pick('off')
  await act(async () => calls[1]!.resolve())
  // `strict` saved; `off` is now on its way and decides the outcome.
  expect(calls.map((call) => call.value)).toEqual(['on', 'strict', 'off'])
  await act(async () => calls[2]!.reject())
  expect(host.querySelector('[data-testid="settings-save-failed"]')).not.toBeNull()
  expect($(host, '[data-testid="shown"]').textContent).toBe('off')
})

it('closes a finished subpage at once, so a page opened right after stays open', async () => {
  const { SUBPAGE_CLOSE_EVENT } = await import('../src/index.js')
  const host = await render(
    createElement(
      SettingsPage,
      { title: 'Models' },
      createElement(
        SettingsDrill,
        { id: 'account', label: 'Account' },
        createElement('p', { 'data-testid': 'account-body' }, 'Form'),
      ),
      createElement(
        SettingsDrill,
        { id: 'add-account', label: 'Add account' },
        createElement('p', { 'data-testid': 'add-body' }, 'Form'),
      ),
    ),
  )
  await act(async () => $<HTMLButtonElement>(host, '[data-testid="settings-drill-account"]').click())
  expect(history.state).toMatchObject({ agnesSettingsSubpage: 1 })
  // A saved form closes its page itself and another page opens in the same tick.
  await act(async () => {
    $(host, '[data-testid="account-body"]').dispatchEvent(
      new CustomEvent(SUBPAGE_CLOSE_EVENT, { bubbles: true }),
    )
    $<HTMLButtonElement>(host, '[data-testid="settings-drill-add-account"]').click()
  })
  expect(host.querySelector('[data-testid="account-body"]')).toBeNull()
  expect(host.querySelector('[data-testid="add-body"]')).not.toBeNull()
  // A late popstate for the closed level does not take the new page away.
  await act(async () => window.dispatchEvent(new PopStateEvent('popstate', { state: history.state })))
  expect(host.querySelector('[data-testid="add-body"]')).not.toBeNull()
})

it('reads a settings group the shared way: nothing for 200 ms, then a placeholder, never a loading line', async () => {
  vi.useFakeTimers()
  const host = await render(createElement(SettingsBlock, { label: 'Memory', state: 'loading' }))
  expect(host.querySelector('[data-testid="loadable-placeholder"]')).toBeNull()
  await act(async () => vi.advanceTimersByTime(200))
  expect(host.querySelector('[data-testid="loadable-placeholder"]')).not.toBeNull()
  // The words stay for assistive tech until the read is slow.
  expect(host.querySelector('.agh-loadable-status')?.getAttribute('data-slow')).toBeNull()
  await act(async () => vi.advanceTimersByTime(2800))
  expect(host.querySelector('.agh-loadable-status')?.getAttribute('data-slow')).toBe('true')
})

it('serializes saves across two mounted surfaces and a remount of the same resource', async () => {
  const { calls, save } = deferredSaves()
  const first = await render(createElement(AutosaveChoice, { save, resourceKey: 'settings:shared' }))
  const second = await render(createElement(AutosaveChoice, { save, resourceKey: 'settings:shared' }))
  await act(async () => $<HTMLButtonElement>(first, '[data-testid="pick-on"]').click())
  await act(async () => $<HTMLButtonElement>(first, '[data-testid="pick-off"]').click())
  await act(async () => $<HTMLButtonElement>(second, '[data-testid="pick-strict"]').click())
  expect(calls.map((call) => call.value)).toEqual(['on'])
  await act(async () => cleanups.shift()?.())
  const again = await render(createElement(AutosaveChoice, { save, resourceKey: 'settings:shared' }))
  await act(async () => $<HTMLButtonElement>(again, '[data-testid="pick-off"]').click())
  await act(async () => calls[0]!.resolve())
  expect(calls.map((call) => call.value)).toEqual(['on', 'off'])
  await act(async () => calls[1]!.resolve())
  expect(calls.map((call) => call.value)).toEqual(['on', 'off', 'strict'])
  await act(async () => calls[2]!.resolve())
  expect(calls.map((call) => call.value)).toEqual(['on', 'off', 'strict', 'off'])
  await act(async () => calls[3]!.resolve())
  // Updating a waiting editor after another editor has queued must keep the latest intent last.
  await act(async () => $<HTMLButtonElement>(second, '[data-testid="pick-on"]').click())
  await act(async () => $<HTMLButtonElement>(again, '[data-testid="pick-on"]').click())
  await act(async () => $<HTMLButtonElement>(second, '[data-testid="pick-off"]').click())
  await act(async () => $<HTMLButtonElement>(again, '[data-testid="pick-strict"]').click())
  await act(async () => calls[4]!.resolve())
  expect(calls.map((call) => call.value)).toEqual(['on', 'off', 'strict', 'off', 'on', 'off'])
  await act(async () => calls[5]!.resolve())
  expect(calls.map((call) => call.value)).toEqual(['on', 'off', 'strict', 'off', 'on', 'off', 'strict'])
  await act(async () => calls[6]!.resolve())
})

it('restores nested settings pages from a deep link, reload, back and forward', async () => {
  const page = () =>
    createElement(
      SettingsPage,
      { title: 'Diagnostics', routeId: 'diagnostics' },
      createElement(
        SettingsDrill,
        { id: 'otlp', label: 'OTLP' },
        createElement(
          SettingsDrill,
          { id: 'limits', label: 'Limits' },
          createElement('p', null, 'Limit controls'),
        ),
      ),
    )
  history.replaceState(null, '', '/?session=s1&settings=diagnostics/otlp/limits')
  const first = await render(page())
  expect($(first, '[data-testid="settings-subpage-header"] h2').textContent).toBe('Limits')
  await act(async () => cleanups.shift()?.())
  const reloaded = await render(page())
  expect($(reloaded, '[data-testid="settings-subpage-header"] h2').textContent).toBe('Limits')
  for (const [address, title] of [
    ['diagnostics/otlp', 'OTLP'],
    ['diagnostics/otlp/limits', 'Limits'],
  ]) {
    await act(async () => {
      history.replaceState(null, '', `/?session=s1&settings=${address}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect($(reloaded, '[data-testid="settings-subpage-header"] h2').textContent).toBe(title)
  }
  await act(async () => $(reloaded, '[data-testid="settings-subpage-back"]').click())
  expect(new URL(location.href).searchParams.get('settings')).toBe('diagnostics/otlp')
  expect(new URL(location.href).searchParams.get('session')).toBe('s1')
  // A linked page has no history depth owned by this frame. Completing it must still commit
  // its parent address, including for nested pages, so reload and history restore that parent.
  await act(async () => {
    history.replaceState(null, '', '/?session=s1&settings=diagnostics/otlp/limits')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await act(async () =>
    $(reloaded, '[data-testid="settings-subpage-limits"]').dispatchEvent(
      new CustomEvent(SUBPAGE_CLOSE_EVENT, { bubbles: true }),
    ),
  )
  expect(new URL(location.href).searchParams.get('settings')).toBe('diagnostics/otlp')
  await act(async () => cleanups.shift()?.())
  const parent = await render(page())
  expect($(parent, '[data-testid="settings-subpage-header"] h2').textContent).toBe('OTLP')
  expect(parent.querySelector('[data-testid="settings-subpage-limits"]')).toBeNull()
  await act(async () => {
    history.replaceState(null, '', location.href)
    $(parent, '[data-testid="settings-subpage-otlp"]').dispatchEvent(
      new CustomEvent(SUBPAGE_CLOSE_EVENT, { bubbles: true }),
    )
  })
  expect(new URL(location.href).searchParams.get('settings')).toBe('diagnostics')
  expect(new URL(location.href).searchParams.get('session')).toBe('s1')
  await act(async () => cleanups.shift()?.())
  const completed = await render(page())
  expect(completed.querySelector('[data-testid="settings-subpage-otlp"]')).toBeNull()
  const completedAddress = location.href
  const completedState = history.state
  await act(async () => {
    history.pushState(null, '', '/?session=s1&settings=diagnostics/otlp')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  expect($(completed, '[data-testid="settings-subpage-header"] h2').textContent).toBe('OTLP')
  await act(async () => {
    history.replaceState(completedState, '', completedAddress)
    window.dispatchEvent(new PopStateEvent('popstate', { state: completedState }))
  })
  expect(new URL(location.href).searchParams.get('settings')).toBe('diagnostics')
  expect(completed.querySelector('[data-testid="settings-subpage-otlp"]')).toBeNull()
})
