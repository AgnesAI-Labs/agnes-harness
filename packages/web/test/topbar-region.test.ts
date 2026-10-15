/** @vitest-environment happy-dom */

import { resolve } from 'node:path'
import { act, createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
import { TOPBAR_SLOT } from '../src/region-slots.js'
import { sessionViewCommands } from '../src/regions/session-views.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

// A slot change commits in a few milliseconds, but a loaded runner has taken longer than the fixed
// 20 ms these checks used to sleep. Wait for the rendered state instead.
const committed = { timeout: 5_000 }

describe('rendered topbar region', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
    delete sessionViewCommands.reportProblem
  })

  it('edits the selected title inline with explicit save/cancel, IME and session isolation', async () => {
    runtime = await mountRenderedIndex()
    const handle = runtime.topbar!
    handle.setSession('s')
    handle.setTaskTitle('Original')
    const save = vi.fn(async (title: string) => {
      handle.setTaskTitle(title)
    })
    const begin = () =>
      handle.editTitle({
        sessionId: 's',
        title: document.getElementById('task-title')?.textContent ?? '',
        save,
      })
    document.addEventListener('agnes:rename-current-session', begin)
    const input = () => document.querySelector<HTMLInputElement>('#task-title-input')!
    const click = (selector: string) =>
      act(async () => document.querySelector<HTMLButtonElement>(selector)?.click())
    const change = (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(), value)
        input().dispatchEvent(new Event('input', { bubbles: true }))
      })
    const key = (value: string, composing = false) =>
      act(async () =>
        input().dispatchEvent(
          new KeyboardEvent('keydown', {
            key: value,
            isComposing: composing,
            bubbles: true,
            cancelable: true,
          }),
        ),
      )
    try {
      await click('#task-title')
      expect(input().value).toBe('Original')
      expect(document.activeElement).toBe(input())
      expect(document.querySelector('.session-rename-dialog')).toBeNull()
      await click('[data-testid="task-title-save"]')
      expect(save).not.toHaveBeenCalled()
      await click('#task-title')
      await change('Discard')
      await key('Escape')
      expect(document.querySelector('#task-title-input')).toBeNull()
      expect(document.getElementById('task-title')?.textContent).toBe('Original')
      await click('#task-title')
      await change('Discard again')
      await click('[data-testid="task-title-cancel"]')
      expect(document.getElementById('task-title')?.textContent).toBe('Original')
      await click('#task-title')
      await act(async () =>
        document
          .querySelector('[data-testid="task-title-save"]')
          ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
      )
      expect(document.getElementById('task-title')?.textContent).toBe('Original')
      await click('#task-title')
      await change('  ')
      await key('Enter')
      expect(save).not.toHaveBeenCalled()
      expect(document.querySelector('.topbar-title-error')?.textContent).toContain('Enter a session name')
      await change('输入法')
      await act(async () =>
        input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })),
      )
      await key('Enter', true)
      expect(save).not.toHaveBeenCalled()
      await act(async () => input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
      // Blur itself neither saves nor cancels.
      input().blur()
      expect(input().value).toBe('输入法')
      expect(save).not.toHaveBeenCalled()
      await key('Enter')
      expect(save).toHaveBeenCalledWith('输入法')
      expect(document.getElementById('task-title')?.textContent).toBe('输入法')
      save.mockRejectedValueOnce(new Error('Synthetic save failed'))
      await click('#task-title')
      await change('Retry title')
      await click('[data-testid="task-title-save"]')
      expect(input().value).toBe('Retry title')
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Synthetic save failed')
      await click('[data-testid="task-title-save"]')
      expect(document.getElementById('task-title')?.textContent).toBe('Retry title')
      let complete: (() => void) | undefined
      save.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve
          }),
      )
      await click('#task-title')
      await change('Old session pending')
      await key('Enter')
      const submitted = save.mock.calls.length
      await key('Enter')
      expect(save.mock.calls.length).toBe(submitted)
      expect(document.querySelector<HTMLButtonElement>('[data-testid="task-title-save"]')?.disabled).toBe(
        true,
      )
      handle.setSession('next')
      handle.setTaskTitle('Other session')
      expect(document.querySelector('#task-title-input')).toBeNull()
      await act(async () => complete?.())
      expect(document.getElementById('task-title')?.textContent).toBe('Other session')
    } finally {
      document.removeEventListener('agnes:rename-current-session', begin)
    }
  })

  it('renders the topbar controls and updates them through its public handle', async () => {
    runtime = await mountRenderedIndex()
    const topbar = document.querySelector('header .topbar')
    const handle = runtime.topbar
    expect(handle).toBeDefined()
    expect(topbar?.querySelector('[data-slot="ui:topbar"]')).toBeTruthy()
    expect(topbar?.querySelector('#sidebar-toggle')).toBeInstanceOf(HTMLButtonElement)
    // No locale preference saved: the workbench defaults to English (assert the catalog default).
    expect(topbar?.querySelector('#task-title')?.textContent).toBe('New session')
    expect(topbar?.querySelector('#status')?.textContent).toBe('Ready')
    expect(topbar?.querySelector('#connection')?.textContent).toBe('Connecting to the backend')
    // 「断开连接」按钮已移除：主动断开没有恢复路径（SDK 的 isClosed 一旦置真就锁死，
    // 且不会启动自动重连），留一个点了只能靠重启后台恢复的按钮是净损失。掉线仍由
    // 自动重连和 #reconnect-notice 里的「重试连接」处理。
    expect(topbar?.querySelector('#disconnect')).toBeNull()

    const toggle = topbar?.querySelector<HTMLButtonElement>('#sidebar-toggle')
    toggle?.click()
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(true)
    toggle?.click()
    expect(document.body.classList.contains('sidebar-collapsed')).toBe(false)

    handle?.setTaskTitle('测试任务')
    handle?.setStatus('执行中', 'running')
    handle?.setConnectionState('connected')
    expect(topbar?.querySelector('#task-title')?.textContent).toBe('测试任务')
    expect(topbar?.querySelector('#status')?.textContent).toBe('执行中')
    expect(topbar?.querySelector('#status')?.getAttribute('data-state')).toBe('running')
    expect(topbar?.querySelector('#connection')?.textContent).toBe('Local backend connected')
    expect(topbar?.querySelector('#connection')?.getAttribute('data-state')).toBe('connected')

    // The full title stays reachable when the bar truncates it.
    expect(topbar?.querySelector('#task-title')?.getAttribute('title')).toContain('测试任务')

    // Agent and runtime information appear only for a selected session.
    expect(topbar?.querySelector('[data-testid="topbar-agent"]')).toBeNull()
    expect(topbar?.querySelector('#session-runtime')).toBeNull()
    handle?.setAgent('Research Agent')
    handle?.setRuntimeAvailable(true)
    expect(topbar?.querySelector('[data-testid="topbar-agent"]')?.textContent).toBe('Research Agent')
    let runtimeRequests = 0
    const onRuntime = () => runtimeRequests++
    document.addEventListener('agnes:runtime-current-session', onRuntime)
    topbar?.querySelector<HTMLButtonElement>('#session-runtime')?.click()
    document.removeEventListener('agnes:runtime-current-session', onRuntime)
    expect(runtimeRequests).toBe(1)
    handle?.setAgent(undefined)
    handle?.setRuntimeAvailable(false)
    expect(topbar?.querySelector('[data-testid="topbar-agent"]')).toBeNull()
    expect(topbar?.querySelector('#session-runtime')).toBeNull()

    const chat = document.getElementById('view-chat') as HTMLButtonElement
    const trace = document.getElementById('view-trace') as HTMLButtonElement
    expect(chat.getAttribute('aria-controls')).toBe('conversation-shell')
    expect(trace.getAttribute('aria-controls')).toBe('trace-panel')
    trace.click()
    expect(runtime.trace?.isOpen()).toBe(true)
    expect(trace.getAttribute('aria-selected')).toBe('true')
    document.documentElement.lang = 'zh-CN'
    window.dispatchEvent(new Event('agnes:locale-changed'))
    await vi.waitFor(() => expect(trace.textContent).toBe('轨迹'))
    expect(document.getElementById('view-trace')).toBe(trace)
    expect(trace.getAttribute('aria-selected')).toBe('true')
    expect(chat.getAttribute('aria-selected')).toBe('false')
    expect(document.getElementById('report-problem')?.getAttribute('aria-label')).toBe('报告问题')
    chat.click()
    expect(runtime.trace?.isOpen()).toBe(false)

    // Arrow, Home and End move both focus and the selected view.
    const press = (tab: HTMLElement, key: string) =>
      tab.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    press(chat, 'ArrowRight')
    expect(runtime.trace?.isOpen()).toBe(true)
    expect(document.activeElement).toBe(trace)
    press(trace, 'End')
    expect(runtime.trace?.isOpen()).toBe(true)
    press(trace, 'Home')
    expect(runtime.trace?.isOpen()).toBe(false)
    expect(document.activeElement).toBe(chat)
  })

  it('offers the secondary actions from one menu that presses their own buttons', async () => {
    runtime = await mountRenderedIndex()
    const more = document.getElementById('topbar-more') as HTMLButtonElement
    expect(more.getAttribute('aria-label')).toBe('More actions')
    expect(more.closest('.topbar-actions')).not.toBeNull()
    expect(more.closest('[role="tablist"]')).toBeNull()
    const pressed = vi.fn()
    const report = document.getElementById('report-problem') as HTMLButtonElement
    report.style.display = 'none'
    const priorReport = sessionViewCommands.reportProblem
    const opened = vi.fn()
    sessionViewCommands.reportProblem = opened
    report.addEventListener('click', pressed)

    more.click()
    const entries = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      expect(found.map((entry) => entry.textContent)).toEqual(['Report a problem'])
      return found
    }, committed)
    entries[0]?.click()
    expect(pressed).toHaveBeenCalledTimes(1)
    expect(opened).toHaveBeenCalledWith(more)
    if (priorReport) sessionViewCommands.reportProblem = priorReport
    else delete sessionViewCommands.reportProblem

    // Runtime info joins the menu once a session offers it.
    runtime.topbar?.setRuntimeAvailable(true)
    more.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    more.click()
    await vi.waitFor(
      () =>
        expect([...document.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent)).toEqual(
          ['Runtime info', 'Report a problem'],
        ),
      committed,
    )

    // A session that can hold a goal adds it, labelled with the goal's state; it presses the goal's own toggle.
    const goalHost = document.getElementById('session-goal-host') as HTMLElement
    const goal = document.createElement('button')
    goal.dataset.testid = 'goal-toggle'
    goal.textContent = 'Create goal'
    const goalPressed = vi.fn()
    goal.addEventListener('click', goalPressed)
    goalHost.append(goal)
    more.click()
    more.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    more.click()
    const goalEntry = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-testid="topbar-more-goal"]')
      expect(found?.textContent).toBe('Create goal')
      return found
    }, committed)
    expect([...document.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent)).toEqual([
      'Runtime info',
      'Create goal',
      'Report a problem',
    ])
    goalEntry?.click()
    expect(goalPressed).toHaveBeenCalledTimes(1)
    goal.remove()

    // The workspace is named in the sidebar; the bar only offers to copy its path, first in the menu.
    expect(document.querySelector('[data-testid="topbar-workspace"]')).toBeNull()
    const copy = document.createElement('button')
    copy.id = 'workspace-copy-path'
    copy.hidden = true
    copy.setAttribute('aria-label', 'Copy workspace path')
    const copyPressed = vi.fn()
    copy.addEventListener('click', copyPressed)
    document.body.append(copy)
    more.click()
    more.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    more.click()
    const copyEntry = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-testid="topbar-more-workspace"]')
      expect(found?.textContent).toBe('Copy workspace path')
      return found
    }, committed)
    expect([...document.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent)).toEqual([
      'Copy workspace path',
      'Runtime info',
      'Report a problem',
    ])
    copyEntry?.click()
    expect(copyPressed).toHaveBeenCalledTimes(1)
    copy.remove()
  })

  it('collapses by the width of the bar: the Agent chip gives way to the title', () => {
    const css = readWebStyleSource(resolve(__dirname, '../public/style.css'))
    expect(css).toMatch(/\.topbar-row \{[^}]*container: topbar-row \/ inline-size/)
    const start = css.indexOf('@container topbar-row (max-width: 55rem) {')
    expect(start).toBeGreaterThan(-1)
    const narrow = css.slice(start, css.indexOf('\n  }\n', start))
    expect(narrow).toContain('.topbar-agent')
    // The view switch and action group always stay.
    expect(narrow).not.toMatch(/#view-chat|\.session-tabs\b|workbench-right-toggle|topbar-more/)
    // The workspace is named in the sidebar, not in the bar.
    expect(css).not.toContain('.topbar-workspace')
    // The workbench label shows only on wide windows.
    expect(css).toMatch(
      /@media \(max-width: 1439px\) \{\s*\.topbar-row \.workbench-toggle-label \{\s*display: none;/,
    )
  })

  it('shadows only topbar and restores the built-in component after unload', async () => {
    runtime = await mountRenderedIndex()
    const topbar = document.querySelector('header .topbar')
    const remove = runtime.registry.register(
      {
        name: TOPBAR_SLOT as string,
        id: 'fixture-topbar-shadow',
        owner: 'fixture',
        priority: -1,
      },
      () => createElement('div', { id: 'shadow-topbar' }, '替换顶部栏'),
    )
    await vi.waitFor(() => {
      expect(topbar?.querySelector('#shadow-topbar')?.textContent).toBe('替换顶部栏')
      expect(topbar?.querySelector('#task-title')).toBeNull()
      expect(document.querySelector('[data-slot="ui:conversation"] #transcript')).toBeTruthy()
      expect(document.querySelector('[data-slot="ui:composer"] #prompt')).toBeTruthy()
    }, committed)

    remove()
    await vi.waitFor(() => {
      expect(topbar?.querySelector('[data-agnes-region-unit="topbar"] #task-title')).toBeTruthy()
      expect(topbar?.querySelector('#sidebar-toggle')).toBeTruthy()
    }, committed)
  })
})
