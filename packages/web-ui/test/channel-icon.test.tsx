/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ChannelIcon } from '../src/ui/channel-icon.js'

const icon =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

it('uses bounded plugin artwork, falls back on load failure and releases image URLs on replacement and unmount', async () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:channel-icon')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const render = async (value?: string) =>
    act(async () => root.render(createElement(ChannelIcon, { icon: value })))
  try {
    await render()
    expect(host.querySelector('svg')).not.toBeNull()
    await render(icon)
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:channel-icon')
    expect(host.querySelector('svg')).toBeNull()
    await act(async () => host.querySelector('img')?.dispatchEvent(new Event('error')))
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('svg')).not.toBeNull()
    await render()
    expect(revoke).toHaveBeenCalledWith('blob:channel-icon')
    await render(icon)
    expect(host.querySelector('img')).not.toBeNull()
    await act(async () => root.unmount())
    expect(revoke.mock.calls).toHaveLength(create.mock.calls.length)
  } finally {
    host.remove()
    vi.restoreAllMocks()
  }
})

it('never fetches remote, SVG, oversized or malformed artwork', async () => {
  const create = vi.spyOn(URL, 'createObjectURL')
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    for (const icon of [
      'https://example.com/logo.png',
      'data:image/svg+xml;base64,PHN2Zz4=',
      `data:image/png;base64,${'A'.repeat(32768)}`,
      'data:image/png;base64,aGVsbG8=',
    ]) {
      await act(async () => root.render(createElement(ChannelIcon, { icon })))
      expect(host.querySelector('img')).toBeNull()
      expect(host.querySelector('svg')).not.toBeNull()
    }
    expect(create).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  }
})
