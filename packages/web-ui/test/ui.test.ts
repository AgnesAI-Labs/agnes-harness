/** @vitest-environment happy-dom */
import { createElement, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type UiModule = {
  Button: (props: { children?: ReactElement | string; type?: string }) => ReactElement
  Field: (props: { label: string; children: ReactElement }) => ReactElement
  Tooltip: (props: { title: string; children?: ReactElement }) => ReactElement
  mountRegion(host: HTMLElement, element: ReactElement): () => void
  unmountRegion(host: HTMLElement): void
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('web-ui public component layer', () => {
  it('passes the document CSP nonce to Ant Design runtime styles', async () => {
    const ui = (await import('../src/index.js')) as unknown as UiModule
    const host = document.createElement('div')
    const meta = document.createElement('meta')
    meta.name = 'agnes-csp-nonce'
    meta.content = 'test-document-nonce'
    document.head.append(meta)
    document.body.append(host)

    const dispose = ui.mountRegion(host, createElement(ui.Button, null, 'Continue'))

    const styles = [...document.head.querySelectorAll<HTMLStyleElement>('style[data-css-hash]')]
    expect(styles.length).toBeGreaterThan(0)
    expect(styles.every((style) => style.nonce === meta.content)).toBe(true)
    dispose()
    meta.remove()
  })

  it('mounts and unmounts a React region through its lifecycle contract', async () => {
    const ui = (await import('../src/index.js')) as unknown as UiModule
    const host = document.createElement('div')
    document.body.append(host)

    const dispose = ui.mountRegion(host, createElement('span', { 'data-testid': 'content' }, 'ready'))

    expect(host.querySelector('[data-testid="content"]')?.textContent).toBe('ready')
    dispose()
    expect(host.childElementCount).toBe(0)
    ui.unmountRegion(host)
  })

  it('exports host primitives without exposing antd to consumers', async () => {
    const ui = (await import('../src/index.js')) as unknown as UiModule

    expect(ui.Button).toBeTypeOf('function')
    expect(ui.Field).toBeTypeOf('function')
  })

  it('opens the tooltip through the region root and marks its popup with the base class', async () => {
    const ui = (await import('../src/index.js')) as unknown as UiModule
    const host = document.createElement('div')
    document.body.append(host)

    const dispose = ui.mountRegion(
      host,
      createElement(
        ui.Tooltip,
        { title: '可上传各类文件' },
        createElement('button', { type: 'button' }, '附件'),
      ),
    )
    const trigger = host.querySelector('button') as HTMLButtonElement

    // React 的 onMouseEnter 由 mouseover 合成，直接派发 mouseenter 不会触发浮层。
    trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('.agnes-ui-tooltip')?.textContent).toContain('可上传各类文件'),
    )
    // 基础类只加在弹层上；触发器最多被打上 antd 自己的 ant-tooltip-open，不该多出包装节点，
    // 否则调用方的 flex/子代选择器会跟着失效。
    expect(trigger.className).not.toContain('agnes-ui-tooltip')
    expect(host.firstElementChild).toBe(trigger)
    dispose()
  })
})
