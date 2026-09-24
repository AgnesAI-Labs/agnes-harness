// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSidebar, showSettingsPane } from '../src/shell.js'

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
  })
})

describe('settings navigation', () => {
  it('keeps exactly the selected pane marked as the current page', () => {
    document.body.innerHTML = `
      <button id="model-settings"></button><button id="plugin-management"></button>
      <button id="skills-tab" aria-selected="true"></button><button id="mcp-tab" aria-selected="false"></button>
      <button id="archived-settings"></button><button id="computer-use-management"></button><button id="appearance-settings"></button>
      <section id="model-settings-pane"></section><section id="plugin-settings-pane"></section><section id="resource-settings-pane"></section><section id="archived-settings-pane"></section><section id="computer-use-settings-pane"></section><section id="appearance-settings-pane"></section>
    `
    const model = document.getElementById('model-settings') as HTMLButtonElement
    const skills = document.getElementById('skills-tab') as HTMLButtonElement
    const mcp = document.getElementById('mcp-tab') as HTMLButtonElement
    const computerUse = document.getElementById('computer-use-management') as HTMLButtonElement
    const appearance = document.getElementById('appearance-settings') as HTMLButtonElement

    // 技能 / MCP 是同属一个面板的两条 Tab：只有当前那一类（aria-selected=true）算当前页，
    // 否则进面板时两条 Tab 会同时高亮。
    showSettingsPane('resources')
    expect(skills.getAttribute('aria-current')).toBe('page')
    expect(mcp.hasAttribute('aria-current')).toBe(false)

    showSettingsPane('model')
    expect(model.getAttribute('aria-current')).toBe('page')
    expect(skills.hasAttribute('aria-current')).toBe(false)
    expect(mcp.hasAttribute('aria-current')).toBe(false)

    showSettingsPane('computer-use')
    expect(computerUse.getAttribute('aria-current')).toBe('page')
    expect(model.hasAttribute('aria-current')).toBe(false)

    showSettingsPane('appearance')
    expect(appearance.getAttribute('aria-current')).toBe('page')
    expect(computerUse.hasAttribute('aria-current')).toBe(false)
  })
})
