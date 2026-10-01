/** @vitest-environment happy-dom */

import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TOPBAR_SLOT } from '../src/region-slots.js'
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
  })

  it('renders the topbar controls and updates them through its public handle', async () => {
    runtime = await mountRenderedIndex()
    const topbar = document.querySelector('header.topbar')
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
  })

  it('shadows only topbar and restores the built-in component after unload', async () => {
    runtime = await mountRenderedIndex()
    const topbar = document.querySelector('header.topbar')
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
