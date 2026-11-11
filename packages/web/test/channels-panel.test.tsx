/** @vitest-environment happy-dom */
import { getByRole } from '@testing-library/dom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ChannelsPanel } from '../src/pages/channels.js'
import type { HomePageData } from '../src/pages/host.js'

it('previews instances, folds groups without losing open details, and expands all connections on demand', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const language = document.documentElement.lang
  document.documentElement.lang = 'en'
  const channels = ['DingTalk', 'Feishu', 'WeChat'].map((name, group) => ({
    provider: {
      extension: `plugin/${name}`,
      manifest: { id: name.toLowerCase(), displayName: name },
      bindingAvailable: true,
    },
    instances: Array.from({ length: 5 }, (_, i) => ({
      id: `connection-${group}-${i}`,
      workspace: 'D:/work',
      agent: 'default',
      version: 1,
      connection: { channel: 'connected', daemon: 'connected' },
      unavailable: false,
      bindings: [
        {
          sessionId: `session-${group}-${i}`,
          sessionTitle: `Session ${group}-${i}`,
          targetId: `peer-${i}`,
          label: `Team ${i}`,
          state: 'active',
        },
      ],
    })),
  }))
  const data = {
    call: vi.fn(async () => ({ channels, sessions: [] })),
    sessionId: () => undefined,
  } as unknown as HomePageData
  try {
    await act(async () => root.render(createElement(ChannelsPanel, { data })))
    await vi.waitFor(() => expect(host.querySelectorAll('.channel-group-shell')).toHaveLength(3))
    const first = host.querySelector<HTMLElement>('.channel-group-shell')!
    const rows = () => first.querySelectorAll('.channel-connection:not([hidden])')
    expect(rows()).toHaveLength(3)
    await act(async () => getByRole(first, 'button', { name: 'Show 2 more connections' }).click())
    expect(rows()).toHaveLength(5)
    const details = getByRole(first, 'button', { name: 'Connection details: Session 0-4' })
    await act(async () => details.click())
    expect(details.getAttribute('aria-expanded')).toBe('true')
    await act(async () => getByRole(first, 'button', { name: 'Show fewer connections' }).click())
    expect(rows()).toHaveLength(3)
    await act(async () => getByRole(first, 'button', { name: 'Show 2 more connections' }).click())
    expect(details.getAttribute('aria-expanded')).toBe('true')
    await act(async () => getByRole(host, 'button', { name: 'Collapse all' }).click())
    expect(
      [...host.querySelectorAll('.channel-group > button')].every(
        (button) => button.getAttribute('aria-expanded') === 'false',
      ),
    ).toBe(true)
    await act(async () => getByRole(first, 'button', { name: 'DingTalk connections' }).click())
    expect(details.getAttribute('aria-expanded')).toBe('true')
    await act(async () => getByRole(host, 'button', { name: 'Expand all' }).click())
    expect(host.querySelectorAll('.channel-connection:not([hidden])')).toHaveLength(15)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    document.documentElement.lang = language
  }
})
