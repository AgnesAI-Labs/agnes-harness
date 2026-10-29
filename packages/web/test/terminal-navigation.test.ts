// @vitest-environment happy-dom
import { workbenchNavigation } from '@agnes/web-client'
import { expect, it, vi } from 'vitest'
import { bindTerminalNavigation } from '../src/app/terminal-navigation.js'

it('opens current-session terminal selections, refuses invalid children and releases both listeners', () => {
  const open = vi.fn(() => true)
  const close = vi.fn()
  const unregister = workbenchNavigation.register(open)
  const stop = bindTerminalNavigation(close)
  const child = (detail: unknown) => new CustomEvent('agnes:open-terminal-job', { detail })
  try {
    for (const detail of [null, {}, { childId: 1 }, { childId: '' }]) document.dispatchEvent(child(detail))
    document.dispatchEvent(new Event('agnes:open-terminal-job'))
    expect(open).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    document.dispatchEvent(child({ childId: 'parent/c1' }))
    expect(open).toHaveBeenLastCalledWith('terminal', { childId: 'parent/c1' })
    expect(close).toHaveBeenCalled()
    const settings = new Event('agnes:settings-terminal', { cancelable: true })
    document.dispatchEvent(settings)
    expect(open).toHaveBeenLastCalledWith('terminal', undefined)
    expect(settings.defaultPrevented).toBe(true)
    open.mockReturnValue(false)
    const unavailable = new Event('agnes:settings-terminal', { cancelable: true })
    document.dispatchEvent(unavailable)
    expect(unavailable.defaultPrevented).toBe(false)
    stop()
    open.mockClear()
    close.mockClear()
    document.dispatchEvent(child({ childId: 'parent/c1' }))
    document.dispatchEvent(new Event('agnes:settings-terminal'))
    expect(open).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  } finally {
    stop()
    unregister()
  }
})
