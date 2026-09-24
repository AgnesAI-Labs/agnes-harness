/** @vitest-environment happy-dom */

import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { TOPBAR_SLOT } from '../src/region-slots.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

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
    expect(topbar?.querySelector('#task-title')?.textContent).toBe('新会话')
    expect(topbar?.querySelector('#status')?.textContent).toBe('准备任务')
    expect(topbar?.querySelector('#connection')?.textContent).toBe('正在连接后台')
    expect(topbar?.querySelector('#disconnect')).toBeInstanceOf(HTMLButtonElement)

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
    expect(topbar?.querySelector('#connection')?.textContent).toBe('本地后台已连接')
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
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(topbar?.querySelector('#shadow-topbar')?.textContent).toBe('替换顶部栏')
    expect(topbar?.querySelector('#task-title')).toBeNull()
    expect(document.querySelector('[data-slot="ui:conversation"] #transcript')).toBeTruthy()
    expect(document.querySelector('[data-slot="ui:composer"] #prompt')).toBeTruthy()

    remove()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(topbar?.querySelector('[data-agnes-region-unit="topbar"] #task-title')).toBeTruthy()
    expect(topbar?.querySelector('#sidebar-toggle')).toBeTruthy()
  })
})
