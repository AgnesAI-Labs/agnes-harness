/** @vitest-environment happy-dom */
import { resolve } from 'node:path'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { readUiCss } from '../../../tools/web-style-source.mjs'
import {
  Button,
  CompletionCheck,
  CopyButton,
  Count,
  Disclosure,
  Icon,
  IconButton,
  Kbd,
  Menu,
  mountRegion,
  StatusDot,
  shortcutKeys,
  shortcutLabel,
  Tag,
  Toast,
  Tooltip,
} from '../src/index.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
  document.documentElement.removeAttribute('data-agnes-input')
})
function render(element: Parameters<typeof mountRegion>[1]) {
  const host = document.createElement('div')
  document.body.append(host)
  cleanups.push(mountRegion(host, element))
  return host
}
function key(node: Element, name: string) {
  node.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
}
function pointer(node: Element, type: 'pointerdown' | 'pointerover' | 'pointerout', pointerType = 'mouse') {
  // React derives pointerenter/pointerleave from pointerover/pointerout, not from native enter/leave.
  // A null relatedTarget means the pointer left the element for nothing inside the React tree.
  node.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, pointerType, relatedTarget: null }),
  )
}

it('keeps tags textual and omits zero actionable counts', () => {
  const host = render(
    createElement(
      'div',
      null,
      createElement(Tag, { tone: 'warn' }, 'Restart required'),
      createElement(Count, { value: 0, label: 'No pending reviews' }),
      createElement(Count, { value: 3, label: '3 pending reviews' }),
    ),
  )
  expect(host.querySelector('[data-tone="warn"]')?.textContent).toBe('Restart required')
  expect(host.querySelectorAll('.agh-count')).toHaveLength(1)
  expect(host.querySelector('.agh-count')?.getAttribute('aria-label')).toBe('3 pending reviews')
})
it('moves through enabled menu actions, typeahead and danger-last grouping; restores focus', async () => {
  let selected = ''
  const host = render(
    createElement(Menu, {
      label: 'Actions',
      tone: 'neutral',
      trigger: createElement(Button, null, 'More'),
      items: [
        {
          id: 'delete',
          label: 'Delete',
          danger: true,
          onSelect: () => {
            selected = 'delete'
          },
        },
        {
          id: 'edit',
          label: 'Edit',
          icon: createElement(Icon, { name: 'pencil' }),
          onSelect: () => {
            selected = 'edit'
          },
        },
        {
          id: 'disabled',
          label: 'Unavailable',
          disabled: true,
          onSelect: () => {
            selected = 'disabled'
          },
        },
        {
          id: 'copy',
          label: 'Copy',
          onSelect: () => {
            selected = 'copy'
          },
        },
      ],
    }),
  )
  const trigger = host.querySelector('button')!
  trigger.focus()
  key(trigger, 'ArrowDown')
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Edit'))
  const menu = document.querySelector('[role="menu"]')!
  expect([...menu.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent)).toEqual([
    'Edit',
    'Unavailable',
    'Copy',
    'Delete',
  ])
  expect(menu.querySelectorAll('[role="separator"]')).toHaveLength(1)
  expect(menu.closest('.agh-menu-popup--neutral')).not.toBeNull()
  expect(menu.querySelector('.agh-menu-icon svg')?.getAttribute('width')).toBe('16')
  key(document.activeElement!, 'ArrowDown')
  expect(document.activeElement?.textContent).toBe('Copy')
  key(document.activeElement!, 'd')
  expect(document.activeElement?.textContent).toBe('Delete')
  key(document.activeElement!, 'Home')
  expect(document.activeElement?.textContent).toBe('Edit')
  key(document.activeElement!, 'Escape')
  await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
  expect(document.activeElement).toBe(trigger)
  trigger.click()
  await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))
  key(document.querySelector('[role="menuitem"]')!, 'Enter')
  expect(selected).toBe('edit')
  expect(document.activeElement).toBe(trigger)
  await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
  key(trigger, 'ArrowUp')
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Delete'))
  key(document.activeElement!, 'Escape')
  await vi.waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
  trigger.click()
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Edit'))
})
it('dismisses the menu when content scrolls away or the mouse pointer leaves', async () => {
  const host = render(
    createElement(Menu, {
      label: 'Actions',
      trigger: createElement(Button, null, 'More'),
      items: [
        { id: 'edit', label: 'Edit', onSelect: () => {} },
        { id: 'copy', label: 'Copy', onSelect: () => {} },
      ],
    }),
  )
  const trigger = host.querySelector('button')!
  const menu = () => document.querySelector('[role="menu"]')
  const expanded = () => trigger.getAttribute('aria-expanded')
  const settle = () => new Promise((done) => setTimeout(done, 250))
  const openBy = async (pointerType: string) => {
    pointer(trigger, 'pointerdown', pointerType)
    trigger.click()
    await vi.waitFor(() => expect(expanded()).toBe('true'))
  }
  const closed = async () => {
    await vi.waitFor(() => expect(expanded()).toBe('false'))
    // happy-dom never fires transition events, so the closing motion is nudged until it unmounts.
    await vi.waitFor(() => {
      document.querySelector('.agh-menu-popup')?.dispatchEvent(new Event('transitionend', { bubbles: true }))
      expect(menu()).toBeNull()
    })
  }

  // The menu is portalled outside the pane that scrolls it away, so an outside scroll dismisses it.
  const anchor = host.querySelector<HTMLElement>('.agh-menu-anchor')!
  let top = 100
  const box = vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => new DOMRect(10, top, 40, 20))
  await openBy('mouse')
  // A scroll that leaves the anchor in place (a pane settling as the popup mounts) keeps it open.
  document.body.dispatchEvent(new Event('scroll'))
  await settle()
  expect(expanded()).toBe('true')
  top = 60
  document.body.dispatchEvent(new Event('scroll'))
  await closed()
  box.mockRestore()

  // Scrolling inside the menu moves its own content, not its anchor.
  await openBy('mouse')
  menu()!.dispatchEvent(new Event('scroll'))
  await settle()
  expect(expanded()).toBe('true')
  expect(menu()).not.toBeNull()

  window.dispatchEvent(new Event('resize'))
  await closed()

  // A mouse that leaves the trigger without entering the menu dismisses it after the grace period.
  await openBy('mouse')
  pointer(trigger, 'pointerout')
  await closed()

  // Crossing the portal gap from the trigger into the menu cancels that dismissal.
  await openBy('mouse')
  pointer(trigger, 'pointerout')
  pointer(menu()!, 'pointerover')
  await settle()
  expect(expanded()).toBe('true')
  expect(menu()).not.toBeNull()
  key(menu()!.querySelector('[role="menuitem"]')!, 'Escape')
  await closed()

  // A keyboard session has no pointer origin, so a passing mouse must not close it.
  trigger.focus()
  key(trigger, 'ArrowDown')
  await vi.waitFor(() => expect(expanded()).toBe('true'))
  pointer(trigger, 'pointerout')
  await settle()
  expect(expanded()).toBe('true')
  expect(menu()).not.toBeNull()
  key(document.activeElement!, 'Escape')
  await closed()

  // A touch point lifts right after opening; that is not a mouse leaving.
  await openBy('touch')
  pointer(trigger, 'pointerout', 'touch')
  await settle()
  expect(expanded()).toBe('true')
  key(document.activeElement!, 'Escape')
  await closed()
})
it('explains a disabled action immediately on keyboard focus', async () => {
  const host = render(
    createElement(
      Tooltip,
      { title: 'Finish the review first', disabled: true },
      createElement('button', { type: 'button', disabled: true }, 'Install'),
    ),
  )
  const anchor = host.querySelector<HTMLElement>('[tabindex="0"]')!
  // A dialog closed with Escape hands focus back to its trigger; that is not navigation.
  key(document.body, 'Escape')
  anchor.focus()
  await new Promise((done) => setTimeout(done, 50))
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  anchor.blur()
  key(document.body, 'Tab')
  anchor.focus()
  await vi.waitFor(() =>
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Finish the review first'),
  )
  expect(host.querySelector('button')?.getAttribute('aria-describedby')).toBeTruthy()
  key(host.querySelector('[tabindex="0"]')!, 'Escape')
  await vi.waitFor(() => expect(host.querySelector('button')?.getAttribute('aria-describedby')).toBeNull())
})
it('names an icon action and its shortcut as keycaps in the tooltip', async () => {
  const host = render(
    createElement(IconButton, { name: 'search', label: 'Search sessions', shortcut: ['⌘', 'K'] }),
  )
  const style = document.createElement('style')
  // happy-dom lacks cascade layers; apply the real hint hit-testing rule on its own.
  style.textContent =
    readUiCss(resolve(__dirname, '../src/components.css')).match(
      /\.agh-tooltip,\s*\.agh-tooltip \*\s*\{[^}]+\}/,
    )?.[0] ?? ''
  document.head.append(style)
  cleanups.push(() => style.remove())
  const button = host.querySelector('button')!
  // The accessible name is the action; the shortcut is only shown.
  expect(button.getAttribute('aria-label')).toBe('Search sessions')
  key(document.body, 'Tab')
  button.focus()
  const tooltip = await vi.waitFor(() => {
    const found = document.querySelector('[role="tooltip"] .agh-tooltip-shortcut')
    expect(found).toBeTruthy()
    return found!
  })
  expect(tooltip.firstChild?.textContent).toBe('Search sessions')
  // A hint may overlap an adjacent action while focus or hover moves through navigation.
  expect(getComputedStyle(document.querySelector('[role=tooltip]')!).pointerEvents).toBe('none')
  expect([...tooltip.querySelectorAll('kbd.agh-kbd .agh-kbd-key')].map((cap) => cap.textContent)).toEqual([
    '⌘',
    'K',
  ])
  // Activating navigation must dismiss its focused hint before it can cover the next action.
  button.click()
  await vi.waitFor(() => expect(button.getAttribute('aria-describedby')).toBeNull())
})
it('announces success without stealing focus and cleans up the expiry on unmount', async () => {
  const dismiss = vi.fn()
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  render(createElement(Toast, { open: true, duration: 40, onDismiss: dismiss }, 'Saved'))
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toBe('Saved'))
  expect(document.activeElement).toBe(trigger)
  expect(document.querySelector('[role="alert"]')).toBeNull()
  key(trigger, 'Escape')
  expect(dismiss).toHaveBeenCalledTimes(1)
  cleanups.pop()!()
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(dismiss).toHaveBeenCalledTimes(1)
})

it('draws a toast as one card: an outcome icon beside text that only viewport lengths bound', async () => {
  render(createElement(Toast, { open: true, duration: 0, tone: 'error', onDismiss: () => {} }, 'Not saved'))
  await vi.waitFor(() => expect(document.querySelector('.agh-toast--error')).toBeTruthy())
  const toast = document.querySelector('.agh-toast--error')!
  expect(toast.querySelector('svg.agh-toast-icon')?.getAttribute('aria-hidden')).toBe('true')
  expect(toast.querySelector('.agh-toast-text')?.textContent).toBe('Not saved')
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const css = readFileSync(resolve(import.meta.dirname, '../src/components.css'), 'utf8')
  const rule = /\n {2}\.agh-toast \{([^}]+)\}/.exec(css)![1]!
  // The message layer shrinks to fit its content, so a percentage bound would collapse the card.
  expect(rule).toContain('min-width: min(15rem, calc(100vw - var(--s32)))')
  expect(rule).toContain('max-width: min(26.25rem, calc(100vw - var(--s32)))')
  expect(rule).not.toMatch(/(?:min-|max-)?width:[^;]*%/)
  expect(rule).not.toContain('position: fixed')
})

it('draws settings icons with the shared Icon geometry and labels icon actions', async () => {
  const { Icon, IconButton, SettingsIcon, settingsIconName, icons } = await import('../src/index.js')
  for (const name of Object.keys(icons) as (keyof typeof icons)[]) {
    const svg = render(createElement(Icon, { name, size: 20 })).querySelector('svg')!
    const settings = render(createElement(SettingsIcon, { icon: name })).querySelector('svg')!
    expect(settings.outerHTML).toBe(svg.outerHTML)
    expect(svg.getAttribute('data-agnes-region')).toBe('icon')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('stroke-width')).toBe('1.5')
  }
  // A settings category maps to its glyph, and an unknown name reads as a plugin.
  expect(settingsIconName('security')).toBe('shield-check')
  expect(settingsIconName('plugins')).toBe('puzzle')
  expect(settingsIconName('no-such-icon')).toBe('puzzle')
  const host = render(createElement(IconButton, { name: 'refresh-cw', label: 'Refresh' }))
  expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Refresh')
  const pending = render(createElement(Button, { 'aria-busy': true, disabled: true }, 'Refresh'))
  expect(pending.querySelector('button')?.getAttribute('aria-busy')).toBe('true')
  const settled = render(createElement(Button, { 'aria-busy': false }, 'Refresh'))
  expect(settled.querySelector('button')?.getAttribute('aria-busy')).toBe('false')
})

it('confirms on Enter, refuses decisions while busy and cancels on Escape with focus return', async () => {
  const { ConfirmDialog, renderRegion } = await import('../src/index.js')
  const confirm = vi.fn(),
    cancel = vi.fn()
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const element = (busy: boolean, open = true, confirmDisabled = false) => (
    <ConfirmDialog
      open={open}
      title="Delete record"
      confirmLabel="Delete"
      destructive
      busy={busy}
      confirmDisabled={confirmDisabled}
      onConfirm={confirm}
      onCancel={cancel}
    >
      <input aria-label="Reason" />
    </ConfirmDialog>
  )
  const host = render(element(false))
  const input = host.querySelector('input')!
  input.focus()
  key(input, 'Enter')
  expect(confirm).toHaveBeenCalledOnce()
  renderRegion(host, element(false, true, true))
  key(host.querySelector('input')!, 'Enter')
  const disabledConfirm = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Delete',
  )
  expect(disabledConfirm?.disabled).toBe(true)
  disabledConfirm?.click()
  expect(confirm).toHaveBeenCalledOnce()
  const enabledCancel = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')
  expect(enabledCancel?.disabled).toBe(false)
  renderRegion(host, element(true))
  key(host.querySelector('input')!, 'Enter')
  key(host.querySelector('input')!, 'Escape')
  expect(confirm).toHaveBeenCalledOnce()
  expect(cancel).not.toHaveBeenCalled()
  expect(host.querySelector('button')?.disabled).toBe(true)
  renderRegion(host, element(false))
  const escapeEvent = new KeyboardEvent('keydown', {
    key: 'Escape',
    keyCode: 27,
    bubbles: true,
    cancelable: true,
  })
  host.querySelector('input')!.dispatchEvent(escapeEvent)
  expect(cancel).toHaveBeenCalledOnce()
  renderRegion(host, element(false, false))
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
})

it('sorts Table records without changing caller data and retains its labelled source table', async () => {
  const { Table, renderRegion } = await import('../src/index.js')
  const rows = [
    { id: 'b', value: 200 },
    { id: 'a', value: 2 },
  ]
  const columns = [
    {
      title: 'Amount',
      dataIndex: 'value',
      key: 'amount',
      sorter: (a: (typeof rows)[number], b: (typeof rows)[number]) => a.value - b.value,
    },
  ]
  const host = render(
    <Table caption="Amounts" testId="amounts" dataSource={rows} rowKey="id" columns={columns} />,
  )
  expect(host.querySelector('caption')?.textContent).toBe('Amounts')
  host.querySelector<HTMLElement>('th')!.click()
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll('tbody tr[data-row-key]')].map((row) => row.getAttribute('data-row-key')),
    ).toEqual(['a', 'b']),
  )
  expect(rows.map((row) => row.id)).toEqual(['b', 'a'])
  expect(host.querySelector('tr[data-row-key="a"] td span')?.getAttribute('title')).toBe('2')
  renderRegion(
    host,
    <Table caption="Amounts" captionRepeatsHeading testId="amounts" dataSource={[]} columns={columns} />,
  )
  expect(host.querySelector('caption')?.hasAttribute('data-repeats-heading')).toBe(true)
  const css = readUiCss(resolve(import.meta.dirname, '../src/components.css'))
  expect(css).toMatch(/\.agh-table caption\[data-repeats-heading\]\s*\{[^}]*clip-path: inset\(50%\)/)
  expect(host.querySelector('[data-testid="amounts"] [role="status"]')?.textContent).toBe(
    'No records to display.',
  )
})

it('preserves decision field text and refuses normalized external evidence links', async () => {
  const { decisionPresentation, DecisionFields, renderRegion } = await import('../src/index.js')
  const meaning = 'I approve  / exact punctuation.\nEvidence reviewed.'
  const entries = {
    en: {
      title: 'Review',
      fields: [{ label: 'Meaning', value: meaning, href: '/\n/external.test' }],
      responseValue: meaning,
    },
  }
  const view = decisionPresentation(entries, 'constructor')
  expect(view).toBe(entries.en)
  const host = render(<DecisionFields view={entries.en} />)
  expect(host.querySelector('dd')?.textContent).toBe(meaning)
  expect(host.querySelector('a')).toBeNull()
  renderRegion(
    host,
    <DecisionFields
      view={{ ...entries.en, fields: [{ label: 'Evidence', value: 'Open', href: '/?session=s' }] }}
    />,
  )
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/?session=s')
})

it('returns focus to the anchored Popover trigger on Escape', async () => {
  const { Popover, renderRegion } = await import('../src/index.js')
  const picker = () => (
    <Popover trigger="click" content={<Button>Choose</Button>}>
      <Button>Picker</Button>
    </Popover>
  )
  document.documentElement.setAttribute('data-agnes-input', 'keyboard')
  const host = render(picker())
  const trigger = host.querySelector('button')!
  trigger.focus()
  trigger.click()
  await vi.waitFor(() => expect(document.querySelector('.agnes-ui-popover button')).not.toBeNull())
  expect(document.querySelector('.agnes-ui-popover--keyboard')).not.toBeNull()
  document.documentElement.setAttribute('data-agnes-input', 'pointer')
  renderRegion(host, picker())
  await vi.waitFor(() => expect(document.querySelector('.agnes-ui-popover--keyboard')).not.toBeNull())
  expect(document.querySelector('.agnes-ui-popover--pointer')).toBeNull()
  const choice = document.querySelector<HTMLElement>('.agnes-ui-popover button')!
  choice.focus()
  key(choice, 'Escape')
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  trigger.click()
  await vi.waitFor(() => expect(document.querySelector('.agnes-ui-popover--pointer')).not.toBeNull())
})

it('keeps DataList row actions independent from opening a row and renders caller empty content', async () => {
  const { DataList, renderRegion } = await import('../src/index.js')
  const open = vi.fn(),
    action = vi.fn()
  const host = render(
    <DataList
      items={[{ id: 'record', title: 'Record' }]}
      rowKey={(item) => item.id}
      renderRow={(item) => ({
        title: item.title,
        onOpen: open,
        actions: <Button onClick={action}>Archive</Button>,
      })}
    />,
  )
  const buttons = host.querySelectorAll<HTMLButtonElement>('button')
  buttons[1]!.click()
  expect(action).toHaveBeenCalledOnce()
  expect(open).not.toHaveBeenCalled()
  buttons[0]!.click()
  expect(open).toHaveBeenCalledOnce()
  renderRegion(
    host,
    <DataList
      items={[]}
      rowKey={() => ''}
      renderRow={() => ({ title: '' })}
      empty={<p role="status">No rows</p>}
    />,
  )
  expect(host.querySelector('[role="status"]')?.textContent).toBe('No rows')
})

it('spells shortcuts for the platform and renders them as an untranslated hint chip', () => {
  expect(shortcutLabel(['mod', 'N'], true)).toBe('⌘N')
  expect(shortcutLabel(['mod', 'shift', 'enter'], true)).toBe('⌘⇧↵')
  expect(shortcutLabel(['mod', 'esc'], true)).toBe('⌘ Esc')
  expect(shortcutLabel(['mod', 'shift', 'N'], false)).toBe('Ctrl+Shift+N')
  expect(shortcutKeys(['shift', 'mod', 'O'], true)).toEqual(['⇧', '⌘', 'O'])
  expect(shortcutKeys(['mod', 'shift', 'O'], false)).toEqual(['Ctrl', 'Shift', 'O'])
  // Each key is its own keycap.
  const host = render(createElement(Kbd, { keys: ['⇧', '⌘', 'O'] }))
  const chip = host.querySelector('kbd.agh-kbd')
  expect([...(chip?.querySelectorAll('.agh-kbd-key') ?? [])].map((key) => key.textContent)).toEqual([
    '⇧',
    '⌘',
    'O',
  ])
  expect(chip?.getAttribute('translate')).toBe('no')
  // Children are a single keycap.
  const single = render(createElement(Kbd, null, '↑')).querySelector('kbd.agh-kbd')
  expect([...(single?.querySelectorAll('.agh-kbd-key') ?? [])].map((key) => key.textContent)).toEqual(['↑'])
})
it('toggles a disclosure from its button, names the region it controls and keeps closed content mounted', () => {
  const changes: boolean[] = []
  const host = render(
    createElement(
      'div',
      null,
      createElement(
        Disclosure,
        {
          className: 'facts',
          summary: 'Details',
          summaryProps: { 'data-testid': 'facts-toggle', 'aria-label': 'Show details' },
          onOpenChange: (open: boolean) => changes.push(open),
        },
        createElement('p', null, 'body'),
      ),
      createElement(Disclosure, { id: 'initial', summary: 'Source', defaultOpen: true }, 'source'),
      createElement(Disclosure, { id: 'held', summary: 'Held', open: false }, 'held'),
    ),
  )
  const root = host.querySelector<HTMLElement>('div.agh-disclosure.facts')
  const summary = root?.querySelector<HTMLButtonElement>(':scope > button.agh-disclosure-summary')
  if (!root || !summary) throw new Error('missing disclosure')
  expect(host.querySelector('details, summary')).toBeNull()
  expect(summary.textContent).toBe('Details')
  expect(summary.type).toBe('button')
  expect(summary.getAttribute('data-testid')).toBe('facts-toggle')
  expect(summary.getAttribute('aria-label')).toBe('Show details')
  const region = document.getElementById(summary.getAttribute('aria-controls') ?? '')
  expect(region?.parentElement).toBe(root)
  expect(region?.textContent).toBe('body')
  expect([root.dataset.open, summary.getAttribute('aria-expanded'), region?.hidden]).toEqual([
    'false',
    'false',
    true,
  ])
  flushSync(() => summary.click())
  expect([root.dataset.open, summary.getAttribute('aria-expanded'), region?.hidden]).toEqual([
    'true',
    'true',
    false,
  ])
  flushSync(() => summary.click())
  expect(root.dataset.open).toBe('false')
  expect(changes).toEqual([true, false])
  // Escape belongs to dismissible panels only; a section stays as the reader left it.
  flushSync(() => summary.click())
  flushSync(() => key(summary, 'Escape'))
  expect(root.dataset.open).toBe('true')
  expect(host.querySelector<HTMLElement>('#initial')?.dataset.open).toBe('true')
  // A controlled disclosure reports the request and waits for its owner.
  flushSync(() => host.querySelector<HTMLElement>('#held > .agh-disclosure-summary')?.click())
  expect(host.querySelector<HTMLElement>('#held')?.dataset.open).toBe('false')
})
it('closes a dismissible disclosure on Escape or a click outside and returns focus to its button', () => {
  const host = render(
    createElement(
      Disclosure,
      { id: 'panel', summary: 'Usage', dismissible: true },
      createElement('p', null, 'x'),
    ),
  )
  const root = host.querySelector<HTMLElement>('#panel')
  const summary = root?.querySelector<HTMLButtonElement>('.agh-disclosure-summary')
  const inside = root?.querySelector('p')
  if (!root || !summary || !inside) throw new Error('missing disclosure')
  flushSync(() => summary.click())
  flushSync(() => inside.click())
  expect(root.dataset.open).toBe('true')
  flushSync(() => document.body.click())
  expect(root.dataset.open).toBe('false')
  flushSync(() => summary.click())
  flushSync(() => key(inside, 'Escape'))
  expect(root.dataset.open).toBe('false')
  expect(document.activeElement).toBe(summary)
})
it('names a status dot only when no adjacent text states the status', () => {
  const host = render(
    createElement(
      'div',
      null,
      createElement(StatusDot, { running: true }),
      createElement(StatusDot, { tone: 'danger', label: 'Failed' }),
    ),
  )
  const [running, failed] = host.querySelectorAll('.agh-status-dot')
  expect(running?.getAttribute('data-running')).toBe('true')
  expect(running?.getAttribute('aria-hidden')).toBe('true')
  expect(failed?.hasAttribute('data-running')).toBe(false)
  expect(failed?.getAttribute('role')).toBe('img')
  expect(failed?.getAttribute('aria-label')).toBe('Failed')
  expect(failed?.getAttribute('data-tone')).toBe('danger')
})
it('marks completion with a named check and an optional quiet detail', () => {
  const host = render(createElement(CompletionCheck, { label: 'Completed' }, '12s'))
  const mark = host.querySelector('.agh-completion')
  expect(mark?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  expect(mark?.querySelector('.agh-visually-hidden')?.textContent).toBe('Completed')
  expect(mark?.querySelector('.agh-completion-detail')?.textContent).toBe('12s')
})
it('turns the copy action into a confirmation only after a successful copy, then restores it', async () => {
  // Only the confirmation timer is virtual; React keeps scheduling on real tasks.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  // The copy resolves in a microtask and React renders in the task after it.
  const settled = async () => {
    for (let turn = 0; turn < 3; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  try {
    const outcomes: boolean[] = []
    let succeed = false
    const host = render(
      createElement(CopyButton, {
        label: 'Copy',
        copiedLabel: 'Copied',
        onCopy: () => succeed,
        onCopied: (copied: boolean) => outcomes.push(copied),
      }),
    )
    const button = () => host.querySelector('button') as HTMLButtonElement
    button().click()
    await settled()
    expect(outcomes).toEqual([false])
    expect(button().getAttribute('aria-label')).toBe('Copy')
    expect(host.querySelector('[role="status"]')).toBeNull()
    succeed = true
    button().click()
    await settled()
    expect(outcomes).toEqual([false, true])
    expect(button().getAttribute('aria-label')).toBe('Copied')
    expect(button().hasAttribute('data-copied')).toBe(true)
    expect(host.querySelector('[role="status"]')).toBeNull()
    await vi.advanceTimersByTimeAsync(1600)
    await settled()
    expect(button().getAttribute('aria-label')).toBe('Copy')
    expect(button().hasAttribute('data-copied')).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})
