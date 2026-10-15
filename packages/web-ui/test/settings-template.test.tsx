/** @vitest-environment happy-dom */
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import {
  Button,
  Disclosure,
  LabeledSwitch,
  mountRegion,
  SearchBar,
  SettingsCard,
  SettingsDetails,
  SettingsGroup,
  SettingsItem,
  SettingsPage,
  SettingsPageActions,
  SettingsPageHeader,
  SettingsTechnicalDetails,
} from '../src/index.js'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.replaceChildren()
  document.documentElement.lang = ''
})
function render(element: Parameters<typeof mountRegion>[1]) {
  const host = document.createElement('div')
  document.body.append(host)
  disposers.push(mountRegion(host, element))
  return host
}

it('shows one header line per screen: a nested page hands its actions to the outer one', () => {
  const host = render(
    createElement(
      SettingsPage,
      { title: 'Credentials', 'data-testid': 'outer' },
      createElement(
        SettingsPage,
        {
          title: 'Credentials',
          headingId: 'inner-title',
          description: 'Keys used by tools.',
          actions: createElement(Button, { 'data-testid': 'create' }, 'New'),
          'data-testid': 'inner',
        },
        createElement(
          SettingsPageActions,
          null,
          createElement(Button, { 'data-testid': 'refresh' }, 'Refresh'),
        ),
        createElement('p', null, 'Body'),
      ),
    ),
  )
  const headers = host.querySelectorAll('header.agnes-settings-page-heading')
  expect(headers).toHaveLength(1)
  const header = headers[0]
  expect(header?.closest('[data-testid="outer"]')).not.toBeNull()
  // The header line is the title alone: no description line under it.
  expect(header?.querySelector('h2')?.textContent).toBe('Credentials')
  expect(header?.textContent).not.toContain('Keys used by tools.')
  expect(
    [...(header?.querySelectorAll('.agnes-settings-actions [data-testid]') ?? [])].map((node) =>
      node.getAttribute('data-testid'),
    ),
  ).toEqual(['create', 'refresh'])
  // The inner title stays reachable for labels and assistive tech without a second visible heading.
  const inner = host.querySelector('#inner-title')
  expect(inner?.textContent).toBe('Credentials')
  expect(inner?.classList.contains('visually-hidden')).toBe(true)
  expect(host.querySelector('[data-testid="inner"]')?.getAttribute('data-nested')).toBe('true')
})

it('renders a standalone header and standalone page actions in place', () => {
  const host = render(
    createElement(
      'div',
      null,
      createElement(SettingsPageHeader, { title: 'General', description: 'Local preferences.' }),
      createElement(SettingsPageActions, null, createElement(Button, null, 'Reset')),
    ),
  )
  expect(host.querySelector('header h2')?.textContent).toBe('General')
  expect(host.querySelector('header .agnes-settings-actions')).toBeNull()
  expect(host.querySelector('.agnes-settings-actions button')?.textContent).toBe('Reset')
})

it('keeps a card heading outside its outline and rows inside one group', () => {
  const host = render(
    createElement(
      'div',
      null,
      createElement(
        SettingsCard,
        { title: 'Status', description: 'Local checks.', 'data-testid': 'card' },
        createElement('p', null, 'Ready'),
      ),
      createElement(
        SettingsGroup,
        null,
        createElement(
          SettingsItem,
          { label: 'Theme', labelId: 'theme', description: 'Follows the system.' },
          'control',
        ),
        createElement(SettingsItem, { label: 'Read-only' }),
      ),
    ),
  )
  const section = host.querySelector('[data-testid="card"]')
  expect(section?.classList.contains('agnes-settings-section')).toBe(true)
  expect(section?.querySelector(':scope > .agnes-settings-section-heading h3')?.textContent).toBe('Status')
  expect(section?.querySelector(':scope > .agnes-settings-card h3')).toBeNull()
  expect(section?.querySelector(':scope > .agnes-settings-card')?.textContent).toBe('Ready')
  const items = host.querySelectorAll('.agnes-settings-group > .agnes-settings-item')
  expect(items).toHaveLength(2)
  expect(items[0]?.querySelector('#theme')?.textContent).toBe('Theme')
  expect(items[0]?.querySelector('.agnes-settings-item-control')?.textContent).toBe('control')
  expect(items[1]?.querySelector('.agnes-settings-item-control')).toBeNull()
})

it('gives a variant disclosure the shared chevron, a named region and a reported toggle', () => {
  const toggled = vi.fn()
  const host = render(
    createElement(
      'div',
      null,
      createElement(
        Disclosure,
        {
          summary: 'Advanced',
          variant: 'plain',
          id: 'advanced',
          'data-testid': 'advanced',
          onOpenChange: toggled,
        },
        'Hidden content',
      ),
      createElement(SettingsTechnicalDetails, null, 'probe: l1'),
    ),
  )
  const details = host.querySelector<HTMLElement>('#advanced')
  expect(details?.dataset.open).toBe('false')
  expect(details?.getAttribute('data-testid')).toBe('advanced')
  const summary = details?.querySelector<HTMLButtonElement>('button.agh-disclosure-summary')
  expect(summary?.textContent).toBe('Advanced')
  expect(summary?.getAttribute('aria-expanded')).toBe('false')
  expect(summary?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  const body = details?.querySelector<HTMLElement>('.agh-disclosure-body')
  expect(body?.textContent).toBe('Hidden content')
  expect(body?.id).toBe(summary?.getAttribute('aria-controls'))
  expect(body?.hidden).toBe(true)
  flushSync(() => summary?.click())
  expect(toggled).toHaveBeenCalledExactlyOnceWith(true)
  expect([details?.dataset.open, summary?.getAttribute('aria-expanded'), body?.hidden]).toEqual([
    'true',
    'true',
    false,
  ])
  // Diagnostics are kept on the page under one fixed, localized name.
  expect(host.querySelector('.agnes-settings-technical .agh-disclosure-summary')?.textContent).toBe(
    'Technical details',
  )
})

it('submits a search with Enter without submitting a host form, and names its field', () => {
  const submit = vi.fn(),
    change = vi.fn(),
    hostSubmit = vi.fn((event: Event) => event.preventDefault())
  const host = render(
    createElement(
      'form',
      { onSubmit: hostSubmit },
      createElement(SearchBar, {
        label: 'Search history',
        placeholder: 'Search titles and messages…',
        value: 'report',
        onChange: change,
        onSubmit: submit,
        inputProps: { id: 'history-query', 'data-testid': 'history-query' },
        filters: createElement('span', null, 'filter'),
        actions: createElement(Button, null, 'Search'),
      }),
    ),
  )
  const input = host.querySelector<HTMLInputElement>('#history-query')
  expect(host.querySelector('[role="search"]')).not.toBeNull()
  expect(host.querySelector('form form')).toBeNull()
  expect(input?.type).toBe('search')
  expect(input?.placeholder).toBe('Search titles and messages…')
  expect(input?.closest('label')?.textContent).toBe('Search history')
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  input?.dispatchEvent(enter)
  expect(submit).toHaveBeenCalledTimes(1)
  expect(enter.defaultPrevented).toBe(true)
  expect(hostSubmit).not.toHaveBeenCalled()
})

it('states a switch in words in the document language', () => {
  const toggle = vi.fn()
  document.documentElement.lang = 'zh-CN'
  const host = render(
    createElement(LabeledSwitch, { label: '自动审阅', checked: false, disabled: false, onToggle: toggle }),
  )
  expect(host.querySelector('.agh-labeled-switch-state')?.textContent).toBe('已关闭')
  const control = host.querySelector<HTMLButtonElement>('[role="switch"]')
  expect(control?.getAttribute('aria-label')).toBe('自动审阅')
  expect(control?.getAttribute('aria-checked')).toBe('false')
  control?.click()
  expect(toggle).toHaveBeenCalledWith(true)
})

it('makes a page-level section a card of its own and a nested one a row of its surface', () => {
  const host = render(
    createElement(
      'div',
      null,
      createElement(
        SettingsDetails,
        {
          title: 'Memory',
          icon: 'history',
          description: 'What is kept between sessions.',
          summary: 'File memory',
          'data-testid': 'memory',
        },
        createElement(SettingsDetails, { title: 'History', 'data-testid': 'inner' }, 'runs'),
      ),
      createElement(
        SettingsGroup,
        null,
        createElement(SettingsDetails, { title: 'Custom review', 'data-testid': 'grouped' }, 'rules'),
      ),
    ),
  )
  const card = host.querySelector<HTMLElement>('[data-testid="memory"]')
  expect(card?.dataset.variant).toBe('card')
  const summary = card?.querySelector<HTMLButtonElement>(':scope > .agh-disclosure-summary')
  expect(summary?.querySelector('.agh-icon-tile svg')).not.toBeNull()
  // The title alone names the section; its purpose and current value describe it.
  const name = host.ownerDocument.getElementById(summary?.getAttribute('aria-labelledby') ?? '')
  expect(name?.textContent).toBe('Memory')
  expect(
    (summary?.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => host.ownerDocument.getElementById(id)?.textContent),
  ).toEqual(['What is kept between sessions.', 'File memory'])
  expect(host.querySelector<HTMLElement>('[data-testid="inner"]')?.dataset.variant).toBe('row')
  expect(host.querySelector<HTMLElement>('[data-testid="grouped"]')?.dataset.variant).toBe('row')
})
