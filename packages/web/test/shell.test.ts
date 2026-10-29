// @vitest-environment happy-dom

import { setLocaleTranslator } from '@agnes/web-foundation/locale-bridge'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSidebar } from '../src/shell.js'
import { zhT } from './helpers/locale.js'

// i18n: these suites assert zh-CN catalog output; pin the translator before imports run.
setLocaleTranslator(zhT)

afterEach(() => document.body.replaceChildren())

describe('mobile sidebar navigation', () => {
  it('preserves the current reading position when dismissed without restoring it across a session open', () => {
    document.body.innerHTML = `
      <button id="sidebar-backdrop"></button>
      <aside class="sidebar"><button id="sidebar-close"></button></aside>
      <main><button id="sidebar-toggle"></button><section id="transcript"></section></main>
    `
    const narrow = { matches: true, addEventListener: vi.fn() } as unknown as MediaQueryList
    const sidebar = bindSidebar(narrow)
    const transcript = document.getElementById('transcript') as HTMLElement
    const toggle = document.getElementById('sidebar-toggle') as HTMLButtonElement
    const close = document.getElementById('sidebar-close') as HTMLButtonElement
    const focus = vi.spyOn(toggle, 'focus')

    transcript.scrollTop = 653.5
    toggle.click()
    transcript.scrollTop = 869
    close.click()

    expect(transcript.scrollTop).toBe(653.5)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(document.activeElement).toBe(toggle)

    toggle.click()
    transcript.scrollTop = 0
    sidebar.close()
    expect(transcript.scrollTop).toBe(0)

    // A closed drawer has nothing to dismiss, so it must not pull focus to its toggle.
    focus.mockClear()
    sidebar.dismiss()
    expect(focus).not.toHaveBeenCalled()
  })
})
