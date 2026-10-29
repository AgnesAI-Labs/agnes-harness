/** @vitest-environment happy-dom */
import { ConfigProvider } from 'antd'
import { createContext, type ReactNode, useContext } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { createRegionRenderer, mountApplication, unmountApplication } from '../src/antd-root.js'

const PageContext = createContext('outside')
afterEach(() => {
  unmountApplication(document)
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
})

it('shares the page context, locale and popup policy with replaceable controller regions', async () => {
  const mount = document.createElement('div')
  document.body.append(mount)
  function Shell({ children }: { children?: ReactNode }) {
    return (
      <PageContext.Provider value="inside">
        <div id="popup" />
        <div id="first" />
        <div id="second" />
        {children}
      </PageContext.Provider>
    )
  }
  const dispose = mountApplication(mount, <Shell />)
  const firstHost = document.getElementById('first') as HTMLElement
  const secondHost = document.getElementById('second') as HTMLElement
  function Region() {
    const config = useContext(ConfigProvider.ConfigContext)
    return (
      <p>
        {useContext(PageContext)} / {config.locale?.locale}
      </p>
    )
  }
  const first = createRegionRenderer(firstHost)
  const second = createRegionRenderer(secondHost)
  flushSync(() => {
    first.render(<Region />)
    second.render(<Region />)
  })
  expect(firstHost.textContent).toBe('inside / en')
  expect(secondHost.textContent).toBe('inside / en')
  document.documentElement.lang = 'zh-CN'
  await vi.waitFor(() => expect(firstHost.textContent).toBe('inside / zh-cn'))
  expect(secondHost.textContent).toBe('inside / zh-cn')
  first.unmount()
  expect(firstHost.textContent).toBe('')
  expect(secondHost.textContent).toBe('inside / zh-cn')
  const replacement = createRegionRenderer(firstHost)
  flushSync(() => replacement.render(<Region />))
  first.unmount()
  expect(firstHost.textContent).toBe('inside / zh-cn')
  expect(() => mountApplication(mount, <Shell />)).toThrow('already mounted')
  dispose()
  expect(mount.textContent).toBe('')
})

it('isolates a rendering failure, translates its retry, records diagnostics and recovers locally', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const mount = document.createElement('div')
  document.body.append(mount)
  let shellRenders = 0
  function Shell({ children }: { children?: ReactNode }) {
    shellRenders++
    return (
      <>
        <div id="conversation" />
        <div id="sidebar" />
        {children}
      </>
    )
  }
  mountApplication(mount, <Shell />)
  const failedHost = document.getElementById('conversation') as HTMLElement
  const safeHost = document.getElementById('sidebar') as HTMLElement
  const failed = createRegionRenderer(failedHost)
  const safe = createRegionRenderer(safeHost)
  let shouldFail = true
  function Conversation() {
    if (shouldFail) throw new Error('synthetic region failure')
    return <p>conversation recovered</p>
  }
  flushSync(() => {
    safe.render(<p>sidebar still works</p>)
    failed.render(<Conversation />)
  })
  expect(safeHost.textContent).toBe('sidebar still works')
  expect(failedHost.querySelector('[role="alert"]')?.textContent).toContain('This region failed')
  expect(
    log.mock.calls.some(
      ([message, region]) => message === 'Agnes region render failed' && region === 'conversation',
    ),
  ).toBe(true)
  document.documentElement.lang = 'zh-CN'
  await vi.waitFor(() => expect(failedHost.textContent).toContain('该区域出错'))
  expect(failedHost.querySelector('button')?.textContent).toBe('重试')
  shouldFail = false
  flushSync(() => failedHost.querySelector<HTMLButtonElement>('button')?.click())
  expect(failedHost.textContent).toBe('conversation recovered')
  const before = shellRenders
  for (let update = 0; update < 5; update++) flushSync(() => failed.render(<p>local progress {update}</p>))
  expect(shellRenders).toBe(before)
  expect(safeHost.textContent).toBe('sidebar still works')
  log.mockRestore()
})

it('batches high-frequency controller content locally without notifying the application roster', () => {
  const root = document.createElement('div')
  document.body.append(root)
  let shellRenders = 0
  let frame: FrameRequestCallback | undefined
  function Shell({ children }: { children?: ReactNode }) {
    shellRenders++
    return (
      <>
        <div id="progress-region" />
        {children}
      </>
    )
  }
  mountApplication(root, <Shell />)
  const host = document.getElementById('progress-region') as HTMLElement
  const renderer = createRegionRenderer(host, {
    notify: 'animation-frame',
    requestFrame(callback) {
      frame = callback
      return 1
    },
    cancelFrame() {},
  })
  flushSync(() => renderer.flush())
  const before = shellRenders
  for (let progress = 0; progress <= 100; progress++) renderer.render(<p>{progress}</p>)
  expect(host.textContent).toBe('')
  renderer.flush()
  expect(host.textContent).toBe('100')
  expect(shellRenders).toBe(before)
  frame?.(0)
  expect(host.textContent).toBe('100')
})
